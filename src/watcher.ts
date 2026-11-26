/**
 * watcher.ts — .scope/analysis.jsonl 감시
 *
 * 에이전트가 append 하면 store 갱신 + 뷰 refresh.
 * fs.watch 기반 (vscode.Workspace watcher 는 파일 내용 변경 이벤트가 제한적)
 * 짧은 시간 다중 이벤트는 debounce 로 묶는다.
 *
 * 멀티루트: 워크스페이스 폴더별로 감시한다. 폴더가 추가/제거되면
 * watcher 재구성(onDidChangeWorkspaceFolders)에서 재생성한다.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const DEBOUNCE_MS = 300;

export interface ScopeWatcher {
  dispose(): void;
}

/**
 * jsonl 파일 하나 감시. 변경 시 onChange 콜백 호출.
 * 파일이 아직 없어도 디렉터리를 감시해 생성을 잡는다.
 */
function watchSingle(jsonlAbs: string, onChange: () => void): ScopeWatcher | undefined {
  const dir = path.dirname(jsonlAbs);
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;

  const schedule = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed) {
        onChange();
      }
    }, DEBOUNCE_MS);
  };

  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, (_event, filename) => {
      // 파일명 필터: jsonl 본문만. null 이면 안전하게 전부 재검사
      if (filename === null || filename === path.basename(jsonlAbs)) {
        schedule();
      }
    });
  } catch {
    // 감시 대상 디렉터리 부재 — 이 폴더는 감시 없이 수동 refresh만
    return undefined;
  }

  return {
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
      }
      watcher?.close();
    },
  };
}

/** 여러 폴더의 jsonl 을 한 번에 감시하는 매니저 */
export class MultiScopeWatcher implements ScopeWatcher {
  private singles: ScopeWatcher[] = [];

  constructor(
    private folders: { fsPath: string }[],
    private jsonlPathOf: (folder: { fsPath: string }) => string,
    private onChange: () => void
  ) {
    this.start();
  }

  /** 현재 폴더 목록으로 감시를 다시 건다 (폴더 교체/추가 대응) */
  restart(folders: { fsPath: string }[]): void {
    this.disposeAll();
    this.folders = folders;
    this.start();
  }

  private start(): void {
    for (const folder of this.folders) {
      const single = watchSingle(this.jsonlPathOf(folder), this.onChange);
      if (single) {
        this.singles.push(single);
      }
    }
  }

  private disposeAll(): void {
    for (const s of this.singles) {
      s.dispose();
    }
    this.singles = [];
  }

  dispose(): void {
    this.disposeAll();
  }
}

/** jsonl 절대경로 계산 — 설정 projectScope.jsonlPath (워크스페이스 상대, 폴더별 스코프) */
export function resolveJsonlPath(root: vscode.WorkspaceFolder): string {
  const cfg = vscode.workspace.getConfiguration("projectScope", root.uri);
  const rel = cfg.get<string>("jsonlPath", ".scope/analysis.jsonl");
  return path.join(root.uri.fsPath, rel);
}
