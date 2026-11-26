/**
 * store.ts — analysis.jsonl 인메모리 인덱스
 *
 * 규약(AGENTS.md):
 * - 1줄 = 분석 1건, append-only
 * - 동일 target 재기록 시 마지막 레코드가 최신
 * - malformed 줄은 skip (조용히 무시)
 * - {"deleted": true} 줄은 그 target 을 지운다 (함수가 소스에서 사라졌을 때)
 *
 * 멀티루트: 워크스페이스 폴더별 jsonl 을 병합해 하나의 인덱스로 관리한다.
 * 내부 키는 폴더루트+target 조합 — 다른 폴더의 동일 target 도 공존한다.
 * 동일 폴더 내 재기록은 기존과 같이 last-wins.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { checkFreshness } from "./freshness";

/** 단일 분석 레코드 — 규약 스키마 그대로 */
export interface ScopeRecord {
  v: number;
  /** "<kind>:<file>:<qual>" 유니크 키 */
  target: string;
  kind: "func" | "class";
  /** qual 의 마지막 세그먼트 */
  name: string;
  /** 워크스페이스 상대경로 (/ 구분자) */
  file: string;
  /** 1-based 시작줄 */
  line: number;
  /** 1-based 끝줄 (inclusive) */
  endLine: number;
  lang: string;
  /** 본문(line..endLine 원문) sha1 앞 16자 */
  srcHash: string;
  summary: string;
  params?: string[];
  calls?: string[];
  calledBy?: string[];
  model?: string;
  /** ISO 8601 UTC */
  generatedAt: string;
  /** (선택) 파일의 import 목록 — 동명 함수 해석용. 확장의 소스 추출 결과와 병합된다 */
  imports?: RecordImport[];
  /** (선택) 레코드가 속한 namespace / package / module ("." 구분) */
  ns?: string;
  /** (선택) 프레임워크·외부에서 호출되는 진입점 — 고아 판정에서 제외 */
  entry?: boolean;
}

/** 에이전트가 기록하는 import 1건 */
export interface RecordImport {
  /** 모듈 경로(./util, app.services.audit, crate::net) 또는 namespace(System.Linq) */
  module: string;
  /** 가져온 이름들. 없으면 모듈 전체 */
  names?: string[];
  /** 모듈 별칭 (import * as ns, using X = A.B) */
  alias?: string;
}

/** 레코드 + 신선도 상태 + 소속 폴더 묶음 (뷰에서 바로 쓰게) */
export interface ScopeEntry {
  record: ScopeRecord;
  /** srcHash 재계산 결과: true 면 본문이 변경됨 */
  stale: boolean;
  /** 소스 파일을 찾지 못했거나 읽기 실패 */
  missing: boolean;
  /** 레코드가 속한 워크스페이스 폴더 이름 (트리 최상위 그룹 라벨) */
  folderName: string;
  /** 레코드가 속한 워크스페이스 폴더 절대경로 (freshness/reveal 기준) */
  folderRoot: string;
  /** 소스에는 있지만 아직 요약이 없는 함수 — 갱신(구조 추출)이 만든 임시 항목, jsonl 에는 없음 */
  pending?: boolean;
  /** 지금 LLM 요약이 진행 중 */
  analyzing?: boolean;
}

/** 삭제 표시 줄이면 target, 아니면 null — {"v":1,"target":"…","deleted":true,"generatedAt":"…"} */
function parseTombstone(text: string): string | null {
  if (!text.includes('"deleted"')) {
    return null;
  }
  try {
    const o = JSON.parse(text.trim()) as Record<string, unknown>;
    return o.deleted === true && typeof o.target === "string" ? o.target : null;
  } catch {
    return null;
  }
}

/** jsonl 한 줄을 ScopeRecord 로. malformed 시 null */
function parseLine(text: string): ScopeRecord | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  // 필수 필드 검증 — 부족하면 skip
  if (
    o.v !== 1 ||
    typeof o.target !== "string" ||
    (o.kind !== "func" && o.kind !== "class") ||
    typeof o.name !== "string" ||
    typeof o.file !== "string" ||
    typeof o.line !== "number" ||
    typeof o.endLine !== "number" ||
    typeof o.lang !== "string" ||
    typeof o.srcHash !== "string" ||
    typeof o.summary !== "string" ||
    typeof o.generatedAt !== "string"
  ) {
    return null;
  }
  return {
    v: 1,
    target: o.target,
    kind: o.kind,
    name: o.name,
    file: o.file,
    line: o.line,
    endLine: o.endLine,
    lang: o.lang,
    srcHash: o.srcHash,
    summary: o.summary,
    params: strArr(o.params),
    calls: strArr(o.calls),
    calledBy: strArr(o.calledBy),
    model: typeof o.model === "string" ? o.model : undefined,
    generatedAt: o.generatedAt,
    imports: importArr(o.imports),
    ns: typeof o.ns === "string" && o.ns ? o.ns : undefined,
    entry: o.entry === true ? true : undefined,
  };
}

/** imports 필드: 문자열("app.x") 또는 {module, names?, alias?} 배열. 잘못된 항목은 skip */
function importArr(v: unknown): RecordImport[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: RecordImport[] = [];
  for (const x of v) {
    if (typeof x === "string" && x) {
      out.push({ module: x });
      continue;
    }
    if (typeof x !== "object" || x === null) {
      continue;
    }
    const o = x as Record<string, unknown>;
    if (typeof o.module !== "string" || !o.module) {
      continue;
    }
    out.push({
      module: o.module,
      names: strArr(o.names),
      alias: typeof o.alias === "string" && o.alias ? o.alias : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const arr = v.filter((x): x is string => typeof x === "string");
  return arr.length > 0 ? arr : undefined;
}

/** 워크스페이스 폴더 최소 정보 — vscode 의존 없이 주입받는다 */
export interface FolderRef {
  name: string;
  fsPath: string;
}

/**
 * 분석 인덱스 — 폴더별 target last-wins 병합.
 * 파싱/신선도 계산을 담당하고 뷰는 읽기만 한다.
 */
export class ScopeStore {
  /** folderRoot+target -> 마지막 레코드 */
  private records = new Map<string, ScopeRecord>();
  /** folderRoot+target -> 소속 폴더 메타 */
  private owners = new Map<string, { folderName: string; folderRoot: string }>();
  /** folderRoot+target -> 신선도 상태 */
  private status = new Map<string, { stale: boolean; missing: boolean }>();
  /** folderRoot+target -> 구조 추출로 찾은 새 함수 (요약 전). 같은 target 레코드가 생기면 가려진다 */
  private pending = new Map<string, { rec: ScopeRecord; folderName: string; folderRoot: string }>();
  /** folderRoot+target — 분석 진행 중 */
  private busy = new Set<string>();

  /** 내부 키: 폴더루트 + target. 다른 폴더의 동일 target 공존 허용 */
  private static keyOf(folderRoot: string, target: string): string {
    return `${folderRoot}\u0000${target}`;
  }

  /**
   * 여러 워크스페이스 폴더의 jsonl 을 읽어 인덱스를 다시 만든다.
   * 폴더에 jsonl 이 없으면(예: hub anchor 임시폴더) 조용히 스킵.
   * 항상 마지막 레코드가 이긴다(폴더 내 기준).
   */
  loadAll(folders: FolderRef[], jsonlPathOf: (folder: FolderRef) => string): void {
    this.records.clear();
    this.owners.clear();
    this.status.clear();
    for (const folder of folders) {
      const jsonlPath = jsonlPathOf(folder);
      let text: string;
      try {
        text = fs.readFileSync(jsonlPath, "utf8");
      } catch {
        continue; // 파일 없음 — 이 폴더는 스킵 (anchor 폴더 등)
      }
      for (const line of text.split("\n")) {
        const gone = parseTombstone(line);
        if (gone) {
          const key = ScopeStore.keyOf(folder.fsPath, gone);
          this.records.delete(key);
          this.owners.delete(key);
          continue;
        }
        const rec = parseLine(line);
        if (!rec) {
          continue; // malformed skip
        }
        const key = ScopeStore.keyOf(folder.fsPath, rec.target);
        this.records.set(key, rec);
        this.owners.set(key, { folderName: folder.name, folderRoot: folder.fsPath });
      }
    }
    this.refreshFreshness();
  }

  /** freshness 재계산 — 각 레코드의 folderRoot 기준으로 파일 해시 검증 */
  refreshFreshness(): void {
    for (const [key, rec] of this.records) {
      const owner = this.owners.get(key);
      const root = owner?.folderRoot ?? "";
      this.status.set(key, checkFreshness(root, rec));
    }
  }

  all(): ScopeEntry[] {
    const out: ScopeEntry[] = [];
    for (const key of this.records.keys()) {
      out.push(this.buildEntry(key)!);
    }
    for (const key of this.pending.keys()) {
      if (!this.records.has(key)) {
        out.push(this.buildEntry(key)!);
      }
    }
    return out;
  }

  /** 구조 추출로 찾은 새 함수 목록을 통째로 바꾼다 */
  setPending(list: { rec: ScopeRecord; folderName: string; folderRoot: string }[]): void {
    this.pending.clear();
    for (const p of list) {
      this.pending.set(ScopeStore.keyOf(p.folderRoot, p.rec.target), p);
    }
  }

  setBusy(folderRoot: string, target: string, on: boolean): void {
    const key = ScopeStore.keyOf(folderRoot, target);
    if (on) {
      this.busy.add(key);
    } else {
      this.busy.delete(key);
    }
  }

  /** 폴더루트 + target 으로 조회 — lens/hover 가 folderRoot 매칭에 쓴다 */
  getInFolder(folderRoot: string, target: string): ScopeEntry | undefined {
    const key = ScopeStore.keyOf(folderRoot, target);
    return this.buildEntry(key);
  }

  /** target 만으로 조회 — 다른 폴더 동일 target 은 임의 하나. showFlow/showCallers 용 */
  get(target: string): ScopeEntry | undefined {
    for (const [key, rec] of this.records) {
      if (rec.target === target) {
        return this.buildEntry(key);
      }
    }
    for (const [key, p] of this.pending) {
      if (p.rec.target === target) {
        return this.buildEntry(key);
      }
    }
    return undefined;
  }

  private buildEntry(key: string): ScopeEntry | undefined {
    const rec = this.records.get(key);
    if (!rec) {
      const p = this.pending.get(key);
      if (!p) {
        return undefined;
      }
      return {
        record: p.rec,
        stale: false,
        missing: false,
        folderName: p.folderName,
        folderRoot: p.folderRoot,
        pending: true,
        analyzing: this.busy.has(key) || undefined,
      };
    }
    const st = this.status.get(key);
    const owner = this.owners.get(key);
    return {
      record: rec,
      stale: st?.stale ?? false,
      missing: st?.missing ?? false,
      folderName: owner?.folderName ?? "",
      folderRoot: owner?.folderRoot ?? "",
      analyzing: this.busy.has(key) || undefined,
    };
  }

  /** 레코드가 속한 폴더의 절대경로 + 상대경로로 소스 파일 위치 확정 */
  resolveAbs(record: ScopeRecord, folderRoot: string): string {
    return path.join(folderRoot, record.file);
  }

  count(): { analyzed: number; stale: number; pending: number; busy: number } {
    let stale = 0;
    for (const st of this.status.values()) {
      if (st.stale) {
        stale++;
      }
    }
    let pending = 0;
    for (const key of this.pending.keys()) {
      if (!this.records.has(key)) {
        pending++;
      }
    }
    return { analyzed: this.records.size, stale, pending, busy: this.busy.size };
  }
}
