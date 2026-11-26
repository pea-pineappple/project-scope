/**
 * enginePanel.ts — 분석 엔진 선택 창 (Webview)
 *
 * 로그인된 AI 에이전트(Claude Code · Codex · Gemini CLI · OpenCode), VS Code 언어 모델(Copilot 등),
 * 로컬 Ollama 를 감지해 카드로 보여 주고, 엔진·모델·요약 언어를 고르게 한다.
 *  - 카드: 설치/로그인 상태 · 계정 · 코드가 전송되는 곳 · 모델 선택(목록 / 엔진 기본값 / 직접 입력)
 *  - 테스트: 작은 예제 함수 하나를 그 엔진으로 요약해 시간·비용·결과를 보여 줌
 *  - 로그인: 터미널을 열어 그 CLI 의 로그인 명령 실행 (끝나면 다시 감지)
 * 선택은 설정 projectScope.analyzer / analyzeModel / summaryLanguage 에 저장한다
 * (워크스페이스에 값이 있으면 워크스페이스, 아니면 사용자 설정).
 */
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { detectEngines, engineName, engineSettings, summarizeWith, type EngineStatus } from "../analyze/engines";
import { languageName, type EngineId } from "../analyze/llm";

const SAMPLE = {
  id: "0",
  kind: "func" as const,
  qual: "averageScore",
  lang: "typescript",
  file: "sample.ts",
  line: 1,
  endLine: 5,
  code: [
    "export function averageScore(scores: number[], dropLowest = false): number {",
    "  const list = dropLowest ? [...scores].sort((a, b) => a - b).slice(1) : scores;",
    "  if (list.length === 0) return 0;",
    "  return list.reduce((sum, s) => sum + s, 0) / list.length;",
    "}",
  ].join("\n"),
};

const NATIVE: Record<string, string> = {
  English: "English",
  Korean: "한국어",
  Japanese: "日本語",
  "Simplified Chinese": "简体中文",
  "Traditional Chinese": "繁體中文",
};

export class EnginePanel {
  private static current: EnginePanel | undefined;
  private statuses: EngineStatus[] = [];
  private detecting = false;

  static show(onChanged: () => void): void {
    if (EnginePanel.current) {
      EnginePanel.current.panel.reveal();
      void EnginePanel.current.detect();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "projectScopeEngine",
      vscode.l10n.t("Scope: Analysis engine"),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    EnginePanel.current = new EnginePanel(panel, onChanged);
  }

  private constructor(
    private panel: vscode.WebviewPanel,
    private onChanged: () => void
  ) {
    panel.webview.html = html(crypto.randomBytes(16).toString("base64"));
    const subs: vscode.Disposable[] = [
      panel.webview.onDidReceiveMessage((m: Msg) => void this.onMessage(m)),
      // 로그인 터미널이 닫히면 다시 감지
      vscode.window.onDidCloseTerminal((t) => {
        if (t.name.startsWith("Scope: ")) {
          void this.detect();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("projectScope")) {
          this.post();
        }
      }),
    ];
    panel.onDidDispose(() => {
      EnginePanel.current = undefined;
      subs.forEach((d) => d.dispose());
    });
  }

  private cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("projectScope");
  }

  private async onMessage(m: Msg): Promise<void> {
    switch (m.type) {
      case "ready":
        this.post();
        await this.detect();
        break;
      case "detect":
        await this.detect();
        break;
      case "use":
        await this.save("analyzer", m.engine);
        await this.save("analyzeModel", m.model ?? "");
        this.onChanged();
        this.post();
        void vscode.window.showInformationMessage(
          vscode.l10n.t("Scope: analysis engine set to {0}{1}", engineName(m.engine ?? ""), m.model ? ` · ${m.model}` : "")
        );
        break;
      case "off":
        await this.save("analyzer", "off");
        this.onChanged();
        this.post();
        break;
      case "lang":
        // 요약은 저장소에 남으므로 언어는 프로젝트(워크스페이스) 설정에
        await this.cfg().update(
          "summaryLanguage",
          m.value ?? "ask",
          vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
        );
        break;
      case "login": {
        const st = this.statuses.find((s) => s.id === m.engine);
        if (st?.loginCommand) {
          const term = vscode.window.createTerminal({ name: `Scope: ${st.name}` });
          term.show();
          term.sendText(st.loginCommand);
        }
        break;
      }
      case "test":
        await this.test(m.engine as EngineId, m.model ?? "");
        break;
    }
  }

  /** 워크스페이스에 값이 있으면 워크스페이스, 아니면 사용자 설정에 저장 */
  private async save(key: string, value: unknown): Promise<void> {
    const ins = this.cfg().inspect(key);
    const target =
      ins?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : ins?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await this.cfg().update(key, value, target);
  }

  private async detect(): Promise<void> {
    if (this.detecting) {
      return;
    }
    this.detecting = true;
    void this.panel.webview.postMessage({ type: "detecting" });
    try {
      this.statuses = await detectEngines(engineSettings(this.cfg()));
    } finally {
      this.detecting = false;
    }
    this.post();
  }

  private post(): void {
    const cfg = this.cfg();
    void this.panel.webview.postMessage({
      type: "state",
      engines: this.statuses,
      current: cfg.get<string>("analyzer", "claude-cli"),
      model: cfg.get<string>("analyzeModel", "sonnet"),
      lang: cfg.get<string>("summaryLanguage", "ask"),
      uiLang: NATIVE[languageName("ui", vscode.env.language)] ?? vscode.env.language,
    });
  }

  private async test(engine: EngineId, model: string): Promise<void> {
    const t0 = Date.now();
    void this.panel.webview.postMessage({ type: "testing", engine });
    try {
      const res = await summarizeWith(
        engine,
        [SAMPLE],
        {
          model,
          language: languageName(this.cfg().get<string>("summaryLanguage", "ask") ?? "ask", vscode.env.language),
          timeoutMs: 120_000,
        },
        engineSettings(this.cfg())
      );
      const got = res.items.get("0");
      void this.panel.webview.postMessage({
        type: "tested",
        engine,
        ok: !!got,
        ms: Date.now() - t0,
        cost: res.costUsd,
        model: res.model,
        text: got ? got.summary : vscode.l10n.t("The engine answered, but without a summary for the sample"),
      });
    } catch (e) {
      void this.panel.webview.postMessage({ type: "tested", engine, ok: false, ms: Date.now() - t0, text: (e as Error).message });
    }
  }
}

interface Msg {
  type: string;
  engine?: string;
  model?: string;
  value?: string;
}

/** 웹뷰 문구 — 확장 쪽에서 번역해 넘긴다 */
function strings(): Record<string, string> {
  const t = vscode.l10n.t;
  return {
    title: t("Analysis engine"),
    lead: t("Summaries are written by an AI agent you are already signed in to. Pick the engine and model; the extension never stores keys."),
    redetect: t("Detect again"),
    detecting: t("Detecting signed-in agents…"),
    language: t("Summary language"),
    langUi: t("VS Code display language"),
    langAuto: t("Same as code comments"),
    langAsk: t("Not set — ask before analyzing"),
    inUse: t("In use"),
    signedIn: t("Signed in"),
    notSignedIn: t("Not signed in"),
    notInstalled: t("Not installed"),
    unknown: t("Status unknown"),
    sendsTo: t("Code is sent to"),
    model: t("Model"),
    engineDefault: t("Engine default"),
    custom: t("Custom…"),
    customPh: t("model name"),
    use: t("Use this engine"),
    test: t("Test"),
    testing: t("Testing…"),
    signIn: t("Sign in in terminal"),
    install: t("Install"),
    noModels: t("No model available"),
    off: t("Turn summaries off (structure only)"),
    offNow: t("Summaries are off — Refresh still updates structure."),
    seconds: t("s"),
  };
}

function html(nonce: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
${STYLE}
</style>
</head>
<body>
<header>
  <h2 id="title"></h2>
  <p id="lead"></p>
  <div class="row">
    <label id="langLabel" for="lang"></label>
    <select id="lang"></select>
    <span class="sp"></span>
    <button id="redetect" class="sec"></button>
  </div>
  <p id="status" class="muted"></p>
</header>
<main id="cards"></main>
<footer><button id="off" class="link"></button></footer>
<script nonce="${nonce}">
const T = ${JSON.stringify(strings()).replace(/</g, "\\u003c")};
${SCRIPT}
</script>
</body>
</html>`;
}

const STYLE = String.raw`
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 20px 24px 32px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
       color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 980px; }
h2 { margin: 0 0 6px; font-size: 1.4em; }
p { margin: 0 0 12px; line-height: 1.5; }
.muted { color: var(--vscode-descriptionForeground); }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
.sp { flex: 1; }
button, select, input { font: inherit; }
button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 3px; padding: 4px 12px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.sec { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0; }
button:disabled { opacity: .45; cursor: default; }
select, input { color: var(--vscode-input-foreground); background: var(--vscode-input-background);
                border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 3px 6px; }
main { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; margin-top: 8px; }
.card { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; padding: 14px;
        background: var(--vscode-editorWidget-background); display: flex; flex-direction: column; gap: 8px; }
.card.cur { border: 2px solid var(--vscode-focusBorder); }
.card.dim { opacity: .65; }
.head { display: flex; align-items: center; gap: 8px; }
.head b { font-size: 1.05em; }
.chip { font-size: .85em; padding: 1px 8px; border-radius: 10px; white-space: nowrap; }
.chip.ok { background: color-mix(in srgb, var(--vscode-charts-green) 22%, transparent); }
.chip.warn { background: color-mix(in srgb, var(--vscode-charts-orange) 22%, transparent); }
.chip.off { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.chip.use { background: var(--vscode-focusBorder); color: var(--vscode-button-foreground); }
.small { font-size: .9em; color: var(--vscode-descriptionForeground); word-break: break-all; }
.model { display: flex; gap: 6px; flex-wrap: wrap; }
.model select { flex: 1; min-width: 160px; }
.model input { flex: 1; min-width: 120px; }
.acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
.result { font-size: .92em; padding: 8px; border-radius: 4px; white-space: pre-wrap; line-height: 1.45;
          background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); }
.result.bad { border-left-color: var(--vscode-inputValidation-errorBorder); }
footer { margin-top: 16px; }
`;

const SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let st = null, testing = {}, results = {};
function h(tag, cls, text, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
$("title").textContent = T.title; $("lead").textContent = T.lead; $("langLabel").textContent = T.language;
$("redetect").textContent = T.redetect; $("off").textContent = T.off;
$("redetect").onclick = () => vscode.postMessage({ type: "detect" });
$("off").onclick = () => vscode.postMessage({ type: "off" });
$("lang").onchange = (e) => vscode.postMessage({ type: "lang", value: e.target.value });

window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m.type === "detecting") { $("status").textContent = T.detecting; return; }
  if (m.type === "testing") { testing[m.engine] = true; render(); return; }
  if (m.type === "tested") { testing[m.engine] = false; results[m.engine] = m; render(); return; }
  if (m.type === "state") { st = m; $("status").textContent = st.current === "off" ? T.offNow : ""; render(); }
});

function render() {
  if (!st) return;
  const lang = $("lang"); lang.textContent = "";
  const langs = [["ask", T.langAsk], ["ui", T.langUi + " (" + st.uiLang + ")"], ["auto", T.langAuto], ["en", "English"], ["ko", "한국어"], ["ja", "日本語"], ["zh-cn", "简体中文"], ["zh-tw", "繁體中文"]];
  for (const [v, label] of langs) { const o = h("option", null, label, lang); o.value = v; }
  lang.value = st.lang;
  const box = $("cards"); box.textContent = "";
  for (const e of st.engines) card(box, e);
}

function card(box, e) {
  const cur = st.current === e.id;
  const usable = e.installed && e.loggedIn !== false;
  const c = h("div", "card" + (cur ? " cur" : "") + (usable ? "" : " dim"), null, box);
  const head = h("div", "head", null, c);
  h("b", null, e.name, head);
  if (cur) h("span", "chip use", T.inUse, head);
  const chip = !e.installed ? ["off", T.notInstalled] : e.loggedIn === true ? ["ok", T.signedIn] : e.loggedIn === false ? ["warn", T.notSignedIn] : ["off", T.unknown];
  h("span", "chip " + chip[0], chip[1], head);
  if (e.account || e.detail) h("div", "small", [e.account, e.detail].filter(Boolean).join(" · "), c);
  h("div", "small", T.sendsTo + ": " + e.sendsTo, c);
  if (!e.installed) {
    if (e.installHint) { const p = h("div", "small", T.install + ": ", c); h("code", null, e.installHint, p); }
    return;
  }
  // 모델 선택: 엔진 기본값 · 목록 · 직접 입력
  const mrow = h("div", "model", null, c);
  const sel = h("select", null, null, mrow);
  const input = h("input", null, null, mrow);
  input.placeholder = T.customPh;
  const opts = [];
  if (e.id !== "vscode-lm" && e.id !== "ollama") opts.push(["", T.engineDefault + (e.defaultModel ? " (" + e.defaultModel + ")" : "")]);
  for (const m of e.models) opts.push([m.id, m.label + (m.detail ? " — " + m.detail : "")]);
  if (e.customModel) opts.push(["__custom", T.custom]);
  if (!opts.length) opts.push(["", T.noModels]);
  for (const [v, label] of opts) { const o = h("option", null, label, sel); o.value = v; }
  const known = opts.some(([v]) => v === st.model);
  if (cur && st.model && !known && e.customModel) { sel.value = "__custom"; input.value = st.model; }
  else if (cur && known) sel.value = st.model;
  else if (e.id === "claude-cli") sel.value = "sonnet";
  input.hidden = sel.value !== "__custom";
  sel.onchange = () => { input.hidden = sel.value !== "__custom"; if (!input.hidden) input.focus(); };
  const model = () => (sel.value === "__custom" ? input.value.trim() : sel.value);
  const acts = h("div", "acts", null, c);
  const use = h("button", null, T.use, acts);
  use.disabled = !usable;
  use.onclick = () => vscode.postMessage({ type: "use", engine: e.id, model: model() });
  const test = h("button", "sec", testing[e.id] ? T.testing : T.test, acts);
  test.disabled = !usable || !!testing[e.id];
  test.onclick = () => vscode.postMessage({ type: "test", engine: e.id, model: model() });
  if (e.loggedIn === false && e.loginCommand) {
    const li = h("button", "sec", T.signIn, acts);
    li.onclick = () => vscode.postMessage({ type: "login", engine: e.id });
  }
  const r = results[e.id];
  if (r) {
    const meta = (r.ms / 1000).toFixed(1) + T.seconds + (r.cost ? " · $" + r.cost.toFixed(4) : "") + (r.model ? " · " + r.model : "");
    h("div", "result" + (r.ok ? "" : " bad"), (r.ok ? "✓ " : "✗ ") + meta + "\n" + r.text, c);
  }
}

vscode.postMessage({ type: "ready" });
`;
