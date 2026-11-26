/**
 * graphPanel.ts — Scope 탐색 창 (Webview): 왼쪽 소스 목록 · 가운데 그래프 · 오른쪽 요약
 *
 * 탐색 창의 동작:
 *  - 씨앗: 씨앗 함수의 callee 를 depth 까지 + 직접 호출자 (CallGraph.expand)
 *  - 노드 클릭: 그 노드를 선택하고, 아직 안 펼친 노드면 이웃을 캔버스에 **누적** —
 *    호출자 ←, 호출 →, 참조(언어 서버 참조 찾기), 클래스 ↔ 멤버.
 *    선택 노드를 중심으로 다시 배치하고 직접 연결만 강조 (나머지는 흐림)
 *  - 뒤로/앞으로: 선택 히스토리
 *  - 왼쪽 목록 클릭: 새 씨앗, 오른쪽 패널: 요약·파라미터·이웃 목록·소스 일부
 *
 * 캔버스 상태(노드·간선·펼침·히스토리)는 확장 쪽이 가진다 — 별도 창으로 옮겨
 * 웹뷰가 다시 로드돼도 ready 한 번으로 그대로 복원된다.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ScopeEntry } from "../store";
import { entryKey, qualOf, type CallGraph } from "../graph/callgraph";
import type { Highlighted } from "../highlight/highlighter";

export interface GraphPanelDeps {
  graph: () => CallGraph | undefined;
  entries: () => ScopeEntry[];
  absPath: (e: ScopeEntry) => string;
  reveal: (e: ScopeEntry) => void;
  revealAt: (absFile: string, line: number) => void;
  defaultDepth: () => number;
  /** 새로 열 때 위치 — window: 별도 창, beside: 옆 탭, active: 현재 탭 그룹 */
  openIn: () => "window" | "beside" | "active";
  /** 사용자가 노드·목록을 골랐을 때 (자동 분석 onClick) */
  onSelect?: (e: ScopeEntry) => void;
  /** 요약 패널의 분석 버튼 */
  analyze?: (e: ScopeEntry) => void;
  /** 소스 영역 문법 색상 (없거나 실패하면 일반 텍스트) */
  highlight?: (e: ScopeEntry, from: number, to: number) => Promise<Highlighted | undefined>;
}

type EdgeKind = "call" | "ref" | "member";

interface CanvasEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  guess: boolean;
}

/** 레코드 범위 밖(모듈 최상위 등)에서 나온 참조 — 오른쪽 패널에 위치만 보여 준다 */
interface LooseRef {
  abs: string;
  file: string;
  line: number;
  text: string;
}

interface Msg {
  type: string;
  key?: string;
  depth?: number;
  abs?: string;
  line?: number;
}

const SEED_CAP = 80;
const CANVAS_CAP = 220;
const SOURCE_MAX_LINES = 160;
const REF_TIMEOUT_MS = 8000;
/** import 줄의 참조는 흐름이 아니므로 뺀다 (import / from / using / #include / use / export … from) */
const IMPORT_LINE = /^(import\b|from\s+\S+\s+import\b|using\s|#\s*include\b|use\s|(pub\s+)?use\s|export\s.*\sfrom\s|require\()/;

export class ScopeGraphPanel {
  private static current: ScopeGraphPanel | undefined;

  private byKey = new Map<string, ScopeEntry>();
  private nodes = new Set<string>();
  private edges = new Map<string, CanvasEdge>();
  private expanded = new Set<string>();
  /** 참조 찾기 결과 캐시 — 참조자 레코드 키 + 레코드에 안 걸린 참조. 캔버스와 무관하게 유지 */
  private refsDone = new Map<string, { owners: string[]; loose: LooseRef[] }>();
  private refsPending = new Set<string>();
  private seedKey: string | undefined;
  private selected: string | undefined;
  /** 선택 히스토리 — 씨앗을 함께 적어 두어 뒤로 가기가 씨앗을 넘나들면 그 캔버스를 복원 */
  private history: { key: string; seed: string }[] = [];
  /** 씨앗별 캔버스 (다른 씨앗으로 바꿀 때 보관) */
  private canvases = new Map<string, { nodes: Set<string>; edges: Map<string, CanvasEdge>; expanded: Set<string> }>();
  private pos = -1;
  private depth: number;
  private note = "";
  private capHit = false;

  static show(deps: GraphPanelDeps, seed?: ScopeEntry): void {
    const cur = ScopeGraphPanel.current;
    if (cur) {
      // 위치 인자 없이 reveal — 이미 별도 창에 있으면 그 창에 그대로 둔다
      cur.panel.reveal(undefined, true);
      if (seed) {
        cur.reseed(entryKey(seed));
      }
      return;
    }
    const where = deps.openIn();
    const panel = vscode.window.createWebviewPanel(
      "projectScopeGraph",
      vscode.l10n.t("Scope Explorer"),
      {
        viewColumn: where === "active" ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside,
        // 별도 창으로 옮기려면 패널이 활성 편집기여야 함
        preserveFocus: where !== "window",
      },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    const p = new ScopeGraphPanel(panel, deps);
    ScopeGraphPanel.current = p;
    if (seed) {
      p.reseed(entryKey(seed), false);
    }
    if (where === "window") {
      void p.popout();
    }
  }

  /** 레코드가 다시 로드되면 목록·캔버스를 새 데이터로 맞춤 */
  static refresh(): void {
    ScopeGraphPanel.current?.reload();
  }

  private constructor(
    private panel: vscode.WebviewPanel,
    private deps: GraphPanelDeps
  ) {
    this.depth = deps.defaultDepth();
    this.reindex();
    panel.webview.html = html(crypto.randomBytes(16).toString("base64"));
    panel.onDidDispose(() => {
      ScopeGraphPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((m: Msg) => this.onMessage(m));
  }

  private onMessage(m: Msg): void {
    switch (m.type) {
      case "ready":
        this.postIndex();
        void this.post();
        break;
      case "select":
        if (m.key) {
          this.select(m.key, true);
          this.picked(m.key);
        }
        break;
      case "seed":
        if (m.key) {
          this.reseed(m.key);
          this.picked(m.key);
        }
        break;
      case "analyze": {
        const e = m.key ? this.byKey.get(m.key) : undefined;
        if (e) {
          this.deps.analyze?.(e);
        }
        break;
      }
      case "reseed":
        if (this.seedKey) {
          this.reseed(this.seedKey);
        }
        break;
      case "open": {
        const e = m.key ? this.byKey.get(m.key) : undefined;
        if (e) {
          this.deps.reveal(e);
        }
        break;
      }
      case "openAt":
        if (m.abs && m.line) {
          this.deps.revealAt(m.abs, m.line);
        }
        break;
      case "back":
        if (this.pos > 0) {
          this.pos--;
          this.goHistory();
        }
        break;
      case "forward":
        if (this.pos < this.history.length - 1) {
          this.pos++;
          this.goHistory();
        }
        break;
      case "depth":
        this.depth = Math.max(1, Math.min(4, m.depth ?? this.depth));
        if (this.seedKey) {
          this.reseed(this.seedKey);
        }
        break;
      case "popout":
        void this.popout();
        break;
    }
  }

  private picked(key: string): void {
    const e = this.byKey.get(key);
    if (e) {
      this.deps.onSelect?.(e);
    }
  }

  /** 패널을 VS Code 별도 창(플로팅 편집기 창, 1.85+)으로 옮긴다 — 웹뷰는 다시 로드되어 ready 로 재요청 */
  private async popout(): Promise<void> {
    this.panel.reveal(undefined, false);
    try {
      await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
    } catch {
      void vscode.window.showInformationMessage(vscode.l10n.t("Scope: this VS Code version cannot open a separate window, so the explorer opens as a tab"));
    }
  }

  // --- 캔버스 상태 ------------------------------------------------------------

  private reindex(): void {
    this.byKey = new Map(this.deps.entries().map((e) => [entryKey(e), e]));
  }

  private reload(): void {
    this.reindex();
    this.canvases.clear();
    this.history = this.history.filter((h) => this.byKey.has(h.key) && this.byKey.has(h.seed));
    this.pos = this.history.length - 1;
    for (const k of [...this.nodes]) {
      if (!this.byKey.has(k)) {
        this.nodes.delete(k);
      }
    }
    // 호출 간선은 새 그래프로 다시 계산, 참조·멤버 간선은 양 끝이 남아 있으면 유지
    for (const [id, e] of [...this.edges]) {
      if (e.kind === "call" || !this.nodes.has(e.source) || !this.nodes.has(e.target)) {
        this.edges.delete(id);
      }
    }
    const graph = this.deps.graph();
    if (graph) {
      for (const k of this.nodes) {
        for (const c of graph.callees(this.byKey.get(k)!)) {
          const t = c.target && entryKey(c.target);
          if (t && this.nodes.has(t)) {
            this.addEdge(k, t, "call", c.how === "guess");
          }
        }
      }
    }
    this.refsDone.clear();
    if (this.selected && !this.byKey.has(this.selected)) {
      this.selected = undefined;
    }
    this.postIndex();
    void this.post();
    if (this.selected) {
      void this.loadRefs(this.selected);
    }
  }

  private goHistory(): void {
    const h = this.history[this.pos];
    if (h.seed !== this.seedKey) {
      this.stash();
      const saved = this.canvases.get(h.seed);
      this.seedKey = h.seed;
      this.nodes = new Set(saved?.nodes);
      this.edges = new Map(saved?.edges);
      this.expanded = new Set(saved?.expanded);
      this.note = "";
    }
    this.select(h.key, false);
  }

  /** 지금 캔버스를 씨앗 이름으로 보관 */
  private stash(): void {
    if (this.seedKey) {
      this.canvases.set(this.seedKey, { nodes: this.nodes, edges: this.edges, expanded: this.expanded });
    }
  }

  private reseed(key: string, post = true): void {
    const seed = this.byKey.get(key);
    const graph = this.deps.graph();
    if (!seed || !graph) {
      return;
    }
    if (key !== this.seedKey) {
      this.stash();
    }
    this.nodes = new Set();
    this.edges = new Map();
    this.expanded = new Set();
    this.seedKey = key;
    this.note = "";
    this.capHit = false;
    const sub = graph.expand(seed, this.depth, SEED_CAP);
    for (const n of sub.nodes) {
      this.nodes.add(entryKey(n));
    }
    for (const e of sub.edges) {
      this.addEdge(e.source, e.target, "call", e.guess);
    }
    if (sub.truncated) {
      this.note = vscode.l10n.t("showing the first {0}", String(SEED_CAP));
    }
    this.select(key, true, post);
  }

  private select(key: string, push: boolean, post = true): void {
    if (!this.byKey.has(key)) {
      return;
    }
    this.selected = key;
    this.nodes.add(key);
    const last = this.history[this.pos];
    if (push && !(last && last.key === key && last.seed === this.seedKey)) {
      this.history = this.history.slice(0, this.pos + 1);
      this.history.push({ key, seed: this.seedKey ?? key });
      this.pos = this.history.length - 1;
    }
    if (!this.expanded.has(key)) {
      this.addNeighbors(key);
    }
    this.applyRefs(key);
    if (post) {
      void this.post();
    }
    void this.loadRefs(key);
  }

  /** 한 노드의 이웃(호출자·호출·클래스↔멤버)을 캔버스에 더한다 */
  private addNeighbors(key: string): void {
    const e = this.byKey.get(key)!;
    const graph = this.deps.graph();
    this.expanded.add(key);
    let added = 0;
    const add = (k: string): boolean => {
      if (this.nodes.has(k)) {
        return true;
      }
      if (this.nodes.size >= CANVAS_CAP) {
        this.note = vscode.l10n.t("canvas limit {0} — some omitted", String(CANVAS_CAP));
        this.capHit = true;
        return false;
      }
      this.nodes.add(k);
      added++;
      return true;
    };
    if (graph) {
      for (const c of graph.callers(e)) {
        const k = c.target && entryKey(c.target);
        if (k && add(k)) {
          this.addEdge(k, key, "call", c.how === "guess");
        }
      }
      for (const c of graph.callees(e)) {
        const k = c.target && entryKey(c.target);
        if (k && add(k)) {
          this.addEdge(key, k, "call", c.how === "guess");
        }
      }
    }
    // 클래스 → 멤버, 메서드 → 소속 클래스 (중첩 함수 <locals> 는 멤버가 아님)
    const q = qualOf(e);
    for (const o of this.byKey.values()) {
      if (o.folderRoot !== e.folderRoot || o.record.file !== e.record.file) {
        continue;
      }
      const oq = qualOf(o);
      const ok = entryKey(o);
      if (e.record.kind === "class" && oq.startsWith(q + ".") && !oq.slice(q.length + 1).includes(".")) {
        if (add(ok)) {
          this.addEdge(key, ok, "member", false);
        }
      } else if (o.record.kind === "class" && q.startsWith(oq + ".") && !q.slice(oq.length + 1).includes(".")) {
        if (add(ok)) {
          this.addEdge(ok, key, "member", false);
        }
      }
    }
    if (added > 0) {
      this.note = vscode.l10n.t("{0} connections added", String(added));
    } else if (!this.capHit) {
      this.note = "";
    }
  }

  private addEdge(source: string, target: string, kind: EdgeKind, guess: boolean): void {
    if (source === target) {
      return;
    }
    const id = (k: EdgeKind) => `${source}\u0001${target}\u0001${k}`;
    // 같은 쌍에 호출 간선이 있으면 참조 간선은 생략 (호출도 참조의 일종)
    if (kind === "ref" && this.edges.has(id("call"))) {
      return;
    }
    if (kind === "call") {
      this.edges.delete(id("ref"));
    }
    this.edges.set(id(kind), { source, target, kind, guess });
  }

  /** 캐시된 참조자를 지금 캔버스에 붙인다 — 그 노드가 캔버스에 있을 때만 (씨앗이 바뀌었으면 건너뜀) */
  private applyRefs(key: string): void {
    const r = this.refsDone.get(key);
    if (!r || !this.nodes.has(key)) {
      return;
    }
    for (const ok of r.owners) {
      if (!this.byKey.has(ok)) {
        continue;
      }
      if (!this.nodes.has(ok)) {
        if (this.nodes.size >= CANVAS_CAP) {
          continue;
        }
        this.nodes.add(ok);
      }
      this.addEdge(ok, key, "ref", false);
    }
  }

  /**
   * 언어 서버 참조 찾기 — 호출이 아닌 참조(콜백 전달, 타입 사용, 상속 등)까지 잡는다.
   * 참조 위치를 감싸는 가장 안쪽 레코드(함수 또는 클래스)를 참조자로 본다.
   */
  private async loadRefs(key: string): Promise<void> {
    if (this.refsDone.has(key) || this.refsPending.has(key)) {
      return;
    }
    const e = this.byKey.get(key);
    if (!e) {
      return;
    }
    this.refsPending.add(key);
    const loose: LooseRef[] = [];
    const owners: string[] = [];
    try {
      const abs = path.normalize(this.deps.absPath(e));
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      const at = namePosition(doc, e);
      if (at) {
        const locs = await Promise.race([
          vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
            "vscode.executeReferenceProvider",
            doc.uri,
            at
          ),
          new Promise<undefined>((r) => setTimeout(() => r(undefined), REF_TIMEOUT_MS)),
        ]);
        const byFile = new Map<string, ScopeEntry[]>();
        for (const o of this.byKey.values()) {
          const p = path.normalize(this.deps.absPath(o));
          if (!byFile.has(p)) {
            byFile.set(p, []);
          }
          byFile.get(p)!.push(o);
        }
        for (const raw of locs ?? []) {
          const uri = "uri" in raw ? raw.uri : raw.targetUri;
          const range = "range" in raw ? raw.range : raw.targetRange;
          const line1 = range.start.line + 1;
          const fsPath = path.normalize(uri.fsPath);
          // 자기 범위 안(정의 자체·재귀)은 제외
          if (fsPath === abs && line1 >= e.record.line && line1 <= e.record.endLine) {
            continue;
          }
          const owner = innermost(byFile.get(fsPath) ?? [], line1);
          if (owner) {
            const ok = entryKey(owner);
            // 자기 안쪽(클래스의 메서드가 자기 클래스를 가리키는 것)은 참조자로 보지 않는다
            const inner = owner.record.file === e.record.file && qualOf(owner).startsWith(qualOf(e) + ".");
            if (ok !== key && !inner) {
              owners.push(ok);
            }
          } else if (uri.scheme === "file") {
            let text = "";
            try {
              text = (await vscode.workspace.openTextDocument(uri)).lineAt(range.start.line).text.trim();
            } catch {
              // 읽을 수 없는 파일은 위치만
            }
            if (IMPORT_LINE.test(text)) {
              continue;
            }
            loose.push({
              abs: uri.fsPath,
              file: vscode.workspace.asRelativePath(uri, false),
              line: line1,
              text: text.slice(0, 120),
            });
          }
        }
      }
    } catch {
      // 언어 서버가 없거나 파일을 못 열면 호출 그래프만으로 표시
    } finally {
      this.refsPending.delete(key);
      this.refsDone.set(key, { owners, loose });
      this.applyRefs(key);
      if (ScopeGraphPanel.current === this) {
        void this.post();
      }
    }
  }

  // --- 웹뷰로 보내기 ------------------------------------------------------------

  private postIndex(): void {
    const items = [...this.byKey.values()]
      .sort(
        (a, b) =>
          a.folderName.localeCompare(b.folderName) ||
          a.record.file.localeCompare(b.record.file) ||
          a.record.line - b.record.line
      )
      .map((e) => ({
        key: entryKey(e),
        name: e.record.name,
        qual: qualOf(e),
        kind: e.record.kind,
        file: e.record.file,
        line: e.record.line,
        folder: e.folderName,
        stale: e.stale || e.missing,
        pending: !!e.pending,
      }));
    void this.panel.webview.postMessage({ type: "index", items });
  }

  /** 소스 영역 — 원문 줄 + (가능하면) 문법 색상 토큰 */
  private async sourceOf(e: ScopeEntry) {
    const src = await readLines(this.deps.absPath(e), e.record.line, e.record.endLine);
    if (!src || !this.deps.highlight) {
      return src;
    }
    const lines = src.text.split("\n").length;
    const hl = await this.deps.highlight(e, src.start, src.start + lines - 1);
    return { ...src, hl: hl && hl.lines.length === lines ? hl : undefined };
  }

  private async post(): Promise<void> {
    const graph = this.deps.graph();
    const k = this.selected;
    const sel = k ? this.byKey.get(k) : undefined;
    if (sel) {
      this.panel.title = `Scope: ${sel.record.name}`;
    }
    const q = (key: string) => qualOf(this.byKey.get(key)!);
    let detail: unknown;
    if (sel && k) {
      const ref = (c: { name: string; target?: ScopeEntry; how?: string }) => ({
        name: c.target ? qualOf(c.target) : c.name,
        key: c.target ? entryKey(c.target) : undefined,
        guess: c.how === "guess",
      });
      const linked = (kind: EdgeKind, end: "source" | "target") =>
        [...this.edges.values()]
          .filter((x) => x.kind === kind && x[end] === k && this.byKey.has(x[end === "source" ? "target" : "source"]))
          .map((x) => {
            const other = end === "source" ? x.target : x.source;
            return { name: q(other), key: other, guess: false };
          });
      detail = {
        key: k,
        qual: qualOf(sel),
        kind: sel.record.kind,
        lang: sel.record.lang,
        file: sel.record.file,
        line: sel.record.line,
        endLine: sel.record.endLine,
        params: sel.record.params ?? [],
        summary: sel.record.summary,
        stale: sel.stale,
        missing: sel.missing,
        pending: !!sel.pending,
        analyzing: !!sel.analyzing,
        model: sel.record.model,
        generatedAt: sel.record.generatedAt,
        canAnalyze: !!this.deps.analyze,
        isSeed: k === this.seedKey,
        callers: graph ? graph.callers(sel).map(ref) : [],
        callees: graph ? graph.callees(sel).map(ref) : [],
        refs: linked("ref", "target"),
        members: linked("member", "source"),
        owner: linked("member", "target"),
        loose: this.refsDone.get(k)?.loose ?? [],
        refsPending: !this.refsDone.has(k),
        source: await this.sourceOf(sel),
      };
    }
    const nodes = [...this.nodes].filter((n) => this.byKey.has(n));
    void this.panel.webview.postMessage({
      type: "state",
      seedKey: this.seedKey,
      selected: k,
      depth: this.depth,
      canBack: this.pos > 0,
      canForward: this.pos < this.history.length - 1,
      note: this.note,
      nodes: nodes.map((n) => {
        const e = this.byKey.get(n)!;
        return {
          key: n,
          name: e.record.name,
          qual: qualOf(e),
          kind: e.record.kind,
          file: e.record.file,
          line: e.record.line,
          summary: e.record.summary,
          stale: e.stale,
          missing: e.missing,
          pending: !!e.pending,
          analyzing: !!e.analyzing,
          expanded: this.expanded.has(n),
        };
      }),
      edges: [...this.edges.values()].filter((x) => this.byKey.has(x.source) && this.byKey.has(x.target)),
      detail,
    });
  }
}

/** 정의 줄(또는 바로 아래 두 줄)에서 심볼 이름이 나오는 위치 */
function namePosition(doc: vscode.TextDocument, e: ScopeEntry): vscode.Position | undefined {
  const name = e.record.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^\\w$])(${name})(?![\\w$])`);
  const from = Math.max(0, e.record.line - 1);
  const to = Math.min(doc.lineCount - 1, e.record.line + 1, e.record.endLine - 1);
  for (let l = from; l <= to; l++) {
    const m = re.exec(doc.lineAt(l).text);
    if (m) {
      return new vscode.Position(l, m.index + m[1].length);
    }
  }
  return undefined;
}

/** line1 을 감싸는 범위가 가장 좁은 레코드 */
function innermost(cands: ScopeEntry[], line1: number): ScopeEntry | undefined {
  let best: ScopeEntry | undefined;
  for (const c of cands) {
    const r = c.record;
    if (line1 >= r.line && line1 <= r.endLine) {
      if (!best || r.endLine - r.line < best.record.endLine - best.record.line) {
        best = c;
      }
    }
  }
  return best;
}

async function readLines(
  abs: string,
  from: number,
  to: number
): Promise<{ start: number; text: string; cut: boolean } | undefined> {
  try {
    const lines = (await fs.readFile(abs, "utf8")).split(/\r?\n/);
    const end = Math.min(to, from + SOURCE_MAX_LINES - 1);
    return { start: from, text: lines.slice(from - 1, end).join("\n"), cut: end < to };
  } catch {
    return undefined;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 웹뷰 스크립트 문구 — 확장 쪽에서 번역해 T 로 넘긴다 */
function webStrings(): Record<string, string> {
  const t = vscode.l10n.t;
  return {
    nodes: t("{0} nodes", "{0}"),
    findingRefs: t("finding references…"),
    findingRefsLong: t("Finding references with the language server…"),
    newShort: t("new"),
    listTip: t("Click: start the graph here · Double-click: open source"),
    moreTip: t("Click to expand this node's callers, calls and references"),
    analyzing: t("analyzing…"),
    notAnalyzed: t("not analyzed — no summary"),
    cardTip: t("Click: select and expand · Double-click: open source"),
    sideEmpty: t("Pick a node in the graph to see its summary here"),
    noSource: t("source missing"),
    newNotAnalyzed: t("new function — not analyzed yet"),
    staleBadge: t("stale — the body changed after analysis"),
    noSummaryPress: t("(no summary — press ✦ Analyze)"),
    noSummary: t("(no summary)"),
    analyze: t("Analyze"),
    analyzeAgain: t("Analyze again"),
    analyzeTip: t("Write a new summary for this item with the selected analysis engine"),
    openSource: t("Open source"),
    startHere: t("Start here"),
    ownerClass: t("Owner class"),
    members: t("Members"),
    callers: t("Callers"),
    calls: t("Calls"),
    noCallers: t("No callers"),
    noCalls: t("Calls no function in the project"),
    referencedBy: t("Referenced by"),
    noRefs: t("No references besides calls (or no language server)"),
    looseTip: t("Reference outside the analysis records (module top level etc.) — click to open"),
    guess: t("guess"),
    external: t("not analyzed · external"),
    linkTip: t("Click: select in the graph · Double-click: open source"),
    srcEmpty: t("Pick a node in the graph to see its source here"),
    srcUnreadable: t("Cannot read the source"),
    grammar: t("Grammar"),
    theme: t("Theme"),
    srcCut: t("… truncated — open the editor for the rest"),
  };
}

/** Webview HTML — 스타일·스크립트 인라인 (nonce), VSCode 테마 변수 사용 */
export function html(nonce: string): string {
  const t = (s: string, ...a: string[]) => escapeHtml(vscode.l10n.t(s, ...a));
  return `<!doctype html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
${STYLE}
</style>
</head>
<body>
<div id="bar">
  <button id="tList" class="tog on" title="${t("Show or hide the source list")}">☰ ${t("List")}</button>
  <button id="back" title="${t("Back")}">◀</button>
  <button id="fwd" title="${t("Forward")}">▶</button>
  <select id="depth" title="${t("Call depth to expand from the seed")}">
    <option value="1">${t("Depth {0}", "1")}</option><option value="2">${t("Depth {0}", "2")}</option>
    <option value="3">${t("Depth {0}", "3")}</option><option value="4">${t("Depth {0}", "4")}</option>
  </select>
  <button id="reseed" title="${t("Redraw from the seed (clears accumulated nodes)")}">${t("Reset")}</button>
  <button id="fit" title="${t("Fit everything")}">${t("Fit")}</button>
  <button id="lineup" class="tog on" title="${t("Line up the selection's callers and callees in one row and move the rest aside")}">${t("Line up")}</button>
  <button id="focus" class="tog on" title="${t("Highlight only what connects to the selection")}">${t("Focus")}</button>
  <span id="title"></span>
  <span id="note"></span>
  <select id="srcPos" title="${t("Source pane position")}">
    <option value="bottom">${t("Source: bottom")}</option><option value="right">${t("Source: right")}</option>
    <option value="left">${t("Source: left")}</option><option value="hidden">${t("Source: hidden")}</option>
  </select>
  <button id="popout" title="${t("Open in a separate window")}">⧉ ${t("New window")}</button>
  <select id="sidePos" title="${t("Summary panel position")}">
    <option value="top">${t("Summary: top")}</option><option value="right">${t("Summary: right")}</option>
    <option value="hidden">${t("Summary: hidden")}</option>
  </select>
</div>
<div id="main">
 <div id="upper">
  <div id="list">
    <input id="q" type="search" placeholder="${t("Search functions, classes, files")}">
    <div id="items"></div>
  </div>
  <div id="canvas">
    <div id="world">
      <svg id="wires"><defs>
        <marker id="a-call" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="m-call" d="M0 0L10 5L0 10z"></path></marker>
        <marker id="a-ref" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="m-ref" d="M0 0L10 5L0 10z"></path></marker>
        <marker id="a-member" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="m-member" d="M0 0L10 5L0 10z"></path></marker>
        <marker id="a-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="m-hot" d="M0 0L10 5L0 10z"></path></marker>
      </defs><g id="paths"></g></svg>
      <div id="cards"></div>
    </div>
    <div id="legend"><span class="lg call">${t("call")}</span><span class="lg ref">${t("reference")}</span><span class="lg member">${t("member")}</span><span class="lg guess">${t("guess")}</span></div>
    <div id="empty">${t("Pick a function or class in the list on the left")}</div>
  </div>
  <div id="side"></div>
 </div>
 <div id="split" title="${t("Drag to resize")}"></div>
 <div id="src">
  <div id="srcHead"><span id="srcTitle"></span><span class="sp"></span>
   <button id="wrap" class="tog" title="${t("Wrap long lines")}">${t("Wrap")}</button>
   <button id="srcOpen" title="${t("Open in the main window editor")}">${t("Open in editor")}</button></div>
  <div id="srcBody"></div>
 </div>
</div>
<script nonce="${nonce}">
const T = ${JSON.stringify(webStrings()).replace(/</g, "\\u003c")};
${SCRIPT}
</script>
</body>
</html>`;
}

const STYLE = String.raw`
:root { color-scheme: light dark; --sel: var(--vscode-focusBorder); --seed: var(--vscode-charts-green);
        --ref: var(--vscode-charts-orange); --member: var(--vscode-charts-blue); --wire: var(--vscode-descriptionForeground); }
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
       color: var(--vscode-foreground); background: var(--vscode-editor-background); overflow: hidden; }
button, select, input { font: inherit; }
#bar { display: flex; gap: 6px; align-items: center; height: 38px; padding: 0 10px; border-bottom: 1px solid var(--vscode-panel-border); }
#bar button, #bar select { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
       border: 1px solid transparent; border-radius: 3px; padding: 2px 8px; cursor: pointer; white-space: nowrap; }
#bar button:disabled { opacity: .4; cursor: default; }
#bar .tog.on { border-color: var(--sel); }
#title { font-weight: 600; margin-left: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
#note { color: var(--vscode-descriptionForeground); margin-left: auto; white-space: nowrap; }
#main { display: flex; height: calc(100vh - 38px); }
#main.pos-bottom { flex-direction: column; }
#upper { display: flex; flex: 1; min-width: 0; min-height: 0; order: 0; }
#split { flex: none; order: 1; background: var(--vscode-panel-border); }
#src { flex: none; order: 2; display: flex; flex-direction: column; min-width: 0; min-height: 0;
       background: var(--vscode-editor-background); }
#main.pos-bottom #split { height: 4px; cursor: row-resize; }
#main.pos-left #split, #main.pos-right #split { width: 4px; cursor: col-resize; }
#main.pos-left #src { order: 0; } #main.pos-left #upper { order: 2; }
#main.pos-hidden #src, #main.pos-hidden #split { display: none; }
#split:hover, #split.drag { background: var(--vscode-sash-hoverBorder, var(--sel)); }
#srcHead { display: flex; align-items: center; gap: 6px; padding: 4px 10px; flex: none;
           border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
#srcHead .sp { flex: 1; }
#srcHead button { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
           border: 1px solid transparent; border-radius: 3px; padding: 1px 8px; cursor: pointer; white-space: nowrap; }
#srcHead button.tog.on { border-color: var(--sel); }
#srcTitle { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
            font-family: var(--vscode-editor-font-family); }
#srcTitle .dim { font-weight: normal; color: var(--vscode-descriptionForeground); margin-left: 8px; }
#srcBody { flex: 1; overflow: auto; padding: 6px 0; font-family: var(--vscode-editor-font-family);
           font-size: var(--vscode-editor-font-size); line-height: 1.5; color: var(--vscode-editor-foreground); }
#srcBody .row { display: flex; }
#srcBody .ln { flex: none; width: 4em; padding-right: 12px; text-align: right; color: var(--vscode-editorLineNumber-foreground); user-select: none; }
#srcBody .code { white-space: pre; tab-size: 4; }
#srcBody.wrap .code { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
#srcBody .cut, #srcBody .none { color: var(--vscode-descriptionForeground); padding: 4px 12px; font-family: var(--vscode-font-family); }
#list { width: 260px; flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--vscode-panel-border);
        background: var(--vscode-sideBar-background); }
#list.hide, #side.hide { display: none; }
#q { margin: 8px; padding: 4px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
     border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
#items { overflow: auto; flex: 1; padding-bottom: 12px; }
.fhead { padding: 4px 8px; font-weight: 600; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fhead .dir { font-weight: normal; color: var(--vscode-descriptionForeground); }
.fhead::before { content: "▾ "; color: var(--vscode-descriptionForeground); }
.fhead.closed::before { content: "▸ "; }
.item { padding: 2px 8px 2px 24px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item:hover { background: var(--vscode-list-hoverBackground); }
.item.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.item .k { display: inline-block; width: 16px; color: var(--vscode-symbolIcon-functionForeground, var(--vscode-charts-purple)); }
.item.class .k { color: var(--vscode-symbolIcon-classForeground, var(--vscode-charts-orange)); }
.item .on { color: var(--sel); margin-left: 4px; }
.item .st { color: var(--vscode-editorWarning-foreground); }
#canvas { flex: 1; position: relative; overflow: hidden; cursor: grab; min-width: 0; }
#canvas.drag { cursor: grabbing; }
#world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
#world.anim { transition: transform .35s ease; }
#wires { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; }
.edge { fill: none; stroke: var(--wire); stroke-width: 1.3; opacity: .6; }
.edge.ref { stroke: var(--ref); stroke-dasharray: 6 4; }
.edge.member { stroke: var(--member); stroke-dasharray: 2 3; }
.edge.guess { stroke-dasharray: 3 3; }
.edge.hot { stroke-width: 2.4; opacity: 1; }
.edge.hot.call { stroke: var(--sel); }
.edge.dim { opacity: .12; }
.m-call { fill: var(--wire); } .m-ref { fill: var(--ref); } .m-member { fill: var(--member); } .m-hot { fill: var(--sel); }
.card { position: absolute; left: 0; top: 0; width: 250px; height: 92px; padding: 7px 9px; border-radius: 7px; cursor: pointer; overflow: hidden;
        background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        transition: opacity .2s; user-select: none; }
.card:hover { border-color: var(--sel); }
.card.seed { border: 1.5px solid var(--seed); }
.card.sel { border: 2px solid var(--sel); }
.card.dim { opacity: .3; }
.card .nm { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card .kb { font-size: .8em; font-weight: normal; padding: 0 4px; border-radius: 3px; margin-right: 4px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
.card .more { float: right; color: var(--sel); font-weight: 700; margin-left: 4px; }
.card .fl { font-size: .85em; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card .sm { font-size: .88em; margin-top: 3px; line-height: 1.35; opacity: .9;
            display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.card .warn { color: var(--vscode-editorWarning-foreground); }
.card .busy, #side .badge.busy { color: var(--vscode-progressBar-background); }
.card .sm.none { font-style: italic; opacity: .6; }
#side .acts button:disabled { opacity: .5; cursor: default; }
#legend { position: absolute; left: 10px; bottom: 8px; display: flex; gap: 12px; font-size: .85em; color: var(--vscode-descriptionForeground); pointer-events: none; }
.lg::before { content: ""; display: inline-block; width: 22px; height: 0; border-top: 2px solid var(--wire); margin-right: 5px; vertical-align: middle; }
.lg.ref::before { border-top: 2px dashed var(--ref); }
.lg.member::before { border-top: 2px dotted var(--member); }
.lg.guess::before { border-top-style: dashed; }
#empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); }
#empty[hidden] { display: none; }
#side { width: 360px; flex: none; border-left: 1px solid var(--vscode-panel-border); padding: 12px; overflow: auto;
        background: var(--vscode-sideBar-background); }
/* 요약 위쪽 배치: 목록은 왼쪽 세로 전체, 요약은 그래프 위 가로 띠 (본문 | 연결 목록 2단) */
#upper.side-top { display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
#upper.side-top #list { grid-column: 1; grid-row: 1 / span 2; }
#upper.side-top #side { grid-column: 2; grid-row: 1; width: auto; max-height: 34vh; border-left: 0;
        border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 24px; align-items: flex-start; }
#upper.side-top #canvas { grid-column: 2; grid-row: 2; }
#upper.side-top #side .sMain { flex: 1 1 45%; min-width: 0; }
#upper.side-top #side .sLinks { flex: 1 1 55%; min-width: 0; column-width: 230px; column-gap: 18px; }
#upper.side-top #side .sLinks h4 { break-after: avoid; }
#upper.side-top #side .sLinks h4:first-child { margin-top: 0; }
#upper.side-top #side .lnk { break-inside: avoid; }
.card.mv { transition: transform .4s ease, opacity .2s; }
#paths.fade { opacity: 0; } #paths { transition: opacity .25s; }
#side h3 { margin: 0 0 4px; font-size: 1.1em; word-break: break-all; font-family: var(--vscode-editor-font-family); }
#side .meta { color: var(--vscode-descriptionForeground); font-size: .9em; margin-bottom: 8px; word-break: break-all; }
#side .badge { display: inline-block; font-size: .85em; padding: 1px 6px; border-radius: 8px; margin: 0 4px 8px 0;
               background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
#side .sum { white-space: pre-wrap; line-height: 1.5; margin-bottom: 10px; padding: 8px; border-radius: 4px;
             background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); }
#side .acts { display: flex; gap: 6px; margin: 8px 0 12px; flex-wrap: wrap; }
#side .acts button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 3px; padding: 3px 10px; cursor: pointer; }
#side .acts button.sec { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
#side h4 { margin: 12px 0 4px; font-size: .95em; color: var(--vscode-descriptionForeground); }
#side .lnk { display: block; padding: 2px 4px; border-radius: 3px; cursor: pointer; word-break: break-all; font-family: var(--vscode-editor-font-family); font-size: .92em; }
#side .lnk:hover { background: var(--vscode-list-hoverBackground); }
#side .lnk.ext { cursor: default; opacity: .55; }
#side .lnk.ext:hover { background: none; }
#side .lnk .tag { font-family: var(--vscode-font-family); font-size: .85em; color: var(--vscode-descriptionForeground); margin-left: 6px; }
#side .muted { color: var(--vscode-descriptionForeground); font-size: .9em; }
#side pre { margin: 6px 0 0; padding: 8px 0; overflow: auto; border-radius: 4px; background: var(--vscode-textCodeBlock-background);
            font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.4; }
#side pre .ln { display: inline-block; width: 3.5em; padding-right: 8px; text-align: right; color: var(--vscode-editorLineNumber-foreground); user-select: none; }
`;

/** Webview 스크립트 — 목록 · 배치 · 렌더 · 상호작용 (DOM 생성은 textContent 로만) */
const SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
const NS = "http://www.w3.org/2000/svg";
const W = 250, H = 92, GX = 110, GY = 22;
/** 집중 배치에서 한 열에 세우는 최대 카드 수 */
const BAND = 3;
const $ = (id) => document.getElementById(id);
const canvas = $("canvas"), world = $("world"), paths = $("paths"), cards = $("cards"), side = $("side");
let index = [], st = null, pos = new Map(), focus = true;
/** 집중 배치에서 선택 노드와 한 줄로 놓인 상위(호출자 쪽)·하위(호출 쪽) 노드 */
let lineage = new Set();
/** 일렬 배치 토글 — 끄면 기존 열 배치 */
let lineup = true;
let view = { x: 40, y: 40, k: 1 };
/** 첫 프레이밍을 했는지 — 이후엔 배율 유지 ("전체" 버튼만 배율을 바꿈) */
let framed = false;
const closed = new Set();
const ui = (() => { try { return vscode.getState() || {}; } catch (e) { return {}; } })();
if (ui.list === false) { $("list").classList.add("hide"); $("tList").classList.remove("on"); }
/** 요약 패널 위치: top(그래프 위, 기본) · right · hidden — 예전 저장값 side:false 는 hidden */
let sidePos = ui.sidePos || (ui.side === false ? "hidden" : "top");
function applySidePos() {
  $("upper").classList.toggle("side-top", sidePos === "top");
  side.classList.toggle("hide", sidePos === "hidden");
  $("sidePos").value = sidePos;
}
applySidePos();
if (ui.lineup === false) { lineup = false; $("lineup").classList.remove("on"); }
// 소스 영역: 위치(아래·오른쪽·왼쪽·숨김), 크기(아래면 높이, 옆이면 너비), 줄바꿈 — 창을 다시 열어도 유지
const srcUi = { pos: ui.srcPos || "bottom", h: ui.srcH || 0, w: ui.srcW || 0, wrap: ui.wrap !== false };
function saveUi() {
  vscode.setState({ list: !$("list").classList.contains("hide"), sidePos, lineup,
    srcPos: srcUi.pos, srcH: srcUi.h, srcW: srcUi.w, wrap: srcUi.wrap });
}
function applySrcLayout() {
  const main = $("main"), src = $("src");
  main.className = "pos-" + srcUi.pos;
  $("srcPos").value = srcUi.pos;
  $("wrap").classList.toggle("on", srcUi.wrap);
  $("srcBody").classList.toggle("wrap", srcUi.wrap);
  const r = main.getBoundingClientRect();
  if (srcUi.pos === "bottom") {
    const hh = Math.max(80, Math.min(srcUi.h || Math.round((r.height || 700) * 0.38), (r.height || 700) - 140));
    if (srcUi.h) srcUi.h = hh;
    src.style.height = hh + "px"; src.style.width = "";
  } else if (srcUi.pos !== "hidden") {
    const ww = Math.max(160, Math.min(srcUi.w || Math.round((r.width || 1200) * 0.38), (r.width || 1200) - 320));
    if (srcUi.w) srcUi.w = ww;
    src.style.width = ww + "px"; src.style.height = "";
  }
}
applySrcLayout();

function h(tag, cls, text, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m.type === "index") { index = m.items; renderList(); return; }
  if (m.type !== "state") return;
  const prevSel = st && st.selected, prevCount = st ? st.nodes.length : 0;
  st = m;
  $("back").disabled = !m.canBack; $("fwd").disabled = !m.canForward;
  $("depth").value = String(m.depth);
  $("reseed").disabled = !m.seedKey;
  $("empty").hidden = m.nodes.length > 0;
  const d = m.detail;
  $("title").textContent = d ? d.qual + "  ·  " + d.file : "";
  $("note").textContent = (m.nodes.length ? T.nodes.replace("{0}", m.nodes.length) : "") + (m.note ? " · " + m.note : "")
    + (d && d.refsPending ? " · " + T.findingRefs : "");
  layout(); render(); renderSide(); renderSource(); markList();
  // 선택이 바뀌었거나 참조가 도착해 노드가 늘면 선택 흐름을 다시 맞춤
  // 처음 한 번만 배율을 정하고, 그다음부터는 사용자가 맞춘 확대·축소를 유지한 채 선택 노드로 이동만
  if (m.selected && (m.selected !== prevSel || m.nodes.length !== prevCount)) {
    if (framed) centerOn(m.selected, true); else { frameFocus(true); framed = true; }
  }
});

// --- 툴바 -------------------------------------------------------------------
$("back").onclick = () => vscode.postMessage({ type: "back" });
$("fwd").onclick = () => vscode.postMessage({ type: "forward" });
$("reseed").onclick = () => vscode.postMessage({ type: "reseed" });
$("fit").onclick = () => fitAll(true);
$("popout").onclick = () => vscode.postMessage({ type: "popout" });
$("depth").onchange = (e) => vscode.postMessage({ type: "depth", depth: Number(e.target.value) });
$("focus").onclick = () => { focus = !focus; $("focus").classList.toggle("on", focus); render(); };
$("lineup").onclick = () => { lineup = !lineup; $("lineup").classList.toggle("on", lineup); saveUi(); layout(); render(); recenter(); };
$("tList").onclick = () => { $("list").classList.toggle("hide"); $("tList").classList.toggle("on"); saveUi(); };
$("srcPos").onchange = (e) => { srcUi.pos = e.target.value; applySrcLayout(); saveUi(); recenter(); };
$("wrap").onclick = () => { srcUi.wrap = !srcUi.wrap; applySrcLayout(); saveUi(); };
$("srcOpen").onclick = () => { if (st && st.detail) vscode.postMessage({ type: "open", key: st.detail.key }); };
let sdrag = null;
$("split").addEventListener("pointerdown", (e) => {
  sdrag = { x: e.clientX, y: e.clientY, h: $("src").getBoundingClientRect().height, w: $("src").getBoundingClientRect().width };
  $("split").classList.add("drag"); $("split").setPointerCapture(e.pointerId); e.preventDefault();
});
$("split").addEventListener("pointermove", (e) => {
  if (!sdrag) return;
  if (srcUi.pos === "bottom") srcUi.h = Math.round(sdrag.h - (e.clientY - sdrag.y));
  else if (srcUi.pos === "right") srcUi.w = Math.round(sdrag.w - (e.clientX - sdrag.x));
  else srcUi.w = Math.round(sdrag.w + (e.clientX - sdrag.x));
  applySrcLayout();
});
$("split").addEventListener("pointerup", () => { if (!sdrag) return; sdrag = null; $("split").classList.remove("drag"); saveUi(); recenter(); });
function recenter() { if (st && st.selected) centerOn(st.selected, false); }
$("sidePos").onchange = (e) => { sidePos = e.target.value; applySidePos(); saveUi(); recenter(); };

// --- 왼쪽 소스 목록 ------------------------------------------------------------
$("q").addEventListener("input", () => renderList());

function renderList() {
  const box = $("items");
  box.textContent = "";
  const q = $("q").value.trim().toLowerCase();
  const multi = new Set(index.map((i) => i.folder)).size > 1;
  let cur = null, body = null;
  for (const it of index) {
    if (q && !(it.qual.toLowerCase().includes(q) || it.file.toLowerCase().includes(q))) continue;
    const fk = it.folder + "/" + it.file;
    if (fk !== cur) {
      cur = fk;
      const slash = it.file.lastIndexOf("/");
      const shut = closed.has(fk) && !q;
      const head = h("div", "fhead" + (shut ? " closed" : ""), null, box);
      h("span", null, it.file.slice(slash + 1), head);
      h("span", "dir", "  " + (multi ? it.folder + "/" : "") + it.file.slice(0, Math.max(0, slash)), head);
      head.title = it.file;
      const b = h("div", null, null, box);
      b.hidden = shut;
      body = b;
      head.onclick = () => {
        if (closed.has(fk)) closed.delete(fk); else closed.add(fk);
        head.classList.toggle("closed"); b.hidden = !b.hidden;
      };
    }
    const nest = (it.qual.match(/\./g) || []).length - (it.qual.match(/<locals>/g) || []).length;
    const row = h("div", "item " + it.kind, null, body);
    row.dataset.key = it.key;
    row.style.paddingLeft = (24 + Math.min(nest, 4) * 12) + "px";
    h("span", "k", it.kind === "class" ? "C" : "ƒ", row);
    h("span", null, it.qual.replace(/\.<locals>\./g, "›"), row);
    if (it.stale) h("span", "st", " ⚠", row);
    if (it.pending) h("span", "st", " " + T.newShort, row);
    h("span", "on", "", row);
    row.title = it.qual + "\n" + it.file + ":" + it.line + "\n" + T.listTip;
    row.onclick = () => vscode.postMessage({ type: "seed", key: it.key });
    row.ondblclick = () => vscode.postMessage({ type: "open", key: it.key });
  }
  markList();
}

function markList() {
  const on = new Set(st ? st.nodes.map((n) => n.key) : []);
  let selRow = null;
  for (const row of document.querySelectorAll(".item")) {
    const k = row.dataset.key;
    const isSel = !!st && k === st.selected;
    row.classList.toggle("sel", isSel);
    row.lastChild.textContent = on.has(k) ? "●" : "";
    if (isSel) selRow = row;
  }
  if (selRow) selRow.scrollIntoView({ block: "nearest" });
}

// --- 배치 -------------------------------------------------------------------------
// 일렬(기본): 선택 노드의 상위 트리(호출자·참조자·소속 클래스, 왼쪽)와 하위 트리(호출·멤버, 오른쪽)를
//   선택 노드가 지나는 가로 한 줄로 세우고, 나머지는 그 아래 흐린 영역으로 보낸다.
// 일렬 끔: 기존처럼 전체를 선택 노드 기준 열(왼쪽 -, 오른쪽 +)로 배치. 집중 버튼은 흐림만 담당.
function layout() {
  const g = columnLayout();
  lineage = new Set();
  pos = lineup && st && st.selected && g.has(st.selected) ? lineageLayout(g) : g;
}

function lineageLayout(g) {
  const sel = st.selected;
  const out = new Map(), inn = new Map(), und = new Map();
  for (const n of st.nodes) { out.set(n.key, []); inn.set(n.key, []); und.set(n.key, []); }
  for (const e of st.edges) {
    if (!out.has(e.source) || !out.has(e.target) || e.source === e.target) continue;
    out.get(e.source).push(e.target); inn.get(e.target).push(e.source);
    und.get(e.source).push(e.target); und.get(e.target).push(e.source);
  }
  const bfs = (adj) => {
    const d = new Map([[sel, 0]]), q = [sel];
    while (q.length) { const k = q.shift(); for (const t of adj.get(k)) if (!d.has(t)) { d.set(t, d.get(k) + 1); q.push(t); } }
    return d;
  };
  const down = bfs(out), up = bfs(inn);
  const level = new Map([[sel, 0]]);
  for (const [k, d] of down) if (k !== sel) level.set(k, d);
  // 위·아래 양쪽에 걸리면(순환) 더 가까운 쪽, 같으면 하위
  for (const [k, d] of up) if (k !== sel && (!level.has(k) || d < level.get(k))) level.set(k, -d);
  lineage = new Set(level.keys());

  const cols = new Map();
  for (const [k, l] of level) { if (!cols.has(l)) cols.set(l, []); cols.get(l).push(k); }
  const order = new Map([[sel, 0]]);
  const byKey = new Map(st.nodes.map((n) => [n.key, n]));
  const place = (l) => {
    const ks = cols.get(l); if (!ks) return;
    const near = l > 0 ? l - 1 : l + 1;
    const bary = (k) => {
      const ps = und.get(k).filter((t) => level.get(t) === near && order.has(t));
      return ps.length ? ps.reduce((s, t) => s + order.get(t), 0) / ps.length : 1e9;
    };
    ks.sort((a, b) => bary(a) - bary(b) || byKey.get(a).qual.localeCompare(byKey.get(b).qual));
    ks.forEach((k, i) => order.set(k, i - (ks.length - 1) / 2));
  };
  const ls = [...cols.keys()];
  for (let l = 1; l <= Math.max(0, ...ls); l++) place(l);
  for (let l = -1; l >= Math.min(0, ...ls); l--) place(l);
  // 한 단계에 카드가 많으면 BAND 줄씩 끊어 옆 열로 — 줄이 위아래로 길어지지 않고 옆으로 자라게
  const p = new Map();
  let minX = 0, maxX = 0, maxY = 0;
  const colX = new Map([[0, 0]]);
  for (const dir of [1, -1]) {
    let x = 0;
    for (let l = dir; cols.has(l); l += dir) {
      const n = Math.ceil(cols.get(l).length / BAND);
      x += dir * (W + GX);
      colX.set(l, x);
      x += dir * (n - 1) * (W + GX / 2);
    }
  }
  for (const [l, ks] of cols) {
    const sorted = [...ks].sort((a, b) => order.get(a) - order.get(b));
    const dir = l < 0 ? -1 : 1;
    sorted.forEach((k, i) => {
      const sub = Math.floor(i / BAND), inSub = Math.min(BAND, sorted.length - sub * BAND);
      const q = { x: colX.get(l) + dir * sub * (W + GX / 2), y: ((i % BAND) - (inSub - 1) / 2) * (H + GY), l };
      p.set(k, q);
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y);
    });
  }
  // 나머지: 줄 아래 격자로 — 원래 열 배치의 왼쪽→오른쪽, 위→아래 순서를 유지해 방향감을 남김
  const others = st.nodes.map((n) => n.key).filter((k) => !lineage.has(k))
    .sort((a, b) => (g.get(a).x - g.get(b).x) || (g.get(a).y - g.get(b).y));
  if (others.length) {
    const span = maxX - minX + W;
    const perRow = Math.max(4, Math.min(others.length, Math.floor((span + GX) / (W + GX / 2))));
    const rows = Math.ceil(others.length / perRow);
    const top = maxY + H + 110;
    others.forEach((k, i) => {
      const r = Math.floor(i / perRow), c = i % perRow;
      const inRow = r === rows - 1 ? others.length - r * perRow : perRow;
      const x0 = (minX + maxX) / 2 - ((inRow - 1) * (W + GX / 2)) / 2;
      p.set(k, { x: x0 + c * (W + GX / 2), y: top + r * (H + GY), l: 0 });
    });
  }
  return p;
}

// 열 배치: 선택 노드를 0열, 호출자·참조자는 왼쪽(-), 호출 대상·멤버는 오른쪽(+)
function columnLayout() {
  const pos = new Map();
  if (!st || !st.nodes.length) return pos;
  const keys = st.nodes.map((n) => n.key);
  const adj = new Map(keys.map((k) => [k, []]));
  for (const e of st.edges) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue;
    adj.get(e.source).push([e.target, 1]);
    adj.get(e.target).push([e.source, -1]);
  }
  const root = st.selected && adj.has(st.selected) ? st.selected : keys[0];
  const level = new Map([[root, 0]]);
  const queue = [root];
  while (queue.length) {
    const k = queue.shift();
    for (const [t, d] of adj.get(k)) if (!level.has(t)) { level.set(t, level.get(k) + d); queue.push(t); }
  }
  let maxL = Math.max(...level.values());
  for (const k of keys) if (!level.has(k)) level.set(k, ++maxL);
  const cols = new Map();
  for (const k of keys) { const l = level.get(k); if (!cols.has(l)) cols.set(l, []); cols.get(l).push(k); }
  const byKey = new Map(st.nodes.map((n) => [n.key, n]));
  const order = new Map();
  const place = (l) => {
    const ks = cols.get(l); if (!ks) return;
    const near = l === 0 ? null : l > 0 ? l - 1 : l + 1;
    const bary = (k) => {
      if (near === null) return k === root ? 0 : 1;
      const ps = adj.get(k).map(([t]) => t).filter((t) => level.get(t) === near && order.has(t));
      return ps.length ? ps.reduce((s, t) => s + order.get(t), 0) / ps.length : 1e9;
    };
    ks.sort((a, b) => bary(a) - bary(b) || byKey.get(a).qual.localeCompare(byKey.get(b).qual));
    if (l === 0) {
      // 선택 노드를 가운데로: 나머지를 위·아래로 번갈아
      const rest = ks.slice(1), mid = [ks[0]];
      rest.forEach((k, i) => (i % 2 ? mid.unshift(k) : mid.push(k)));
      ks.splice(0, ks.length, ...mid);
      const c = ks.indexOf(root);
      ks.forEach((k, i) => order.set(k, i - c));
    } else {
      ks.forEach((k, i) => order.set(k, i - (ks.length - 1) / 2));
    }
  };
  const ls = [...cols.keys()];
  place(0);
  for (let l = 1; l <= Math.max(0, ...ls); l++) place(l);
  for (let l = -1; l >= Math.min(0, ...ls); l--) place(l);
  for (const k of keys) {
    const l = level.get(k);
    pos.set(k, { x: l * (W + GX), y: order.get(k) * (H + GY), l });
  }
  return pos;
}

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent.appendChild(e);
  return e;
}

function neighbours() {
  const s = new Set();
  if (!st || !st.selected) return s;
  s.add(st.selected);
  for (const e of st.edges) {
    if (e.source === st.selected) s.add(e.target);
    if (e.target === st.selected) s.add(e.source);
  }
  return s;
}

/** 직전 렌더의 카드 위치 — 배치가 바뀌면 카드가 미끄러지듯 이동 */
let shown = new Map();
function render() {
  paths.textContent = ""; cards.textContent = "";
  if (!st) return;
  const near = focus && lineage.size ? lineage : neighbours();
  const moving = [];
  for (const e of st.edges) {
    const a = pos.get(e.source), b = pos.get(e.target);
    if (!a || !b) continue;
    const hot = e.source === st.selected || e.target === st.selected;
    let d;
    if (b.x > a.x) {
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2, dx = Math.max(40, (x2 - x1) / 2);
      d = "M" + x1 + " " + y1 + " C" + (x1 + dx) + " " + y1 + " " + (x2 - dx) + " " + y2 + " " + x2 + " " + y2;
    } else if (b.x < a.x) {
      // 역방향 (순환) — 아래로 돌아 들어감
      const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y + H + 2;
      const drop = 50 + Math.abs(a.x - b.x) * 0.12;
      d = "M" + x1 + " " + y1 + " C" + x1 + " " + (Math.max(y1, y2) + drop) + " " + x2 + " " + (Math.max(y1, y2) + drop) + " " + x2 + " " + y2;
    } else {
      // 같은 열 — 오른쪽으로 휘는 호
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x + W + 2, y2 = b.y + H / 2;
      const bulge = 40 + Math.abs(y2 - y1) * 0.25;
      d = "M" + x1 + " " + y1 + " C" + (x1 + bulge) + " " + y1 + " " + (x2 + bulge) + " " + y2 + " " + x2 + " " + y2;
    }
    const inLine = lineage.has(e.source) && lineage.has(e.target);
    const cls = "edge " + e.kind + (e.guess ? " guess" : "") + (hot ? " hot" : focus && st.selected && !inLine ? " dim" : "");
    const marker = hot && e.kind === "call" ? "a-hot" : "a-" + e.kind;
    svgEl("path", { d, class: cls, "marker-end": "url(#" + marker + ")" }, paths);
  }
  for (const n of st.nodes) {
    const p = pos.get(n.key);
    if (!p) continue;
    const c = h("div", "card" + (n.key === st.seedKey ? " seed" : "") + (n.key === st.selected ? " sel" : "")
      + (focus && st.selected && !near.has(n.key) ? " dim" : ""), null, cards);
    const to = "translate(" + p.x + "px," + p.y + "px)", was = shown.get(n.key);
    if (was && was !== to) { c.style.transform = was; moving.push([c, to]); } else c.style.transform = to;
    const nm = h("div", "nm", null, c);
    if (!n.expanded) { const more = h("span", "more", "+", nm); more.title = T.moreTip; }
    if (n.kind === "class") h("span", "kb", "class", nm);
    if (n.analyzing) h("span", "busy", "⟳ ", nm);
    else if (n.stale || n.missing) h("span", "warn", "⚠ ", nm);
    h("span", null, n.name, nm);
    const parent = n.qual.slice(0, Math.max(0, n.qual.length - n.name.length - 1)).replace(/\.<locals>$/, "");
    h("div", "fl", (parent ? parent + " · " : "") + n.file.split("/").pop() + ":" + n.line, c);
    h("div", "sm" + (n.pending ? " none" : ""), n.pending ? (n.analyzing ? T.analyzing : T.notAnalyzed) : n.summary, c);
    c.title = n.qual + "\n" + n.file + ":" + n.line + "\n\n" + n.summary + "\n\n" + T.cardTip;
    c.addEventListener("click", (ev) => { ev.stopPropagation(); vscode.postMessage({ type: "select", key: n.key }); });
    c.addEventListener("dblclick", (ev) => { ev.stopPropagation(); vscode.postMessage({ type: "open", key: n.key }); });
  }
  shown = new Map(st.nodes.filter((n) => pos.has(n.key)).map((n) => [n.key, "translate(" + pos.get(n.key).x + "px," + pos.get(n.key).y + "px)"]));
  if (moving.length) {
    // 카드는 이전 자리에서 새 자리로, 연결선은 이동이 끝난 뒤 나타남
    paths.classList.add("fade");
    void cards.offsetWidth;
    for (const [c, to] of moving) { c.classList.add("mv"); c.style.transform = to; }
    clearTimeout(render.t);
    render.t = setTimeout(() => paths.classList.remove("fade"), 380);
  } else paths.classList.remove("fade");
  applyView(false);
}

// --- 오른쪽 요약 패널 -----------------------------------------------------------
function renderSide() {
  const keepScroll = side.scrollTop, sameKey = side.dataset.key;
  side.textContent = "";
  const d = st && st.detail;
  if (!d) { h("div", "muted", T.sideEmpty, side); return; }
  side.dataset.key = d.key;
  // 본문(제목·요약·버튼)과 연결 목록 — 위쪽 배치에서는 좌우 2단, 오른쪽 배치에서는 위아래
  const top = h("div", "sMain", null, side), links = h("div", "sLinks", null, side);
  h("h3", null, d.qual + (d.kind === "func" ? "(" + d.params.join(", ") + ")" : ""), top);
  h("div", "meta", d.kind + " · " + d.lang + " · " + d.file + ":" + d.line + "–" + d.endLine, top);
  if (d.analyzing) h("span", "badge busy", "⟳ " + T.analyzing, top);
  if (d.missing) h("span", "badge", T.noSource, top);
  else if (d.pending) h("span", "badge", T.newNotAnalyzed, top);
  else if (d.stale) h("span", "badge", T.staleBadge, top);
  h("div", "sum", d.pending ? T.noSummaryPress : d.summary || T.noSummary, top);
  if (d.model && !d.pending) h("div", "muted", d.model + " · " + d.generatedAt, top);
  const acts = h("div", "acts", null, top);
  if (d.canAnalyze && !d.missing) {
    const need = d.stale || d.pending;
    const b = h("button", need ? null : "sec", d.analyzing ? T.analyzing : need ? "✦ " + T.analyze : T.analyzeAgain, acts);
    b.disabled = !!d.analyzing;
    b.title = T.analyzeTip;
    b.onclick = () => vscode.postMessage({ type: "analyze", key: d.key });
  }
  h("button", need0(d) ? "sec" : null, T.openSource, acts).onclick = () => vscode.postMessage({ type: "open", key: d.key });
  if (!d.isSeed) h("button", "sec", T.startHere, acts).onclick = () => vscode.postMessage({ type: "seed", key: d.key });

  if (d.owner.length) group(T.ownerClass, d.owner);
  if (d.members.length) group(T.members + " (" + d.members.length + ")", d.members);
  if (d.kind === "func" || d.callers.length) group("← " + T.callers + " (" + d.callers.length + ")", d.callers, T.noCallers);
  if (d.kind === "func" || d.callees.length) group("→ " + T.calls + " (" + d.callees.length + ")", d.callees, T.noCalls);
  const refHead = T.referencedBy + " (" + (d.refs.length + d.loose.length) + ")";
  if (d.refsPending) { h("h4", null, refHead, links); h("div", "muted", T.findingRefsLong, links); }
  else {
    group(refHead, d.refs, d.loose.length ? null : T.noRefs);
    for (const r of d.loose) {
      const a = h("div", "lnk", r.file + ":" + r.line, links);
      if (r.text) h("span", "tag", r.text, a);
      a.title = T.looseTip;
      a.onclick = () => vscode.postMessage({ type: "openAt", abs: r.abs, line: r.line });
    }
  }
  if (sameKey === d.key) side.scrollTop = keepScroll;

  function group(title, list, emptyText) {
    h("h4", null, title, links);
    if (!list.length) { if (emptyText) h("div", "muted", emptyText, links); return; }
    for (const r of list) {
      const a = h("div", "lnk" + (r.key ? "" : " ext"), r.name, links);
      if (r.guess) h("span", "tag", T.guess, a);
      if (!r.key) { h("span", "tag", T.external, a); continue; }
      a.title = T.linkTip;
      a.onclick = () => vscode.postMessage({ type: "select", key: r.key });
      a.ondblclick = () => vscode.postMessage({ type: "open", key: r.key });
    }
  }
}

function need0(d) { return d.canAnalyze && !d.missing && (d.stale || d.pending); }

// --- 소스 영역 (문법 색상: 확장이 VS Code 와 같은 TextMate 문법·테마로 토큰화해 보냄) ---
let srcKey = null;
function renderSource() {
  const body = $("srcBody"), title = $("srcTitle");
  const d = st && st.detail;
  const keep = d && srcKey === d.key ? body.scrollTop : 0;
  body.textContent = ""; title.textContent = "";
  if (!d) { h("div", "none", T.srcEmpty, body); srcKey = null; return; }
  h("span", null, d.qual, title);
  h("span", "dim", d.file + ":" + d.line + "–" + d.endLine, title);
  const src = d.source;
  if (!src) { h("div", "none", T.srcUnreadable, body); return; }
  const hl = src.hl;
  if (hl) title.title = T.grammar + " " + hl.grammar + " · " + T.theme + " " + hl.theme;
  src.text.split("\n").forEach((line, i) => {
    const row = h("div", "row", null, body);
    h("span", "ln", String(src.start + i), row);
    const code = h("span", "code", null, row);
    const toks = hl && hl.lines[i];
    if (!toks) { code.textContent = line || " "; return; }
    if (!toks.length) code.textContent = " ";
    for (const [text, c, f] of toks) {
      if (!c && !f) { code.appendChild(document.createTextNode(text)); continue; }
      const sp = h("span", null, text, code);
      if (c && hl.colors[c]) sp.style.color = hl.colors[c];
      if (f & 1) sp.style.fontStyle = "italic";
      if (f & 2) sp.style.fontWeight = "bold";
      if (f & 12) sp.style.textDecoration = (f & 4 ? "underline " : "") + (f & 8 ? "line-through" : "");
    }
  });
  if (src.cut) h("div", "cut", T.srcCut, body);
  srcKey = d.key;
  body.scrollTop = keep;
}

// --- 카메라 --------------------------------------------------------------------
function applyView(anim) {
  world.classList.toggle("anim", !!anim);
  world.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.k + ")";
}

function frame(keys, anim, maxK) {
  const ps = keys.map((k) => pos.get(k)).filter(Boolean);
  if (!ps.length) return;
  const minX = Math.min(...ps.map((p) => p.x)) - 30, maxX = Math.max(...ps.map((p) => p.x)) + W + 30;
  const minY = Math.min(...ps.map((p) => p.y)) - 30, maxY = Math.max(...ps.map((p) => p.y)) + H + 60;
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const k = Math.min(maxK, Math.max(0.3, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
  view = { k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k };
  applyView(anim);
}

/** 선택 노드 + 직접 연결을 화면에 맞춤 (너무 작아지지 않게 최소 배율) */
/** 배율(view.k)은 그대로 두고 노드가 화면 가운데 오도록 이동 */
function centerOn(key, anim) {
  const p = pos.get(key);
  if (!p) return;
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  view.x = r.width / 2 - (p.x + W / 2) * view.k;
  view.y = r.height / 2 - (p.y + H / 2) * view.k;
  applyView(anim);
}

function frameFocus(anim) { if (st && st.selected) frame([...neighbours()], anim, 1); }
function fitAll(anim) { if (st) frame(st.nodes.map((n) => n.key), anim, 1.1); }

let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  // 카드 위에서는 드래그를 시작하지 않는다 — 포인터 캡처가 카드 click 을 가로채지 않게
  if (e.target.closest && e.target.closest(".card")) return;
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  canvas.classList.add("drag"); canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  view.x = drag.vx + e.clientX - drag.x; view.y = drag.vy + e.clientY - drag.y; applyView(false);
});
canvas.addEventListener("pointerup", () => { drag = null; canvas.classList.remove("drag"); });
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const k2 = Math.min(3, Math.max(0.1, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  view.x = mx - ((mx - view.x) * k2) / view.k; view.y = my - ((my - view.y) * k2) / view.k; view.k = k2;
  applyView(false);
}, { passive: false });
window.addEventListener("resize", () => { applySrcLayout(); recenter(); });

vscode.postMessage({ type: "ready" });
`;
