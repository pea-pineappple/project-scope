/**
 * tree.ts — Project Scope TreeView
 *
 * 계층(멀티루트): 폴더 그룹 > 디렉터리 > 파일 > class/func
 * - 최상위 폴더 노드는 레코드가 하나라도 있는 workspace folder 만 (hub anchor 자동 제외)
 * - 폴더 안에서는 기존 계층 유지: 디렉터리는 file 경로에서 유도 (접힌 그룹)
 * - 심볼은 qual 부모 기준으로 중첩: class > method, 함수 > 중첩 함수(outer.<locals>.inner)
 * - 함수를 펼치면 "→ 호출" / "← 호출자" 그룹 — 같은 방향으로 재귀 펼침 (호출 트리)
 *   순환은 ↻ 로 멈추고, 미분석·외부 호출은 회색 leaf, 추정 해석은 "추정" 표시
 * - 폴더 루트 끝에 "호출자 없음" 그룹 (고아 후보)
 * - stale 이면 ⚠ 뱃지, description 에 lang·상태
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type { ScopeEntry } from "../store";
import {
  entryKey,
  parentQual,
  qualOf,
  type CallEdge,
  type CallGraph,
} from "../graph/callgraph";

export type TreeNode =
  | FolderNode
  | DirNode
  | FileNode
  | SymbolNode
  | CallGroupNode
  | CallNode
  | OrphanGroupNode
  | MessageNode;

/** 워크스페이스 폴더 그룹 노드 — 멀티루트 최상위 */
export interface FolderNode {
  kind: "folder";
  /** 폴더 절대경로 — 하위 조회 시 이 폴더의 레코드만 */
  folderRoot: string;
  /** workspace folder name — 트리 라벨 */
  label: string;
}

/** 디렉터리 그룹 노드 */
export interface DirNode {
  kind: "dir";
  /** 소속 폴더루트 */
  folderRoot: string;
  /** 폴더룰 기준 디렉터리 상대경로 ("/" 구분). 루트는 "" */
  dir: string;
  label: string;
}

/** 파일 노드 — 하위에 심볼 */
export interface FileNode {
  kind: "file";
  folderRoot: string;
  file: string;
  label: string;
}

/** class/func 심볼 노드 */
export interface SymbolNode {
  kind: "symbol";
  entry: ScopeEntry;
  /** 고아 목록처럼 파일 밖에서 보일 때 description 에 파일 경로 */
  showFile?: boolean;
}

/** 함수 아래 "→ 호출" / "← 호출자" 그룹 */
export interface CallGroupNode {
  kind: "callGroup";
  dir: "out" | "in";
  entry: ScopeEntry;
}

/** 호출 트리의 한 칸 — path 는 루트부터의 entryKey 들 (순환 판정) */
export interface CallNode {
  kind: "call";
  dir: "out" | "in";
  edge: CallEdge;
  path: string[];
}

/** 폴더 루트 끝의 "호출자 없음" 그룹 */
export interface OrphanGroupNode {
  kind: "orphans";
  folderRoot: string;
  entries: ScopeEntry[];
}

/** 안내 메시지 노드 — 레코드 없음 등 */
export interface MessageNode {
  kind: "message";
  label: string;
}

export class ScopeTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChange = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(
    private getEntries: () => ScopeEntry[],
    private getGraph: () => CallGraph | undefined,
    /** 호출 트리 최대 펼침 깊이 (설정 projectScope.callTreeMaxDepth) */
    private getMaxDepth: () => number
  ) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(el: TreeNode): vscode.TreeItem {
    switch (el.kind) {
      case "message": {
        const item = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "scopeMessage";
        return item;
      }
      case "folder": {
        const item = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "scopeFolder";
        item.tooltip = el.folderRoot;
        return item;
      }
      case "dir": {
        const item = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "scopeDir";
        return item;
      }
      case "file": {
        const item = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "scopeFile";
        return item;
      }
      case "orphans": {
        const item = new vscode.TreeItem(vscode.l10n.t("No callers"), vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${el.entries.length}`;
        item.iconPath = new vscode.ThemeIcon("question");
        item.tooltip =
          vscode.l10n.t("Functions with no caller found in the project (orphan candidates).") +
          "\n" +
          vscode.l10n.t("Entry-point names, tests, names used somewhere and entry:true records are excluded.");
        item.contextValue = "scopeOrphans";
        return item;
      }
      case "callGroup":
        return this.callGroupItem(el);
      case "call":
        return this.callItem(el);
      case "symbol":
        return this.symbolItem(el);
    }
  }

  getChildren(el?: TreeNode): TreeNode[] {
    const entries = this.getEntries();
    if (!el) {
      if (entries.length === 0) {
        return [
          messageNode(vscode.l10n.t("No analysis records")),
          messageNode(vscode.l10n.t("Check .scope/analysis.jsonl or run Scope: Analyze")),
        ];
      }
      const folders = folderRootsOf(entries);
      if (folders.size === 1) {
        // 단일 폴더 — 폴더 레벨 생략하고 기존 계층(dir>file>symbol)을 바로 보여준다
        const only = [...folders.keys()][0];
        return this.folderRoots(entries, only);
      }
      return [...folders.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([folderRoot, name]) => ({ kind: "folder", folderRoot, label: name }));
    }
    switch (el.kind) {
      case "folder":
        return this.folderRoots(entries, el.folderRoot);
      case "dir":
        return buildRoots(inFolder(entries, el.folderRoot), el.folderRoot, el.dir);
      case "file":
        return buildSymbols(inFolder(entries, el.folderRoot), el.file);
      case "symbol":
        return this.symbolChildren(el.entry, entries);
      case "callGroup":
        return this.edgesOf(el.entry, el.dir).map((edge) => ({
          kind: "call",
          dir: el.dir,
          edge,
          path: [entryKey(el.entry)],
        }));
      case "call":
        return this.callChildren(el);
      case "orphans":
        return el.entries.map((e) => ({ kind: "symbol", entry: e, showFile: true }));
      default:
        return []; // message
    }
  }

  // --- 폴더 루트 ------------------------------------------------------------

  /** 폴더 최상위: 디렉터리·파일 + (있으면) 호출자 없음 그룹 */
  private folderRoots(entries: ScopeEntry[], folderRoot: string): TreeNode[] {
    const nodes = buildRoots(inFolder(entries, folderRoot), folderRoot);
    const orphans = this.getGraph()?.orphans(folderRoot) ?? [];
    if (orphans.length > 0) {
      nodes.push({ kind: "orphans", folderRoot, entries: orphans });
    }
    return nodes;
  }

  // --- 심볼 -----------------------------------------------------------------

  private symbolItem(el: SymbolNode): vscode.TreeItem {
    const entry = el.entry;
    const rec = entry.record;
    const state = entry.analyzing
      ? vscode.l10n.t("analyzing")
      : entry.missing
        ? "missing"
        : entry.pending
          ? vscode.l10n.t("new · not analyzed")
          : entry.stale
            ? "stale"
            : "ok";
    const label = entry.stale || entry.missing ? `⚠ ${rec.name}` : rec.name;
    const hasChildren = this.symbolChildren(entry, this.getEntries()).length > 0;
    const item = new vscode.TreeItem(
      label,
      hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.description = el.showFile
      ? `${rec.file}:${rec.line}`
      : `${rec.kind} · ${rec.lang} · ${state}`;
    item.tooltip = summaryTooltip(entry);
    item.iconPath = entry.analyzing
      ? new vscode.ThemeIcon("sync~spin")
      : new vscode.ThemeIcon(
          rec.kind === "class" ? "symbol-class" : "symbol-method",
          entry.pending ? new vscode.ThemeColor("disabledForeground") : undefined
        );
    item.contextValue = rec.kind === "class" ? "scopeSymbolClass" : "scopeSymbolFunc";
    item.command = revealCommand(entry);
    return item;
  }

  /** 심볼 아래: 중첩 심볼(메서드·중첩 함수) + 함수면 호출/호출자 그룹 */
  private symbolChildren(entry: ScopeEntry, entries: ScopeEntry[]): TreeNode[] {
    const nodes: TreeNode[] = nestedOf(entry, entries).map((e) => ({ kind: "symbol", entry: e }));
    if (entry.record.kind !== "func") {
      return nodes;
    }
    if (this.edgesOf(entry, "out").length > 0) {
      nodes.push({ kind: "callGroup", dir: "out", entry });
    }
    if (this.edgesOf(entry, "in").length > 0) {
      nodes.push({ kind: "callGroup", dir: "in", entry });
    }
    return nodes;
  }

  // --- 호출 트리 ------------------------------------------------------------

  private edgesOf(entry: ScopeEntry, dir: "out" | "in"): CallEdge[] {
    return this.getGraph()?.edges(entry, dir) ?? [];
  }

  private callGroupItem(el: CallGroupNode): vscode.TreeItem {
    const n = this.edgesOf(el.entry, el.dir).length;
    const item = new vscode.TreeItem(
      el.dir === "out" ? vscode.l10n.t("→ Calls") : vscode.l10n.t("← Callers"),
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.description = `${n}`;
    item.tooltip =
      el.dir === "out"
        ? vscode.l10n.t("Functions {0} calls — expand to follow what they call", el.entry.record.name)
        : vscode.l10n.t("Functions that call {0} — expand to follow their callers", el.entry.record.name);
    item.contextValue = "scopeCallGroup";
    return item;
  }

  private callItem(el: CallNode): vscode.TreeItem {
    const target = el.edge.target;
    if (!target) {
      const item = new vscode.TreeItem(el.edge.name, vscode.TreeItemCollapsibleState.None);
      item.description = vscode.l10n.t("not analyzed · external");
      item.iconPath = new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
      item.tooltip = vscode.l10n.t("Name not found in the analysis records — outside the project or not analyzed yet");
      item.contextValue = "scopeCallExternal";
      return item;
    }
    const rec = target.record;
    const cycle = el.path.includes(entryKey(target));
    const atLimit = el.path.length >= this.getMaxDepth();
    const more = !cycle && this.edgesOf(target, el.dir).length > 0;
    const prefix = cycle ? "↻ " : target.stale || target.missing ? "⚠ " : "";
    const item = new vscode.TreeItem(
      prefix + rec.name,
      more && !atLimit ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    const notes = [`${rec.file}:${rec.line}`];
    if (el.edge.how === "guess") {
      notes.push(vscode.l10n.t("guess"));
    }
    if (cycle) {
      notes.push(vscode.l10n.t("cycle"));
    } else if (more && atLimit) {
      notes.push(vscode.l10n.t("… depth limit"));
    }
    item.description = notes.join(" · ");
    item.iconPath = new vscode.ThemeIcon(
      cycle ? "sync" : el.dir === "out" ? "arrow-small-right" : "arrow-small-left"
    );
    const tip = summaryTooltip(target);
    if (el.edge.how === "guess") {
      tip.appendMarkdown("\n\n_" + vscode.l10n.t("Several functions share this name, so the link is a guess — imports in the record make it exact") + "_");
    }
    item.tooltip = tip;
    item.contextValue = "scopeCallFunc";
    item.command = revealCommand(target);
    return item;
  }

  private callChildren(el: CallNode): TreeNode[] {
    const target = el.edge.target;
    if (!target) {
      return [];
    }
    const key = entryKey(target);
    if (el.path.includes(key) || el.path.length >= this.getMaxDepth()) {
      return [];
    }
    const path2 = [...el.path, key];
    return this.edgesOf(target, el.dir).map((edge) => ({ kind: "call", dir: el.dir, edge, path: path2 }));
  }
}

/** 툴팁: 이름·종류·요약·모델 */
function summaryTooltip(entry: ScopeEntry): vscode.MarkdownString {
  const rec = entry.record;
  const body = entry.pending
    ? "_" + vscode.l10n.t("New function — no summary yet. Right-click › Scope: Analyze (or click it when auto-analyze is on)") + "_"
    : rec.summary + (entry.stale ? "\n\n_⚠ " + vscode.l10n.t("The body changed after analysis — the summary describes the old code") + "_" : "");
  return new vscode.MarkdownString(
    `**${rec.name}** (${rec.kind}, ${rec.lang})\n\n${body}` + (rec.model && !entry.pending ? `\n\n---\nmodel: ${rec.model}` : "")
  );
}

/** 클릭 시 해당 줄로 이동 — folderRoot 기준 절대경로 */
function revealCommand(entry: ScopeEntry): vscode.Command {
  return {
    command: "projectScope.reveal",
    title: vscode.l10n.t("Open in source"),
    // folderRoot·target 은 클릭 시 자동 분석(onClick) 용
    arguments: [path.join(entry.folderRoot, entry.record.file), entry.record.line, entry.folderRoot, entry.record.target],
  };
}

/** 특정 폴더의 레코드만 — folderRoot 기준 필터 */
function inFolder(entries: ScopeEntry[], folderRoot: string): ScopeEntry[] {
  return entries.filter((e) => e.folderRoot === folderRoot);
}

/** 레코드가 있는 워크스페이스 폴더들: folderRoot -> 표시 이름 */
function folderRootsOf(entries: ScopeEntry[]): Map<string, string> {
  const folders = new Map<string, string>();
  for (const e of entries) {
    if (!folders.has(e.folderRoot)) {
      folders.set(e.folderRoot, e.folderName || path.basename(e.folderRoot));
    }
  }
  return folders;
}

/** 폴더 루트: 디렉터리 그룹 (파일이 루트에 바로 있으면 루트 파일도) */
function buildRoots(
  entries: ScopeEntry[],
  folderRoot: string,
  underDir?: string
): TreeNode[] {
  const dirs = new Map<string, TreeNode>();
  // file 경로 -> 노드. 한 파일에 레코드가 여러 개여도 파일 노드는 하나
  const rootFiles = new Map<string, TreeNode>();

  for (const e of entries) {
    // 폴더룰 한정 — 호출부에서 이미 필터됐지만 이중 안전
    if (e.folderRoot !== folderRoot) {
      continue;
    }
    const file = e.record.file;
    const parent = path.posix.dirname(file); // "." 이면 루트
    const dirKey = parent === "." ? "" : parent;

    // underDir 가 지정되면 그 하위만
    if (underDir !== undefined) {
      if (dirKey !== underDir && !dirKey.startsWith(underDir + "/")) {
        continue;
      }
    }

    // 루트 레벨 구성: 최상위 dir 또는 루트 파일
    if (underDir === undefined) {
      if (dirKey === "") {
        addFile(rootFiles, e);
      } else {
        const top = dirKey.split("/")[0];
        if (!dirs.has(`top:${e.folderRoot}:${top}`)) {
          dirs.set(`top:${e.folderRoot}:${top}`, { kind: "dir", folderRoot: e.folderRoot, dir: top, label: top });
        }
      }
    } else {
      // 하위 디렉터리 탐색: underDir 바로 아래의 파일/서브디렉터리
      const rel = dirKey === underDir ? "" : dirKey.slice(underDir.length + 1);
      if (rel === "") {
        addFile(rootFiles, e);
      } else {
        // rel 은 디렉터리 경로 — 첫 세그먼트가 underDir 바로 아래 서브디렉터리
        const label = rel.split("/")[0];
        const next = underDir + "/" + label;
        const key = "sub:" + next;
        if (!dirs.has(key)) {
          dirs.set(key, {
            kind: "dir",
            folderRoot: e.folderRoot,
            dir: next,
            label,
          });
        }
      }
    }
  }

  const byLabel = (a: TreeNode, b: TreeNode) =>
    (a as DirNode | FileNode).label.localeCompare((b as DirNode | FileNode).label);
  const dirNodes = [...dirs.values()].sort(byLabel);
  const fileNodes = [...rootFiles.values()].sort(byLabel);
  return [...dirNodes, ...fileNodes];
}

/** 파일 노드 중복 방지 — 같은 file 은 한 번만 등록 */
function addFile(files: Map<string, TreeNode>, e: ScopeEntry): void {
  if (!files.has(e.record.file)) {
    files.set(e.record.file, fileNode(e));
  }
}

function fileNode(e: ScopeEntry): FileNode {
  return {
    kind: "file",
    folderRoot: e.folderRoot,
    file: e.record.file,
    label: path.posix.basename(e.record.file),
  };
}

/** 파일 아래 최상위 심볼: qual 부모가 같은 파일에 레코드로 없는 것들 (줄 순) */
function buildSymbols(entries: ScopeEntry[], file: string): TreeNode[] {
  const mine = entries.filter((e) => e.record.file === file);
  const quals = new Set(mine.map((e) => qualOf(e)));
  return mine
    .filter((e) => !quals.has(parentQual(qualOf(e))))
    .sort((a, b) => a.record.line - b.record.line)
    .map((e) => ({ kind: "symbol", entry: e }));
}

/** 같은 파일에서 qual 부모가 entry 인 심볼들 — class 의 메서드, 함수의 중첩 함수 */
function nestedOf(entry: ScopeEntry, entries: ScopeEntry[]): ScopeEntry[] {
  const q = qualOf(entry);
  return entries
    .filter(
      (e) =>
        e !== entry &&
        e.folderRoot === entry.folderRoot &&
        e.record.file === entry.record.file &&
        parentQual(qualOf(e)) === q
    )
    .sort((a, b) => a.record.line - b.record.line);
}

/** 안내 메시지 노드 (비상태 표시용) */
function messageNode(text: string): TreeNode {
  return { kind: "message", label: text };
}
