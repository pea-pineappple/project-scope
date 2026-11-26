/**
 * engines.ts — 분석 엔진 감지 · 선택 · 호출
 *
 * 엔진 = 이미 로그인된 AI 에이전트 CLI, VS Code 언어 모델 API(Copilot 등), 로컬 Ollama.
 * 감지: 설치 여부(--version) · 로그인 상태 · 고를 수 있는 모델.
 *   claude    claude auth status --json → loggedIn, email · 모델 별칭(fable/opus/sonnet/haiku)
 *   codex     codex login status (종료 코드 0 = 로그인) · ~/.codex/config.toml 의 model
 *   gemini    ~/.gemini/oauth_creds.json 또는 GEMINI_API_KEY/GOOGLE_API_KEY · settings.json 의 model
 *   opencode  opencode auth list · opencode models
 *   vscode-lm vscode.lm.selectChatModels() — 연결된 채팅 모델 목록 그대로
 *   ollama    GET <url>/api/tags — 서버가 떠 있으면 설치된 모델 목록
 * 키나 토큰은 읽지 않는다 — 파일은 존재 여부와 모델 이름만 본다.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildPrompt,
  extractJson,
  run,
  summarizeCli,
  toResult,
  type EngineId,
  type LlmOptions,
  type SummarizeItem,
  type SummarizeResult,
} from "./llm";

export const ENGINE_IDS: EngineId[] = ["claude-cli", "codex-cli", "gemini-cli", "opencode", "vscode-lm", "ollama"];

export interface ModelChoice {
  id: string;
  label: string;
  detail?: string;
}

export interface EngineStatus {
  id: EngineId;
  name: string;
  installed: boolean;
  /** undefined = 확인 불가 */
  loggedIn?: boolean;
  account?: string;
  /** 상태 한 줄 (버전, 플랜 등) */
  detail?: string;
  /** 터미널에서 로그인할 명령 */
  loginCommand?: string;
  /** 설치 안내 명령 */
  installHint?: string;
  models: ModelChoice[];
  /** 엔진 쪽 기본 모델 (설정 파일에서 읽음) */
  defaultModel?: string;
  /** 모델 이름을 직접 입력할 수 있는지 */
  customModel: boolean;
  /** 파일·서버로 코드가 가는 곳 (사용자 안내) */
  sendsTo: string;
}

export interface EngineSettings {
  claudePath: string;
  codexPath: string;
  geminiPath: string;
  opencodePath: string;
  ollamaUrl: string;
}

export function engineSettings(cfg: vscode.WorkspaceConfiguration): EngineSettings {
  return {
    claudePath: cfg.get<string>("claudePath", "claude") || "claude",
    codexPath: cfg.get<string>("codexPath", "codex") || "codex",
    geminiPath: cfg.get<string>("geminiPath", "gemini") || "gemini",
    opencodePath: cfg.get<string>("opencodePath", "opencode") || "opencode",
    ollamaUrl: cfg.get<string>("ollamaUrl", "http://127.0.0.1:11434") || "http://127.0.0.1:11434",
  };
}

export function engineName(id: string): string {
  switch (id) {
    case "claude-cli":
      return "Claude Code";
    case "codex-cli":
      return "OpenAI Codex CLI";
    case "gemini-cli":
      return "Gemini CLI";
    case "opencode":
      return "OpenCode";
    case "vscode-lm":
      return vscode.l10n.t("VS Code language models (Copilot etc.)");
    case "ollama":
      return vscode.l10n.t("Ollama (local)");
    default:
      return id;
  }
}

const quick = { timeoutMs: 15_000 };

/** 모든 엔진 상태를 병렬로 */
export async function detectEngines(s: EngineSettings): Promise<EngineStatus[]> {
  return Promise.all([detectClaude(s), detectCodex(s), detectGemini(s), detectOpencode(s), detectVscodeLm(), detectOllama(s)]);
}

async function version(cmd: string): Promise<string | undefined> {
  try {
    const r = await run(cmd, ["--version"], undefined, quick, os.tmpdir(), true);
    return r.code === 0 ? (r.stdout || r.stderr).trim().split("\n")[0] : undefined;
  } catch {
    return undefined;
  }
}

async function detectClaude(s: EngineSettings): Promise<EngineStatus> {
  const st: EngineStatus = {
    id: "claude-cli",
    name: engineName("claude-cli"),
    installed: false,
    loginCommand: `${s.claudePath} auth login`,
    installHint: "npm install -g @anthropic-ai/claude-code",
    models: [
      { id: "sonnet", label: "sonnet", detail: vscode.l10n.t("latest Sonnet — balanced") },
      { id: "haiku", label: "haiku", detail: vscode.l10n.t("latest Haiku — fastest, lowest cost") },
      { id: "opus", label: "opus", detail: vscode.l10n.t("latest Opus — most capable") },
      { id: "fable", label: "fable", detail: vscode.l10n.t("latest Fable") },
    ],
    customModel: true,
    sendsTo: "Anthropic",
  };
  const v = await version(s.claudePath);
  if (!v) {
    return st;
  }
  st.installed = true;
  st.detail = v;
  try {
    const r = await run(s.claudePath, ["auth", "status", "--json"], undefined, quick, os.tmpdir(), true);
    const o = JSON.parse(r.stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string; apiProvider?: string };
    st.loggedIn = !!o.loggedIn;
    st.account = o.email;
    if (o.subscriptionType) {
      st.detail = `${v} · ${o.subscriptionType}`;
    }
    if (o.apiProvider && o.apiProvider !== "firstParty") {
      st.sendsTo = o.apiProvider;
    }
  } catch {
    st.loggedIn = undefined;
  }
  st.defaultModel = readJson(path.join(os.homedir(), ".claude", "settings.json"))?.model as string | undefined;
  return st;
}

async function detectCodex(s: EngineSettings): Promise<EngineStatus> {
  const st: EngineStatus = {
    id: "codex-cli",
    name: engineName("codex-cli"),
    installed: false,
    loginCommand: `${s.codexPath} login`,
    installHint: "npm install -g @openai/codex",
    models: [],
    customModel: true,
    sendsTo: "OpenAI",
  };
  const v = await version(s.codexPath);
  if (!v) {
    return st;
  }
  st.installed = true;
  st.detail = v;
  try {
    const r = await run(s.codexPath, ["login", "status"], undefined, quick, os.tmpdir(), true);
    st.loggedIn = r.code === 0;
    st.account = (r.stdout || r.stderr).trim().split("\n")[0] || undefined;
  } catch {
    st.loggedIn = undefined;
  }
  try {
    const toml = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
    st.defaultModel = /^\s*model\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  } catch {
    // 설정 없음
  }
  if (st.defaultModel) {
    st.models.push({ id: st.defaultModel, label: st.defaultModel, detail: vscode.l10n.t("from config.toml") });
  }
  return st;
}

async function detectGemini(s: EngineSettings): Promise<EngineStatus> {
  const st: EngineStatus = {
    id: "gemini-cli",
    name: engineName("gemini-cli"),
    installed: false,
    loginCommand: s.geminiPath,
    installHint: "npm install -g @google/gemini-cli",
    models: [],
    customModel: true,
    sendsTo: "Google",
  };
  const v = await version(s.geminiPath);
  if (!v) {
    return st;
  }
  st.installed = true;
  st.detail = v;
  const dir = path.join(os.homedir(), ".gemini");
  const env = process.env;
  st.loggedIn =
    fs.existsSync(path.join(dir, "oauth_creds.json")) ||
    !!env.GEMINI_API_KEY ||
    !!env.GOOGLE_API_KEY ||
    !!env.GOOGLE_GENAI_USE_VERTEXAI;
  const settings = readJson(path.join(dir, "settings.json"));
  const model = (settings?.model as { name?: string } | undefined)?.name ?? (settings?.model as string | undefined);
  if (typeof model === "string" && model) {
    st.defaultModel = model;
    st.models.push({ id: model, label: model, detail: vscode.l10n.t("from settings.json") });
  }
  return st;
}

async function detectOpencode(s: EngineSettings): Promise<EngineStatus> {
  const st: EngineStatus = {
    id: "opencode",
    name: engineName("opencode"),
    installed: false,
    loginCommand: `${s.opencodePath} auth login`,
    installHint: "curl -fsSL https://opencode.ai/install | bash",
    models: [],
    customModel: true,
    sendsTo: vscode.l10n.t("the provider of the chosen model"),
  };
  const v = await version(s.opencodePath);
  if (!v) {
    return st;
  }
  st.installed = true;
  st.detail = v;
  try {
    const r = await run(s.opencodePath, ["auth", "list"], undefined, quick, os.tmpdir(), true);
    const text = stripAnsi(r.stdout + r.stderr);
    st.loggedIn = r.code === 0 && !/no authenticated/i.test(text);
  } catch {
    st.loggedIn = undefined;
  }
  try {
    const r = await run(s.opencodePath, ["models"], undefined, { timeoutMs: 30_000 }, os.tmpdir(), true);
    for (const line of stripAnsi(r.stdout).split("\n")) {
      const id = line.trim();
      if (/^[\w.-]+\/[\w.:@#/-]+$/.test(id)) {
        st.models.push({ id, label: id });
      }
    }
  } catch {
    // 목록 없음 — 직접 입력
  }
  // 모델이 하나라도 있으면 쓸 수 있는 공급자가 있는 것 (무료 내장 공급자 포함)
  if (st.models.length > 0) {
    st.loggedIn = true;
  }
  return st;
}

async function detectVscodeLm(): Promise<EngineStatus> {
  const st: EngineStatus = {
    id: "vscode-lm",
    name: engineName("vscode-lm"),
    installed: !!vscode.lm,
    models: [],
    customModel: false,
    sendsTo: vscode.l10n.t("the model's provider (e.g. GitHub Copilot)"),
  };
  if (!vscode.lm) {
    st.detail = vscode.l10n.t("Requires VS Code 1.90 or later");
    return st;
  }
  try {
    const models = await vscode.lm.selectChatModels({});
    for (const m of models) {
      st.models.push({ id: m.id, label: m.name, detail: `${m.vendor} · ${m.family}` });
    }
    st.loggedIn = models.length > 0;
    st.detail = models.length
      ? vscode.l10n.t("{0} models available", String(models.length))
      : vscode.l10n.t("No chat model — sign in to GitHub Copilot or another model provider");
  } catch (e) {
    st.loggedIn = false;
    st.detail = (e as Error).message;
  }
  return st;
}

async function detectOllama(s: EngineSettings): Promise<EngineStatus> {
  const st: EngineStatus = {
    id: "ollama",
    name: engineName("ollama"),
    installed: false,
    installHint: "https://ollama.com",
    models: [],
    customModel: true,
    sendsTo: vscode.l10n.t("nowhere — runs on this machine ({0})", s.ollamaUrl),
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(`${s.ollamaUrl.replace(/\/+$/, "")}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) {
      const o = (await r.json()) as { models?: { name: string; details?: { parameter_size?: string } }[] };
      st.installed = true;
      st.loggedIn = true;
      for (const m of o.models ?? []) {
        st.models.push({ id: m.name, label: m.name, detail: m.details?.parameter_size });
      }
      st.detail = vscode.l10n.t("Server running · {0} models", String(st.models.length));
    }
  } catch {
    st.detail = vscode.l10n.t("Server not running at {0}", s.ollamaUrl);
  }
  return st;
}

/** 선택된 엔진으로 요약 */
export async function summarizeWith(
  engine: EngineId,
  items: SummarizeItem[],
  opt: Omit<LlmOptions, "command" | "url">,
  s: EngineSettings,
  token?: vscode.CancellationToken
): Promise<SummarizeResult> {
  if (engine === "vscode-lm") {
    return summarizeVscodeLm(items, opt, token);
  }
  const command =
    engine === "claude-cli"
      ? s.claudePath
      : engine === "codex-cli"
        ? s.codexPath
        : engine === "gemini-cli"
          ? s.geminiPath
          : s.opencodePath;
  return summarizeCli(engine, items, { ...opt, command, url: s.ollamaUrl });
}

async function summarizeVscodeLm(
  items: SummarizeItem[],
  opt: Omit<LlmOptions, "command" | "url">,
  token?: vscode.CancellationToken
): Promise<SummarizeResult> {
  if (!vscode.lm) {
    throw new Error(vscode.l10n.t("Requires VS Code 1.90 or later"));
  }
  const models = await vscode.lm.selectChatModels(opt.model ? { id: opt.model } : {});
  const model = models[0];
  if (!model) {
    throw new Error(vscode.l10n.t("The selected VS Code language model is not available"));
  }
  const cts = new vscode.CancellationTokenSource();
  token?.onCancellationRequested(() => cts.cancel());
  const timer = setTimeout(() => cts.cancel(), opt.timeoutMs);
  try {
    const resp = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(buildPrompt(items, opt.language, true))],
      { justification: vscode.l10n.t("Project Scope summarizes the functions you chose to analyze.") },
      cts.token
    );
    let text = "";
    for await (const chunk of resp.text) {
      text += chunk;
    }
    const res = toResult(extractJson(text));
    res.model = model.name;
    return res;
  } finally {
    clearTimeout(timer);
    cts.dispose();
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}
