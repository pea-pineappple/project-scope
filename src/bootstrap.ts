/**
 * bootstrap.ts — 프로젝트 루트에 분석 규약(AGENTS.md) 설치
 *
 * resources/AGENTS.md 템플릿을 워크스페이스 루트로 복사한다.
 * - 대상 파일이 이미 있으면 덮어쓰지 않고 안내만 (사용자 규약 존중)
 * - 템플릿은 확장 번들 resources/AGENTS.md (vsce 패키징에 포함)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

/** 확장 번들에서 규약 템플릿 절대경로 — VS Code UI 언어가 한국어면 한국어 판 */
export function resolveTemplatePath(extensionUri: vscode.Uri): string {
  const lang = (vscode.env.language || "").toLowerCase();
  const name = lang.startsWith("ko") ? "AGENTS.ko.md" : "AGENTS.md";
  return path.join(extensionUri.fsPath, "resources", name);
}

/** 기본(영어) 템플릿 경로 — 선호 언어 템플릿 누락 시 대체 */
function fallbackTemplatePath(extensionUri: vscode.Uri): string {
  return path.join(extensionUri.fsPath, "resources", "AGENTS.md");
}

/**
 * 규약 설치 실행. 워크스페이스 루트가 없거나 템플릿 누락 시 사용자에게 안내.
 * @returns 설치 결과 메시지 (이미 존재/성공/실패)
 */
export async function bootstrapConvention(
  extensionUri: vscode.Uri
): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t("Scope: open a workspace folder first")
    );
    return "no workspace";
  }

  const template = resolveTemplatePath(extensionUri);
  let body: string;
  try {
    body = fs.readFileSync(template, "utf8");
  } catch {
    // 선호 언어 템플릿이 번들에 없으면 기본(영어) 템플릿으로 대체
    try {
      body = fs.readFileSync(fallbackTemplatePath(extensionUri), "utf8");
    } catch {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Scope: cannot read the contract template — {0}", template)
      );
      return "template missing";
    }
  }

  const dest = path.join(root.uri.fsPath, "AGENTS.md");
  if (fs.existsSync(dest)) {
    const overwrite = vscode.l10n.t("Overwrite");
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t("Scope: AGENTS.md already exists. Overwrite it?"),
      { modal: true },
      overwrite
    );
    if (pick !== overwrite) {
      return "already exists (kept)";
    }
  }

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, "utf8");
  } catch (e) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Scope: failed to write AGENTS.md — {0}", String(e))
    );
    return "write failed";
  }

  void vscode.window.showInformationMessage(
    vscode.l10n.t("Scope: AGENTS.md installed — give this file to your agent as context")
  );
  return "installed";
}
