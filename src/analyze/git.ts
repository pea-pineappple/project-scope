/**
 * git.ts — 내장 git 확장(vscode.git) API 로 변경 파일 목록과 HEAD 이동을 본다
 *
 * git 은 "가속·보강" 용도: 바뀐 파일만 다시 스캔하고(기록 없는 새 파일 포함),
 * 브랜치 전환·pull·commit 으로 HEAD 가 움직이면 구조 갱신을 예약한다.
 * 변경 판정 자체는 srcHash 가 하므로 git 저장소가 아니어도 확장은 그대로 동작한다.
 */
import * as vscode from "vscode";

/** 분석 대상 소스 확장자 — 빌드 산출물·의존성·.scope 는 제외 */
export const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|cs|cpp|cc|cxx|c|h|hpp|hh|hxx|rs|go|java|kt|kts|swift|rb|php|scala|dart)$/i;
export const IGNORED_PATH = /[\\/](node_modules|out|dist|build|target|bin|obj|\.git|\.scope|\.venv|venv|__pycache__)[\\/]/;

/* vscode.git API 중 쓰는 부분만 (git.d.ts 를 번들하지 않음) */
interface Change {
  uri: vscode.Uri;
}
interface RepoState {
  HEAD?: { commit?: string; name?: string };
  workingTreeChanges: Change[];
  indexChanges: Change[];
  mergeChanges: Change[];
  untrackedChanges?: Change[];
  onDidChange: vscode.Event<void>;
}
interface Repository {
  rootUri: vscode.Uri;
  state: RepoState;
}
interface GitApi {
  repositories: Repository[];
  onDidOpenRepository: vscode.Event<Repository>;
}

export class GitWatch implements vscode.Disposable {
  private api: GitApi | undefined;
  private subs: vscode.Disposable[] = [];
  private heads = new Map<string, string | undefined>();

  /** onHeadChange: 어느 저장소든 HEAD 커밋·브랜치가 바뀌면 호출 */
  constructor(private onHeadChange: (repoRoot: string) => void) {}

  async start(): Promise<boolean> {
    try {
      const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>("vscode.git");
      if (!ext) {
        return false;
      }
      const exp = ext.isActive ? ext.exports : await ext.activate();
      this.api = exp.getAPI(1);
    } catch {
      return false;
    }
    for (const r of this.api.repositories) {
      this.watch(r);
    }
    this.subs.push(this.api.onDidOpenRepository((r) => this.watch(r)));
    return true;
  }

  private watch(repo: Repository): void {
    const root = repo.rootUri.fsPath;
    this.heads.set(root, headKey(repo));
    this.subs.push(
      repo.state.onDidChange(() => {
        const now = headKey(repo);
        if (now !== this.heads.get(root)) {
          this.heads.set(root, now);
          this.onHeadChange(root);
        }
      })
    );
  }

  get available(): boolean {
    return !!this.api && this.api.repositories.length > 0;
  }

  /** 작업 트리·스테이지·병합·추적 안 됨 변경 중 소스 파일 절대경로 */
  changedFiles(): string[] {
    const out = new Set<string>();
    for (const r of this.api?.repositories ?? []) {
      const s = r.state;
      for (const c of [...s.workingTreeChanges, ...s.indexChanges, ...s.mergeChanges, ...(s.untrackedChanges ?? [])]) {
        const p = c.uri.fsPath;
        if (SOURCE_FILE.test(p) && !IGNORED_PATH.test(p)) {
          out.add(p);
        }
      }
    }
    return [...out];
  }

  dispose(): void {
    for (const s of this.subs) {
      s.dispose();
    }
    this.subs = [];
  }
}

function headKey(repo: Repository): string | undefined {
  const h = repo.state.HEAD;
  return h ? `${h.name ?? ""}@${h.commit ?? ""}` : undefined;
}
