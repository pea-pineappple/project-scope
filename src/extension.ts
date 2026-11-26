/**
 * extension.ts — Project Scope 진입점
 *
 * 활성화 조건: workspaceContains:.scope
 * 역할: store 로드 + 호출 그래프 해석 + watcher 가동 + tree/lens/hover/그래프 패널 등록.
 * 분석: 구조(함수 범위·srcHash·호출)는 언어 서버로 확장이 직접, 요약은 claude CLI (analyze/).
 *
 * 멀티루트: 모든 workspace folder 의 .scope/analysis.jsonl 을 병합해 인덱싱한다.
 * 폴더 추가/제거(onDidChangeWorkspaceFolders — hub 의 folder 교체 포함)마다
 * 스토어 재로드 + 워처 재구성. anchor 폴더(jsonl 없음)는 조용히 스킵된다.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { ScopeStore, type FolderRef, type ScopeEntry } from "./store";
import { CallGraph, toMermaid } from "./graph/callgraph";
import { ScopeGraphPanel, type GraphPanelDeps } from "./views/graphPanel";
import { bootstrapConvention } from "./bootstrap";
import { MultiScopeWatcher, resolveJsonlPath } from "./watcher";
import { ScopeTreeProvider, type TreeNode } from "./views/tree";
import { ScopeCodeLensProvider } from "./views/lens";
import { ScopeHoverProvider } from "./views/hover";
import { ScopeAnalyzer } from "./analyze/analyzer";
import { GitWatch, IGNORED_PATH, SOURCE_FILE } from "./analyze/git";
import { Highlighter } from "./highlight/highlighter";
import { engineName } from "./analyze/engines";
import { detectLanguage } from "./analyze/llm";
import { EnginePanel } from "./views/enginePanel";
import * as fs from "node:fs";

export function activate(context: vscode.ExtensionContext): void {
  // 진단 로그 — Output 패널 "Project Scope" 채널
  const log = vscode.window.createOutputChannel("Project Scope");
  const say = (msg: string): void => {
    log.appendLine(`[${new Date().toISOString()}] ${msg}`);
  };
  context.subscriptions.push(log);

  // 뷰/커맨드는 폴더 유무와 무관하게 항상 등록한다.
  // 폴더가 나중에 열리면(onDidChangeWorkspaceFolders) 스토어를 다시 연결한다.
  const folders = (): FolderRef[] =>
    (vscode.workspace.workspaceFolders ?? []).map((f) => ({
      name: f.name,
      fsPath: f.uri.fsPath,
    }));

  const store = new ScopeStore();
  /** 레코드 로드마다 다시 만든다 — calls 이름 → 레코드 해석 + 역방향 */
  let graph: CallGraph | undefined;
  const cfg = () => vscode.workspace.getConfiguration("projectScope");

  /** 스토어 로드 + 폴더별 상태 로그 */
  const loadStore = (): void => {
    store.loadAll(folders(), (f) =>
      resolveJsonlPath({
        name: f.name,
        uri: { fsPath: f.fsPath },
      } as vscode.WorkspaceFolder)
    );
    for (const f of folders()) {
      const p = path.join(f.fsPath, jsonlRel(f));
      const exists = fs.existsSync(p);
      const n = store
        .all()
        .filter((e) => e.folderRoot === f.fsPath).length;
      say(`folder: name=${f.name} root=${f.fsPath} jsonl=${p} exists=${exists} records=${n}`);
    }
    const { analyzed, stale } = store.count();
    say(`load: analyzed=${analyzed} stale=${stale}`);
    graph = new CallGraph(store.all());
    const g = graph.stats;
    say(`graph: calls=${g.calls} resolved=${g.resolved} guessed=${g.guessed} unresolved=${g.unresolved}`);
  };

  /** folder별 jsonl 상대경로 — 설정 projectScope.jsonlPath */
  const jsonlRel = (f: FolderRef): string =>
    vscode.workspace.getConfiguration("projectScope", {
      uri: vscode.Uri.file(f.fsPath),
    } as vscode.WorkspaceFolder).get<string>("jsonlPath", ".scope/analysis.jsonl");

  if ((vscode.workspace.workspaceFolders ?? []).length > 0) {
    loadStore();
  } else {
    say("activate: no workspace folder — waiting");
  }

  // --- 트리 ---
  const treeProvider = new ScopeTreeProvider(
    () => store.all(),
    () => graph,
    () => cfg().get<number>("callTreeMaxDepth", 6)
  );
  const treeView = vscode.window.createTreeView("projectScopeExplorer", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  // --- 상태바: Scope: N analyzed · M stale ---
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    50
  );
  statusBar.name = "Project Scope";
  // 클릭 = 탐색 창(별도 창) — 갱신·분석은 툴팁 링크와 Scope 뷰 버튼
  statusBar.command = "projectScope.openExplorer";

  const reload = () => {
    if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
      say("reload: skipped — no workspace folder");
      return;
    }
    say("reload: all folders");
    loadStore();
    treeProvider.refresh();
    lensProvider.notify();
    updateStatus();
    ScopeGraphPanel.refresh();
  };

  function updateStatus(): void {
    const { analyzed, stale, pending, busy } = store.count();
    // 에디터 우클릭·제목줄 "호출 그래프" 는 레코드가 있을 때만
    void vscode.commands.executeCommand("setContext", "projectScope.hasRecords", analyzed + pending > 0);
    void vscode.commands.executeCommand("setContext", "projectScope.needsAnalysis", stale + pending > 0);
    let text = `$(symbol-parameter) Scope ${analyzed}`;
    if (stale) {
      text += ` · ⚠${stale}`;
    }
    if (pending) {
      text += ` · ${vscode.l10n.t("new {0}", String(pending))}`;
    }
    if (busy) {
      text += ` · $(sync~spin) ${busy}`;
    }
    statusBar.text = analyzed + pending === 0 ? "$(symbol-parameter) Scope" : text;
    const md = new vscode.MarkdownString(
      `**Project Scope** — ${vscode.l10n.t("click to open the explorer")}\n\n` +
        `- ${vscode.l10n.t("analyzed {0} · changed (⚠) {1} · new {2}", String(analyzed), String(stale), String(pending))}` +
        `${busy ? ` · ${vscode.l10n.t("analyzing {0}", String(busy))}` : ""}\n` +
        `- ${vscode.l10n.t("engine: {0}", engineLabel())}\n\n` +
        `[$(refresh) ${vscode.l10n.t("Refresh")}](command:projectScope.refresh) · [$(sparkle) ${vscode.l10n.t("Analyze")}](command:projectScope.analyze) · ` +
        `[$(gear) ${vscode.l10n.t("Engine")}](command:projectScope.selectEngine) · [$(window) ${vscode.l10n.t("Explorer")}](command:projectScope.openExplorer)`,
      true
    );
    md.isTrusted = true;
    statusBar.tooltip = md;
    statusBar.show();
  }

  // --- 탐색 창 소스 영역 문법 색상 — 테마·확장이 바뀌면 다시 준비 ---
  const highlighter = new Highlighter(context.extensionPath, say);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      highlighter.reset();
      ScopeGraphPanel.refresh();
    }),
    vscode.extensions.onDidChange(() => highlighter.reset())
  );

  /**
   * 요약 언어 — 설정이 "ask"(기본) 면 분석 전에 한 번 묻고 워크스페이스 설정에 저장한다.
   * 기존 요약이 있으면 가장 많은 언어를 추천으로 맨 위에. 동시에 여러 분석이 와도 한 번만 묻는다.
   */
  let asking: Promise<string | undefined> | undefined;
  function ensureLanguage(): Promise<string | undefined> {
    const cur = cfg().get<string>("summaryLanguage", "ask") ?? "ask";
    if (cur !== "ask") {
      return Promise.resolve(cur);
    }
    asking ??= (async () => {
      try {
        const counts = new Map<string, number>();
        let total = 0;
        for (const e of store.all()) {
          if (!e.pending && e.record.summary) {
            const l = detectLanguage(e.record.summary);
            counts.set(l, (counts.get(l) ?? 0) + 1);
            total++;
          }
        }
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        const ui = vscode.env.language.toLowerCase();
        const options: { id: string; label: string }[] = [
          { id: "ko", label: "한국어" },
          { id: "en", label: "English" },
          { id: "ja", label: "日本語" },
          { id: "zh-cn", label: "简体中文" },
          { id: "zh-tw", label: "繁體中文" },
          { id: "auto", label: vscode.l10n.t("Same as code comments") },
        ];
        const items = options.map((o) => {
          const notes: string[] = [];
          if (top && top[0] === o.id) {
            notes.push(
              vscode.l10n.t("recommended — {0}% of existing summaries", String(Math.round((top[1] / total) * 100)))
            );
          }
          if (ui === o.id || ui.split("-")[0] === o.id) {
            notes.push(vscode.l10n.t("VS Code display language"));
          }
          return { id: o.id, label: o.label, description: notes.join(" · ") };
        });
        // 추천(기존 요약 다수) → 표시 언어 순으로 위로
        const rank = (x: { id: string }) => (top && x.id === top[0] ? 0 : ui.startsWith(x.id) ? 1 : 2);
        items.sort((a, b) => rank(a) - rank(b));
        const pick = await vscode.window.showQuickPick(items, {
          title: vscode.l10n.t("Scope: summary language for this project"),
          placeHolder: vscode.l10n.t("Choose the language summaries are written in — saved to this workspace's settings"),
          ignoreFocusOut: true,
        });
        if (!pick) {
          return undefined;
        }
        const target = vscode.workspace.workspaceFolders?.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
        await cfg().update("summaryLanguage", pick.id, target);
        return pick.id;
      } finally {
        asking = undefined;
      }
    })();
    return asking;
  }

  /** 상태바·분석 목록에 보일 "엔진 · 모델" */
  function engineLabel(): string {
    const e = cfg().get<string>("analyzer", "claude-cli") ?? "claude-cli";
    if (e === "off") {
      return vscode.l10n.t("off");
    }
    const m = cfg().get<string>("analyzeModel", "");
    return engineName(e) + (m ? ` · ${m}` : "");
  }

  // --- 분석기 (구조 갱신 + LLM 요약) ---
  let git: GitWatch | undefined;
  const analyzer = new ScopeAnalyzer({
    store,
    folders,
    jsonlPath: (root) => path.join(root, jsonlRel({ name: "", fsPath: root })),
    reload,
    repaint: () => {
      treeProvider.refresh();
      lensProvider.notify();
      updateStatus();
      ScopeGraphPanel.refresh();
    },
    log: say,
    cfg,
    git: () => git,
    ensureLanguage,
  });

  // --- watcher (M2, 멀티루트) ---
  let watcher: MultiScopeWatcher | undefined;
  const startWatcher = (): void => {
    watcher?.dispose();
    watcher = undefined;
    const fsFolders = folders().map((f) => ({ fsPath: f.fsPath }));
    if (fsFolders.length === 0) {
      return;
    }
    try {
      watcher = new MultiScopeWatcher(
        fsFolders,
        (f) => path.join(f.fsPath, jsonlRel({ name: "", fsPath: f.fsPath })),
        reload
      );
    } catch {
      // 감시 실패 시에도 확장은 동작 (수동 refresh)
    }
  };
  startWatcher();

  // 워크스페이스 폴더 변경 시 스토어/워처 재구성.
  // hub 의 updateWorkspaceFolders 폴더 교체도 change 이벤트로 잡힌다.
  const folderKey = (): string =>
    (vscode.workspace.workspaceFolders ?? [])
      .map((f) => f.uri.fsPath)
      .join("|");
  let lastFolderKey = folderKey();
  let folderTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const next = folderKey();
      say(
        `onDidChangeWorkspaceFolders: next=${next || "none"} prev=${lastFolderKey || "none"}`
      );
      if (next === lastFolderKey) {
        return;
      }
      lastFolderKey = next;
      analyzer.resetFolders();
      loadStore();
      watcher?.restart(
        folders().map((f) => ({ fsPath: f.fsPath }))
      );
      treeProvider.refresh();
      lensProvider.notify();
      updateStatus();
      ScopeGraphPanel.refresh();
      // 시작 때와 같이 언어 서버가 뜰 시간을 두고 새 폴더 구조 갱신
      clearTimeout(folderTimer);
      folderTimer = setTimeout(() => {
        if (store.count().analyzed > 0 && cfg().get<boolean>("scanOnStartup", true)) {
          void analyzer.refresh();
        }
      }, 4000);
    }),
    { dispose: () => clearTimeout(folderTimer) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("projectScope.callTreeMaxDepth")) {
        treeProvider.refresh();
      }
    })
  );

  // --- CodeLens / Hover (M4) ---
  const lensSelector = [
    "python",
    "typescript",
    "javascript",
    "go",
    "rust",
    "java",
    "csharp",
    "cpp",
    "c",
    "kotlin",
    "typescriptreact",
    "javascriptreact",
  ].map((lang) => ({ language: lang, scheme: "file" }));
  const lensProvider = new ScopeCodeLensProvider(store);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(lensSelector, lensProvider),
    vscode.languages.registerHoverProvider(
      lensSelector,
      new ScopeHoverProvider(store)
    )
  );

  // --- 명령 (M4) ---
  context.subscriptions.push(
    vscode.commands.registerCommand("projectScope.refresh", () => refreshCommand()),
    vscode.commands.registerCommand("projectScope.analyze", (arg?: unknown) => analyzeCommand(arg)),
    vscode.commands.registerCommand("projectScope.selectEngine", () => EnginePanel.show(() => updateStatus())),
    vscode.commands.registerCommand("projectScope.openExplorerHere", () =>
      ScopeGraphPanel.show(graphDeps(), entryFromArg(undefined))
    ),
    vscode.commands.registerCommand(
      "projectScope.reveal",
      (file: string, line: number, folderRoot?: string, target?: string) => {
        if (folderRoot && target) {
          const e = store.getInFolder(folderRoot, target);
          if (e) {
            analyzer.auto([e], "click");
          }
        }
        // tree 에서 절대경로로 전달 — 없으면 첫 폴더 기준 시도
        let abs = file;
        if (!path.isAbsolute(abs)) {
          const first = folders()[0];
          if (!first) {
            return;
          }
          abs = path.join(first.fsPath, file);
        }
        void revealLine(abs, line);
      }
    ),
    vscode.commands.registerCommand(
      "projectScope.showSummary",
      async (arg?: unknown) => {
        const entry = entryFromArg(arg);
        if (!entry) {
          void vscode.window.showInformationMessage(
            vscode.l10n.t("Scope: no record{0}", typeof arg === "string" ? ` — ${arg}` : "")
          );
          return;
        }
        const rec = entry.record;
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`### ${rec.name}\n\n`);
        md.appendMarkdown(rec.summary);
        if (rec.params?.length) {
          md.appendText(`\n\nparams: ${rec.params.join(", ")}`);
        }
        if (rec.model) {
          md.appendText(`\n\nmodel: ${rec.model} · ${rec.generatedAt}`);
        }
        await vscode.window.showQuickPick([md.value], { placeHolder: vscode.l10n.t("Summary") });
      }
    ),
    vscode.commands.registerCommand("projectScope.showFlow", (arg?: unknown) =>
      pickEdges(entryFromArg(arg), "out")
    ),
    vscode.commands.registerCommand("projectScope.showCallers", (arg?: unknown) =>
      pickEdges(entryFromArg(arg), "in")
    ),
    vscode.commands.registerCommand("projectScope.showGraph", (arg?: unknown) => {
      const entry = entryFromArg(arg);
      if (!entry) {
        void vscode.window.showInformationMessage(vscode.l10n.t("Scope: run this on a function or class, or pick one in the tree"));
        return;
      }
      ScopeGraphPanel.show(graphDeps(), entry);
    }),
    vscode.commands.registerCommand("projectScope.openExplorer", () => ScopeGraphPanel.show(graphDeps())),
    vscode.commands.registerCommand("projectScope.copyMermaid", async (arg?: unknown) => {
      const entry = entryFromArg(arg);
      if (!entry || !graph || entry.record.kind !== "func") {
        void vscode.window.showInformationMessage(vscode.l10n.t("Scope: run this on a function, or pick a function in the tree"));
        return;
      }
      const sub = graph.expand(entry, cfg().get<number>("graphDepth", 3), 60);
      await vscode.env.clipboard.writeText(toMermaid(sub));
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Scope: Mermaid flowchart copied — {0} functions{1}", String(sub.nodes.length), sub.truncated ? vscode.l10n.t(" (truncated)") : "")
      );
    }),
    vscode.commands.registerCommand("projectScope.bootstrap", () =>
      bootstrapConvention(context.extensionUri)
    )
  );

  function graphDeps(): GraphPanelDeps {
    return {
      graph: () => graph,
      entries: () => store.all(),
      absPath: (e) => store.resolveAbs(e.record, e.folderRoot),
      // 그래프가 별도 창에 있어도 소스는 메인 창 첫 그룹에 연다
      reveal: (e) =>
        void revealLine(store.resolveAbs(e.record, e.folderRoot), e.record.line, vscode.ViewColumn.One),
      revealAt: (abs, line) => void revealLine(abs, line, vscode.ViewColumn.One),
      defaultDepth: () => cfg().get<number>("graphDepth", 3),
      openIn: () => cfg().get<"window" | "beside" | "active">("graphOpenIn", "window"),
      onSelect: (e) => analyzer.auto([e], "click"),
      highlight: async (e, from, to) => {
        const abs = store.resolveAbs(e.record, e.folderRoot);
        let lang = "";
        try {
          lang = (await vscode.workspace.openTextDocument(vscode.Uri.file(abs))).languageId;
        } catch {
          // 확장자로 판단
        }
        return highlighter.highlight(abs, lang, from, to);
      },
      analyze: (e) => void analyzeCommand(e),
    };
  }

  /** 갱신: jsonl 다시 읽기 + 구조 재추출 (LLM 없음) */
  async function refreshCommand(): Promise<void> {
    if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
      return;
    }
    reload();
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Scope: refreshing structure") },
      () => analyzer.refresh({ full: true })
    );
    const need = analyzer.needs().length;
    const parts = [vscode.l10n.t("{0} files checked", String(r.files))];
    if (r.moved) {
      parts.push(vscode.l10n.t("moved {0}", String(r.moved)));
    }
    if (r.gone) {
      parts.push(vscode.l10n.t("deleted {0}", String(r.gone)));
    }
    if (r.added) {
      parts.push(vscode.l10n.t("new functions {0}", String(r.added)));
    }
    if (r.skipped.length) {
      parts.push(vscode.l10n.t("skipped {0} (no language server or unsaved)", String(r.skipped.length)));
    }
    const msg = vscode.l10n.t("Scope refresh: {0}", parts.join(" · ")) + (need ? ` — ${vscode.l10n.t("{0} need analysis", String(need))}` : ` — ${vscode.l10n.t("all up to date")}`);
    if (need) {
      const go = vscode.l10n.t("Analyze");
      const pick = await vscode.window.showInformationMessage(msg, go);
      if (pick === go) {
        await runAnalyze(analyzer.needs(), vscode.l10n.t("{0} need analysis", String(need)));
      }
    } else {
      void vscode.window.showInformationMessage(msg);
    }
  }

  /** 분석: 인자(트리 노드·target·레코드)가 있으면 그것, 없으면 범위를 고른다 */
  async function analyzeCommand(arg?: unknown): Promise<void> {
    let list: ScopeEntry[] | undefined;
    let label = "";
    const direct =
      arg && typeof arg === "object" && "record" in (arg as object) ? (arg as ScopeEntry) : arg ? entryFromArg(arg) : undefined;
    if (direct) {
      list = [direct];
      label = direct.record.name;
    } else {
      const editor = vscode.window.activeTextEditor;
      const here = entryFromArg(undefined);
      const need = analyzer.needs();
      const items: (vscode.QuickPickItem & { id: string })[] = [
        { id: "needs", label: `$(sparkle) ${vscode.l10n.t("Everything that needs analysis")}`, description: vscode.l10n.t("{0} — changed + new functions", String(need.length)) },
      ];
      if (editor && editor.document.uri.scheme === "file") {
        items.push({
          id: "file",
          label: `$(file-code) ${vscode.l10n.t("Current file")}`,
          description: vscode.l10n.t("{0} — only what needs analysis (all again if none)", vscode.workspace.asRelativePath(editor.document.uri)),
        });
      }
      if (here) {
        items.push({ id: "here", label: `$(symbol-method) ${vscode.l10n.t("At cursor")}`, description: here.record.name });
      }
      items.push({ id: "engine", label: `$(gear) ${vscode.l10n.t("Change engine…")}`, description: engineLabel() });
      const pick = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t("Scope: what should be analyzed? (engine: {0})", engineLabel()) });
      if (!pick) {
        return;
      }
      if (pick.id === "engine") {
        EnginePanel.show(() => updateStatus());
        return;
      }
      if (pick.id === "needs") {
        await analyzer.refresh();
        list = analyzer.needs();
        label = vscode.l10n.t("{0} need analysis", String(list.length));
      } else if (pick.id === "here" && here) {
        list = [here];
        label = here.record.name;
      } else if (editor) {
        const abs = editor.document.uri.fsPath;
        if (editor.document.isDirty) {
          await editor.document.save();
        }
        await analyzer.refresh({ files: [abs] });
        const inFile = store.all().filter((e) => path.join(e.folderRoot, e.record.file) === abs);
        const need = inFile.filter((e) => e.stale || e.pending);
        list = need.length ? need : inFile;
        label = `${path.basename(abs)} · ${list.length}`;
      }
    }
    if (!list || list.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t("Scope: nothing to analyze — all up to date"));
      return;
    }
    await runAnalyze(list, label);
  }

  async function runAnalyze(list: ScopeEntry[], label: string): Promise<void> {
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Scope analysis: {0}", label), cancellable: true },
      (progress, token) =>
        analyzer.analyze(list, { token, progress: (message, increment) => progress.report({ message, increment }) })
    );
    const cost = r.costUsd ? ` · $${r.costUsd.toFixed(3)}` : "";
    if (r.failed || r.errors.length) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Scope analysis: done {0} · failed {1}", String(r.done), String(r.failed)) + (r.skipped ? ` · ${vscode.l10n.t("skipped {0}", String(r.skipped))}` : "") + `${cost} — ${r.errors[0] ?? ""}`
      );
    } else {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Scope analysis: {0} done", String(r.done)) + (r.skipped ? ` · ${vscode.l10n.t("skipped {0}", String(r.skipped))}` : "") + cost
      );
    }
  }

  /**
   * 커맨드 인자 → 레코드. target 문자열(CodeLens), 트리 노드(우클릭 메뉴),
   * 인자 없음(커맨드 팔레트) 이면 활성 에디터 커서를 감싸는 가장 안쪽 함수.
   */
  function entryFromArg(arg: unknown): ScopeEntry | undefined {
    if (typeof arg === "string") {
      return store.get(arg);
    }
    const node = arg as TreeNode | undefined;
    if (node && typeof node === "object") {
      if (node.kind === "symbol" || node.kind === "callGroup") {
        return node.entry;
      }
      if (node.kind === "call") {
        return node.edge.target;
      }
    }
    const editor = vscode.window.activeTextEditor;
    const root = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!editor || !root) {
      return undefined;
    }
    const rel = path.relative(root.uri.fsPath, editor.document.uri.fsPath).split(path.sep).join("/");
    const line = editor.selection.active.line + 1;
    return store
      .all()
      .filter(
        (e) =>
          e.folderRoot === root.uri.fsPath &&
          e.record.file === rel &&
          e.record.kind === "func" &&
          e.record.line <= line &&
          line <= e.record.endLine
      )
      .sort((a, b) => b.record.line - a.record.line)[0];
  }

  /** Flow / Callers QuickPick — 해석된 함수를 고르면 소스로 이동 */
  async function pickEdges(entry: ScopeEntry | undefined, dir: "out" | "in"): Promise<void> {
    if (!entry || !graph) {
      void vscode.window.showInformationMessage(vscode.l10n.t("Scope: no record{0}", ""));
      return;
    }
    const edges = graph.edges(entry, dir);
    const items = edges.map((edge) => ({
      label: `${dir === "out" ? "→" : "↩"} ${edge.target ? edge.target.record.name : edge.name}`,
      description: edge.target
        ? `${edge.target.record.file}:${edge.target.record.line}${edge.how === "guess" ? ` · ${vscode.l10n.t("guess")}` : ""}`
        : vscode.l10n.t("not analyzed · external"),
      detail: edge.target?.record.summary,
      entry: edge.target,
    }));
    if (items.length === 0) {
      items.push({
        label: dir === "out" ? vscode.l10n.t("Calls no function") : vscode.l10n.t("No callers"),
        description: "",
        detail: undefined,
        entry: undefined,
      });
    }
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `${dir === "out" ? "Flow" : "Callers"}: ${entry.record.name}`,
      matchOnDescription: true,
    });
    if (pick?.entry) {
      await revealLine(store.resolveAbs(pick.entry.record, pick.entry.folderRoot), pick.entry.record.line);
    }
  }

  // --- 저장 시 구조 갱신 (+ autoAnalyze=onSave 면 요약) ---
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const abs = doc.uri.fsPath;
      if (
        doc.uri.scheme !== "file" ||
        !SOURCE_FILE.test(abs) ||
        IGNORED_PATH.test(abs) ||
        !vscode.workspace.getWorkspaceFolder(doc.uri) ||
        !cfg().get<boolean>("scanOnSave", true)
      ) {
        return;
      }
      clearTimeout(saveTimers.get(abs));
      saveTimers.set(
        abs,
        setTimeout(() => {
          saveTimers.delete(abs);
          void analyzer.refresh({ files: [abs] }).then(() =>
            analyzer.auto(analyzer.needs((e) => path.join(e.folderRoot, e.record.file) === abs), "save")
          );
        }, 1500)
      );
    }),
    { dispose: () => saveTimers.forEach((t) => clearTimeout(t)) }
  );

  // --- git: HEAD 이동(브랜치 전환·pull·commit) 이면 구조 갱신 ---
  let gitTimer: ReturnType<typeof setTimeout> | undefined;
  if (cfg().get<boolean>("gitIntegration", true)) {
    git = new GitWatch((root) => {
      say(`git: HEAD changed — ${root}`);
      clearTimeout(gitTimer);
      gitTimer = setTimeout(() => void analyzer.refresh(), 3000);
    });
    context.subscriptions.push(git, { dispose: () => clearTimeout(gitTimer) });
    void git.start().then((ok) => say(`git: ${ok && git?.available ? "connected" : "no repository — change detection by srcHash only"}`));
  }

  // --- 시작 시: 언어 서버가 뜰 시간을 두고 구조 갱신, 설정 시 탐색 창 ---
  const startTimer = setTimeout(() => {
    if (store.count().analyzed > 0 && cfg().get<boolean>("scanOnStartup", true)) {
      void analyzer.refresh();
    }
  }, 4000);
  context.subscriptions.push({ dispose: () => clearTimeout(startTimer) });
  if (cfg().get<boolean>("openExplorerOnStartup", false) && store.count().analyzed > 0) {
    ScopeGraphPanel.show(graphDeps());
  }

  // 초기 상태
  updateStatus();

  context.subscriptions.push(treeView, statusBar, watcher ?? {
    dispose: () => undefined,
  });
}

/** 파일의 특정 줄 열기 — 절대경로 기준 (멀티루트: 레코드 folderRoot에서 해석) */
async function revealLine(absFile: string, line1: number, column?: vscode.ViewColumn): Promise<void> {
  try {
    const uri = vscode.Uri.file(absFile);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, column);
    const line = Math.max(0, Math.min(line1 - 1, doc.lineCount - 1));
    const pos = new vscode.Position(line, 0);
    editor.revealRange(new vscode.Range(pos, pos));
    editor.selection = new vscode.Selection(pos, pos);
  } catch {
    void vscode.window.showWarningMessage(vscode.l10n.t("Scope: cannot open file — {0}", absFile));
  }
}

export function deactivate(): void {
  // 구독은 context.subscriptions 이 정리
}
