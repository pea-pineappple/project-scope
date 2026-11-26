/**
 * llm.ts — 요약 생성 엔진 (헤드리스 CLI · 로컬 서버)
 *
 *   claude-cli  claude -p --output-format json --json-schema … --tools "" --no-session-persistence
 *   codex-cli   codex exec --skip-git-repo-check --sandbox read-only --output-last-message <file> -
 *   gemini-cli  gemini --output-format json -p …            (프롬프트는 stdin)
 *   opencode    opencode run --format json <message>
 *   ollama      POST <url>/api/chat  {format: <schema>}
 * (VS Code 언어 모델 API 는 vscode 가 필요해 engines.ts 에 있다)
 *
 * - 인증은 사용자가 이미 로그인한 각 CLI 가 처리한다 — 확장은 키를 저장하지 않음
 * - 모든 CLI 는 임시 디렉터리에서 실행 → 프로젝트 파일·지침(CLAUDE.md 등)을 끌어오지 않음.
 *   입력은 stdin/인자로 넘긴 코드뿐. 응답은 JSON 하나 {"items":[{id, summary, params}]}
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export interface SummarizeItem {
  id: string;
  kind: "func" | "class";
  qual: string;
  lang: string;
  file: string;
  line: number;
  endLine: number;
  code: string;
}

export interface SummarizeResult {
  /** id → 요약·파라미터 */
  items: Map<string, { summary: string; params?: string[] }>;
  /** 실제 응답한 모델 */
  model?: string;
  costUsd?: number;
}

export type EngineId = "claude-cli" | "codex-cli" | "gemini-cli" | "opencode" | "vscode-lm" | "ollama";

export interface LlmOptions {
  /** CLI 실행 파일 (claude / codex / gemini / opencode) */
  command: string;
  /** 비우면 엔진 기본값 */
  model: string;
  /** 요약 언어 이름 (영어로, 예: "Korean") */
  language: string;
  timeoutMs: number;
  /** ollama 서버 주소 */
  url?: string;
  /** 취소 신호 — 호출되면 프로세스를 끈다 */
  onCancel?: (kill: () => void) => void;
}

export const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          summary: { type: "string" },
          params: { type: "array", items: { type: "string" } },
        },
        required: ["id", "summary"],
      },
    },
  },
  required: ["items"],
};

/** 요약 텍스트의 언어 — 한글 → ko, 가나 → ja, 한자만 → zh-cn/zh-tw (간체·번체 전용 글자 비교), 그 외 → en */
export function detectLanguage(text: string): "ko" | "ja" | "zh-cn" | "zh-tw" | "en" {
  if (/[\uac00-\ud7a3]/.test(text)) {
    return "ko";
  }
  if (/[\u3040-\u30ff]/.test(text)) {
    return "ja";
  }
  if (/[\u4e00-\u9fff]/.test(text)) {
    const simp = (text.match(/[这个为数们说时来对从发会实现应过还没开关进动样经题门问间]/g) ?? []).length;
    const trad = (text.match(/[這個為數們說時來對從發會實現應過還沒開關進動樣經題門問間]/g) ?? []).length;
    return trad > simp ? "zh-tw" : "zh-cn";
  }
  return "en";
}

/** 요약 언어 설정 값 → 프롬프트에 쓸 언어 이름 */
export function languageName(setting: string, uiLanguage: string): string {
  const names: Record<string, string> = {
    en: "English",
    ko: "Korean",
    ja: "Japanese",
    "zh-cn": "Simplified Chinese",
    "zh-tw": "Traditional Chinese",
  };
  if (setting === "auto") {
    return "the same language as the code comments (English if there are none)";
  }
  if (setting === "ui" || setting === "ask" || !setting) {
    const ui = uiLanguage.toLowerCase();
    return names[ui] ?? names[ui.split("-")[0]] ?? "English";
  }
  return names[setting] ?? setting;
}

export function buildPrompt(items: SummarizeItem[], language: string, jsonOnly = false): string {
  const head = [
    `Read each item below (a function or a class) and summarize it.`,
    `- summary: what it does in 1-3 sentences, written in ${language}. Focus on inputs, outputs, side effects and the main call flow. Do not copy the code.`,
    `- For a class, summarize its role and main responsibilities (do not list methods).`,
    `- params: parameter names only, in order (exclude self/cls/this; empty array for a class).`,
    `- Return every id exactly as given. Answer every item.`,
  ];
  if (jsonOnly) {
    head.push(
      `- Reply with ONE JSON object and nothing else, no code fence: {"items":[{"id":"0","summary":"...","params":["a"]}]}`,
      `- Do not use any tools and do not read or write files.`
    );
  }
  head.push("");
  const body = items.map(
    (it) =>
      `### id=${it.id} · ${it.kind} · ${it.lang} · ${it.file}:${it.line}-${it.endLine} · ${it.qual}\n` +
      "```\n" +
      it.code +
      "\n```"
  );
  return head.join("\n") + body.join("\n\n") + "\n";
}

/** 엔진별 요약 — 실패하면 throw (메시지는 사용자에게 그대로 보일 수 있게) */
export function summarizeCli(engine: EngineId, items: SummarizeItem[], opt: LlmOptions): Promise<SummarizeResult> {
  switch (engine) {
    case "claude-cli":
      return claude(items, opt);
    case "codex-cli":
      return codex(items, opt);
    case "gemini-cli":
      return gemini(items, opt);
    case "opencode":
      return opencode(items, opt);
    case "ollama":
      return ollama(items, opt);
    default:
      return Promise.reject(new Error(vscode.l10n.t("Unknown analysis engine: {0}", engine)));
  }
}

// --- Claude Code -------------------------------------------------------------------

async function claude(items: SummarizeItem[], opt: LlmOptions): Promise<SummarizeResult> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(SCHEMA),
    "--tools",
    "",
    "--no-session-persistence",
    "--system-prompt",
    "You are a code summarizer. Do not use tools. Answer only with the requested JSON, based only on the given code.",
  ];
  if (opt.model) {
    args.push("--model", opt.model);
  }
  const r = await run(opt.command, args, buildPrompt(items, opt.language), opt);
  const o = parseJson(r.stdout) as {
    is_error?: boolean;
    result?: string;
    structured_output?: unknown;
    modelUsage?: Record<string, unknown>;
    total_cost_usd?: number;
  };
  if (o.is_error) {
    throw new Error(o.result || vscode.l10n.t("Error response"));
  }
  const res = toResult(o.structured_output ?? extractJson(o.result ?? ""));
  res.model = Object.keys(o.modelUsage ?? {})[0] ?? (opt.model || undefined);
  res.costUsd = o.total_cost_usd;
  return res;
}

// --- OpenAI Codex CLI --------------------------------------------------------------

async function codex(items: SummarizeItem[], opt: LlmOptions): Promise<SummarizeResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-codex-"));
  const out = path.join(dir, "last.txt");
  try {
    const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "--output-last-message", out];
    if (opt.model) {
      args.push("-m", opt.model);
    }
    args.push("-");
    const r = await run(opt.command, args, buildPrompt(items, opt.language, true), { ...opt }, dir);
    const text = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : r.stdout;
    const res = toResult(extractJson(text));
    res.model = opt.model || "codex";
    return res;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- Gemini CLI --------------------------------------------------------------------

async function gemini(items: SummarizeItem[], opt: LlmOptions): Promise<SummarizeResult> {
  const args = ["--output-format", "json", "-p", "Follow the instructions in the input above and reply with the JSON only."];
  if (opt.model) {
    args.push("-m", opt.model);
  }
  const r = await run(opt.command, args, buildPrompt(items, opt.language, true), opt);
  let text = r.stdout;
  try {
    const o = parseJson(r.stdout) as { response?: string; error?: { message?: string } };
    if (o.error?.message) {
      throw new Error(o.error.message);
    }
    text = o.response ?? text;
  } catch (e) {
    if (!(e instanceof SyntaxError)) {
      throw e;
    }
  }
  const res = toResult(extractJson(text));
  res.model = opt.model || "gemini";
  return res;
}

// --- OpenCode ----------------------------------------------------------------------

async function opencode(items: SummarizeItem[], opt: LlmOptions): Promise<SummarizeResult> {
  const args = ["run", "--format", "json"];
  if (opt.model) {
    args.push("-m", opt.model);
  }
  args.push(buildPrompt(items, opt.language, true));
  const r = await run(opt.command, args, undefined, opt);
  // --format json = 이벤트 JSON 줄들 — 텍스트 조각을 모아 JSON 을 찾는다
  let text = "";
  for (const line of r.stdout.split("\n")) {
    try {
      const ev = JSON.parse(line) as { part?: { text?: string; type?: string }; text?: string };
      text += ev.part?.text ?? ev.text ?? "";
    } catch {
      // 이벤트가 아닌 줄
    }
  }
  const res = toResult(extractJson(text || r.stdout));
  res.model = opt.model || "opencode";
  return res;
}

// --- Ollama (로컬 서버) -------------------------------------------------------------

async function ollama(items: SummarizeItem[], opt: LlmOptions): Promise<SummarizeResult> {
  const url = (opt.url || "http://127.0.0.1:11434").replace(/\/+$/, "");
  if (!opt.model) {
    throw new Error(vscode.l10n.t("Choose an Ollama model first"));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opt.timeoutMs);
  opt.onCancel?.(() => ctrl.abort());
  try {
    const resp = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opt.model,
        stream: false,
        format: SCHEMA,
        messages: [{ role: "user", content: buildPrompt(items, opt.language, true) }],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      throw new Error(`Ollama ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const o = (await resp.json()) as { message?: { content?: string } };
    const res = toResult(extractJson(o.message?.content ?? ""));
    res.model = opt.model;
    return res;
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(vscode.l10n.t("Cancelled or timed out"));
    }
    if ((e as Error).message === "fetch failed") {
      throw new Error(vscode.l10n.t("Server not running at {0}", url));
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// --- 공용 --------------------------------------------------------------------------

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 프로세스 실행 — 실패(코드≠0)면 throw. stdin 이 있으면 넘긴다 */
export function run(
  command: string,
  args: string[],
  input: string | undefined,
  opt: Pick<LlmOptions, "timeoutMs" | "onCancel">,
  cwd = os.tmpdir(),
  allowFail = false
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      reject(new Error(vscode.l10n.t("Failed to start {0}: {1}", command, (e as Error).message)));
      return;
    }
    let out = "";
    let err = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        fn();
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(vscode.l10n.t("{0} timed out ({1}s)", command, Math.round(opt.timeoutMs / 1000)))));
    }, opt.timeoutMs);
    opt.onCancel?.(() => {
      child.kill();
      finish(() => reject(new Error(vscode.l10n.t("Cancelled"))));
    });
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          new Error(
            e.code === "ENOENT"
              ? vscode.l10n.t("{0} not found — install it, sign in, or set its path in the settings", command)
              : vscode.l10n.t("{0} error: {1}", command, e.message)
          )
        )
      )
    );
    child.on("close", (code) =>
      finish(() => {
        if (code !== 0 && !allowFail) {
          const tail = (err || out).trim().split("\n").slice(-3).join(" ").slice(0, 300);
          reject(new Error(vscode.l10n.t("{0} failed (exit code {1}){2}", command, String(code), tail ? ` — ${tail}` : "")));
        } else {
          resolve({ code, stdout: out, stderr: err });
        }
      })
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "", "utf8");
  });
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** 응답 텍스트에서 첫 JSON 객체 (코드 펜스·앞뒤 말 허용) */
export function extractJson(text: string): unknown {
  const t = text.replace(/```(?:json)?/g, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(vscode.l10n.t("No summary JSON in the response"));
  }
  return JSON.parse(t.slice(start, end + 1));
}

/** {"items":[…]} → 결과 맵 */
export function toResult(o: unknown): SummarizeResult {
  const list = (o as { items?: { id: string; summary: string; params?: string[] }[] } | undefined)?.items;
  if (!Array.isArray(list)) {
    throw new Error(vscode.l10n.t("No summary JSON in the response"));
  }
  const items = new Map<string, { summary: string; params?: string[] }>();
  for (const it of list) {
    if (it && typeof it.id === "string" && typeof it.summary === "string" && it.summary.trim()) {
      items.set(it.id, {
        summary: it.summary.trim(),
        params: Array.isArray(it.params) ? it.params.filter((p) => typeof p === "string") : undefined,
      });
    }
  }
  return { items };
}
