/**
 * lens.ts — CodeLens: 요약 / Flow / Callers / Graph
 *
 * 레코드의 line 위치에 4개 액션 제공.
 * 명령은 extension.ts 에서 register.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type { ScopeStore } from "../store";

export class ScopeCodeLensProvider implements vscode.CodeLensProvider {
  private onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChange.event;

  constructor(private store: ScopeStore) {}

  notify(): void {
    this.onDidChange.fire();
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    // 문서가 속한 워크스페이스 폴더 기준 상대경로로 정규화 (멀티루트)
    const root = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!root) {
      return [];
    }
    const folderRoot = root.uri.fsPath;

    const relPath = toWorkspaceRelative(document.uri, folderRoot);
    const lenses: vscode.CodeLens[] = [];

    for (const entry of this.store.all()) {
      const rec = entry.record;
      // 동일 폴더 + 동일 상대경로 매칭 — 다른 폴더의 같은 경로 레코드와 구분
      if (
        entry.folderRoot !== folderRoot ||
        rec.file !== relPath ||
        rec.kind !== "func"
      ) {
        continue;
      }
      const range = lineRange(document, rec.line);
      if (!range) {
        continue;
      }
      const args = [rec.target];
      if ((entry.stale || entry.pending) && !entry.missing) {
        lenses.push(
          new vscode.CodeLens(range, {
            command: "projectScope.analyze",
            title: entry.analyzing
              ? `⟳ ${vscode.l10n.t("analyzing")}`
              : entry.pending
                ? `✦ ${vscode.l10n.t("Analyze (new)")}`
                : `✦ ${vscode.l10n.t("Analyze again (changed)")}`,
            arguments: args,
          })
        );
      }
      lenses.push(
        new vscode.CodeLens(range, {
          command: "projectScope.showSummary",
          title: vscode.l10n.t("Summary"),
          arguments: args,
        }),
        new vscode.CodeLens(range, {
          command: "projectScope.showFlow",
          title: "Flow",
          arguments: args,
        }),
        new vscode.CodeLens(range, {
          command: "projectScope.showCallers",
          title: "Callers",
          arguments: args,
        }),
        new vscode.CodeLens(range, {
          command: "projectScope.showGraph",
          title: "Graph",
          arguments: args,
        })
      );
    }
    return lenses;
  }
}

/** 1-based 줄 → 해당 줄 범위 */
function lineRange(doc: vscode.TextDocument, line1: number): vscode.Range | undefined {
  const line = line1 - 1;
  if (line < 0 || line >= doc.lineCount) {
    return undefined;
  }
  return new vscode.Range(line, 0, line, 0);
}

/** 파일 URI → 워크스페이스 상대경로 ("/" 구분, 규약 형식) */
export function toWorkspaceRelative(uri: vscode.Uri, rootFsPath: string): string {
  const rel = path.relative(rootFsPath, uri.fsPath);
  return rel.split(path.sep).join("/");
}
