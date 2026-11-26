/**
 * hover.ts — 함수 위 요약 Hover
 *
 * 레코드 line 위치에 진입하면 summary + 메타 표시.
 */
import * as vscode from "vscode";
import type { ScopeStore } from "../store";
import { toWorkspaceRelative } from "./lens";

export class ScopeHoverProvider implements vscode.HoverProvider {
  constructor(private store: ScopeStore) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.Hover | undefined {
    const root = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!root) {
      return undefined;
    }
    const folderRoot = root.uri.fsPath;
    const relPath = toWorkspaceRelative(document.uri, folderRoot);

    // 커서 줄에 시작하는 심볼 매칭 (레코드 line = 정의 시작줄) — 동일 폴더 한정
    for (const entry of this.store.all()) {
      const rec = entry.record;
      if (entry.folderRoot !== folderRoot || rec.file !== relPath) {
        continue;
      }
      const startLine = rec.line - 1;
      if (position.line < startLine || position.line > Math.min(rec.endLine - 1, startLine + 2)) {
        continue;
      }
      const md = new vscode.MarkdownString();
      md.isTrusted = true;
      md.appendMarkdown(`### ${rec.name}`);
      md.appendText(
        `  (${rec.kind} · ${rec.lang}${entry.analyzing ? ` · ${vscode.l10n.t("analyzing")}` : entry.pending ? ` · ${vscode.l10n.t("new function")}` : entry.stale ? " · ⚠ stale" : ""})\n\n`
      );
      if (entry.pending) {
        md.appendMarkdown(`_${vscode.l10n.t("No summary yet")}_ — [✦ ${vscode.l10n.t("Analyze")}](command:projectScope.analyze?${encodeURIComponent(JSON.stringify([rec.target]))})`);
      } else {
        md.appendMarkdown(rec.summary);
        if (entry.stale && !entry.analyzing) {
          md.appendMarkdown(
            `\n\n_⚠ ${vscode.l10n.t("The body changed after analysis")}_ — [✦ ${vscode.l10n.t("Analyze again")}](command:projectScope.analyze?${encodeURIComponent(JSON.stringify([rec.target]))})`
          );
        }
      }
      if (rec.params && rec.params.length > 0) {
        md.appendText(`\n\nparams: ${rec.params.join(", ")}`);
      }
      if (rec.calls && rec.calls.length > 0) {
        md.appendText(`\n\ncalls: ${rec.calls.join(", ")}`);
      }
      if (rec.calledBy && rec.calledBy.length > 0) {
        md.appendText(`\n\ncalledBy: ${rec.calledBy.join(", ")}`);
      }
      if (rec.model) {
        md.appendText(`\n\n---\nmodel: ${rec.model}`);
      }
      const line = Math.max(0, startLine);
      return new vscode.Hover(md, new vscode.Range(line, 0, line, 200));
    }
    return undefined;
  }
}
