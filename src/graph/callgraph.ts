/**
 * callgraph.ts — 레코드의 calls(이름 배열)를 실제 레코드로 잇는 호출 그래프
 *
 * calls 이름을 정밀도 래더로 해석한다.
 * 해석 순서 — 앞 단계에서 결정되면 멈춘다:
 *   0. 한정 호출 접두어(Foo::bar, ns.f, pkg.F)로 후보 좁히기
 *   1. 후보가 하나면 그것
 *   2. 같은 스코프 — 호출자 qual 의 조상(클래스·바깥 함수)에 속한 후보
 *   3. 같은 파일
 *   4. import — 이름 지정 import, 그다음 모듈 전체 import(using / #include / glob)
 *   5. 같은 디렉터리
 *   6. 첫 후보 (추정)
 *
 * import 는 확장이 소스에서 직접 추출하고(imports.ts), 레코드의 imports/ns 와 병합한다.
 * 역방향(호출자)은 로드 시 한 번 계산 — 이름만 같은 게 아니라 호출자 컨텍스트로 해석된 것만.
 * vscode 의존 없음.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ScopeEntry } from "../store";
import {
  EMPTY_INFO,
  extractFileInfo,
  fromRecordImport,
  langKey,
  stripExt,
  type FileInfo,
  type ImportEntry,
} from "./imports";

/** 어느 단계에서 해석됐는지 — guess 는 UI 에 "추정" 으로 표시 */
export type ResolveHow = "qualified" | "unique" | "scope" | "file" | "import" | "dir" | "guess";

export interface CallEdge {
  /** 레코드에 적힌 이름 (calls / calledBy 원문) */
  name: string;
  /** 해석된 레코드. 없으면 프로젝트 밖이거나 아직 분석 안 된 함수 */
  target?: ScopeEntry;
  how?: ResolveHow;
}

export interface Resolution {
  entry: ScopeEntry;
  how: ResolveHow;
}

/** 씨앗 기준 부분 그래프 — 그래프 패널 · Mermaid 공용 */
export interface SubGraph {
  seedKey: string;
  nodes: ScopeEntry[];
  edges: { source: string; target: string; guess: boolean }[];
  truncated: boolean;
}

/** 폴더 + target — 스토어 내부 키와 같은 형식 */
export function entryKey(e: ScopeEntry): string {
  return `${e.folderRoot}\u0000${e.record.target}`;
}

/** target 의 qual 부분 (정규화됨) */
export function qualOf(e: ScopeEntry): string {
  return normalizeQual(e.record.target.split(":").slice(2).join(":"));
}

/** "::" → ".", 레거시 "(outer).inner" → "outer.<locals>.inner" */
export function normalizeQual(q: string): string {
  return q.replace(/::/g, ".").replace(/\(([^()]+)\)\./g, "$1.<locals>.");
}

/** 부모 스코프: "C.m" → "C", "f.<locals>.g" → "f", "f" → "" */
export function parentQual(q: string): string {
  const i = q.lastIndexOf(".");
  if (i < 0) {
    return "";
  }
  const p = q.slice(0, i);
  return p.endsWith(".<locals>") ? p.slice(0, -".<locals>".length) : p;
}

/** 호출 표기 → 이름 + 접두어. "Foo::bar()" → {bar, Foo}, "self.x" → {x, self} */
export function splitCall(call: string): { name: string; hint?: string } {
  const segs = call
    .trim()
    .replace(/^new\s+/, "")
    .replace(/\(.*$/, "")
    .split(/::|->|\./)
    .filter(Boolean);
  const name = segs[segs.length - 1] ?? "";
  return { name, hint: segs.length > 1 ? segs[segs.length - 2] : undefined };
}

/** 다른 모듈의 최상위 함수는 반드시 import 해야 쓸 수 있는 언어 */
const STRICT_IMPORT_LANGS = new Set(["python", "ts", "rust"]);

const SELF_HINTS = new Set(["self", "this", "cls", "super", "base", "Self", "me"]);

/** 고아 판정에서 빼는 진입점 이름 (프레임워크·런타임이 부름) */
const ENTRY_NAMES = new Set([
  "main", "Main", "activate", "deactivate", "constructor", "setUp", "tearDown",
  "Dispose", "ToString", "Equals", "GetHashCode", "toString", "fmt", "drop", "init",
]);

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)(\/|$)|(^|\/)test_[^/]*$|_test\.\w+$|\.(test|spec)\.\w+$|Tests?\.\w+$/i;

function defaultRead(abs: string): string | undefined {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

export class CallGraph {
  /** folderRoot\0name → 후보 (func 먼저, 그다음 파일·줄 순) */
  private byName = new Map<string, ScopeEntry[]>();
  /** folderRoot\0file → 그 파일의 레코드들 */
  private byFile = new Map<string, ScopeEntry[]>();
  private outEdges = new Map<string, CallEdge[]>();
  private inEdges = new Map<string, CallEdge[]>();
  private infoCache = new Map<string, FileInfo>();
  /** folderRoot → 어디서든 호출된 이름 (고아 판정의 보수적 제외용) */
  private usedNames = new Map<string, Set<string>>();

  readonly stats = { calls: 0, resolved: 0, guessed: 0, unresolved: 0 };

  constructor(
    private entries: ScopeEntry[],
    private readFile: (abs: string) => string | undefined = defaultRead
  ) {
    for (const e of entries) {
      // name 필드 대신 qual 마지막 세그먼트로 색인 — name 에 Class.method 를 적은 레코드도 찾게
      push(this.byName, `${e.folderRoot}\u0000${symbolName(e)}`, e);
      push(this.byFile, `${e.folderRoot}\u0000${e.record.file}`, e);
    }
    for (const list of this.byName.values()) {
      list.sort(
        (a, b) =>
          Number(a.record.kind !== "func") - Number(b.record.kind !== "func") ||
          a.record.file.localeCompare(b.record.file) ||
          a.record.line - b.record.line
      );
    }
    this.buildEdges();
  }

  // --- 조회 -----------------------------------------------------------------

  /** 이 함수가 부르는 것들 (calls 순서) */
  callees(e: ScopeEntry): CallEdge[] {
    return this.outEdges.get(entryKey(e)) ?? [];
  }

  /** 이 함수를 부르는 것들 (계산된 역방향 + 에이전트 calledBy) */
  callers(e: ScopeEntry): CallEdge[] {
    return this.inEdges.get(entryKey(e)) ?? [];
  }

  edges(e: ScopeEntry, dir: "out" | "in"): CallEdge[] {
    return dir === "out" ? this.callees(e) : this.callers(e);
  }

  /**
   * 호출자가 없는 함수 — 보수적으로 제외: 클래스 메서드(인터페이스·오버라이드로 불림),
   * 진입점 이름, 테스트, 어디선가 이름이 불린 것, entry:true 레코드
   */
  orphans(folderRoot: string): ScopeEntry[] {
    const used = this.usedNames.get(folderRoot) ?? new Set<string>();
    return this.entries
      .filter((e) => {
        const r = e.record;
        if (e.folderRoot !== folderRoot || r.kind !== "func" || r.entry) {
          return false;
        }
        const name = symbolName(e);
        if (this.callers(e).length > 0 || used.has(name) || isMethod(e)) {
          return false;
        }
        if (/^__\w+__$/.test(name) || ENTRY_NAMES.has(name) || /^test/i.test(name)) {
          return false;
        }
        return !TEST_PATH.test(r.file);
      })
      .sort((a, b) => a.record.file.localeCompare(b.record.file) || a.record.line - b.record.line);
  }

  /**
   * 씨앗의 callee 를 depth 까지 BFS + 씨앗의 직접 호출자 1단계.
   * cap 을 넘으면 truncated.
   */
  expand(seed: ScopeEntry, depth = 3, cap = 60): SubGraph {
    const seedKey = entryKey(seed);
    const nodes = new Map<string, ScopeEntry>([[seedKey, seed]]);
    const edges: SubGraph["edges"] = [];
    const seen = new Set<string>();
    let truncated = false;
    const addEdge = (a: string, b: string, guess: boolean) => {
      const k = `${a}\u0001${b}`;
      if (a !== b && !seen.has(k)) {
        seen.add(k);
        edges.push({ source: a, target: b, guess });
      }
    };

    const frontier: [ScopeEntry, number][] = [[seed, 0]];
    while (frontier.length > 0) {
      const [fn, d] = frontier.shift()!;
      if (d >= depth) {
        continue;
      }
      const fkey = entryKey(fn);
      for (const edge of this.callees(fn)) {
        if (!edge.target) {
          continue;
        }
        const tkey = entryKey(edge.target);
        if (!nodes.has(tkey)) {
          if (nodes.size >= cap) {
            truncated = true;
            continue;
          }
          nodes.set(tkey, edge.target);
          frontier.push([edge.target, d + 1]);
        }
        addEdge(fkey, tkey, edge.how === "guess");
      }
    }

    for (const edge of this.callers(seed)) {
      if (!edge.target) {
        continue;
      }
      const ckey = entryKey(edge.target);
      if (!nodes.has(ckey)) {
        if (nodes.size >= cap) {
          truncated = true;
          break;
        }
        nodes.set(ckey, edge.target);
      }
      addEdge(ckey, seedKey, edge.how === "guess");
    }

    return { seedKey, nodes: [...nodes.values()], edges, truncated };
  }

  // --- 해석 -----------------------------------------------------------------

  /** from 함수 안에서 call 이라는 이름이 가리키는 레코드 */
  resolve(from: ScopeEntry, call: string): Resolution | undefined {
    const { name, hint } = splitCall(call);
    if (!name) {
      return undefined;
    }
    const info = this.fileInfo(from);
    let cands = this.lookup(from.folderRoot, name);
    if (cands.length === 0) {
      // from x import f as g → g() 는 f
      const orig = renamedFrom(info, name);
      if (orig) {
        cands = this.lookup(from.folderRoot, orig);
      }
    }
    cands = cands.filter((c) => c !== from);
    if (cands.length === 0) {
      return undefined;
    }

    // 0. 한정 호출 접두어
    if (hint && !SELF_HINTS.has(hint)) {
      const narrowed = this.narrowByHint(cands, hint, info);
      if (narrowed.length > 0) {
        cands = narrowed;
        if (cands.length === 1) {
          return { entry: cands[0], how: "qualified" };
        }
      }
    }

    // import 없이는 다른 모듈의 최상위 함수를 부를 수 없는 언어(python/ts/rust):
    // 접두어 없는 호출인데 같은 파일·import 어디에도 없으면 같은 모듈의 미분석 함수거나 내장 함수다
    const file = from.record.file;
    if (
      !hint &&
      STRICT_IMPORT_LANGS.has(langKey(from.record.lang, file)) &&
      cands.every((c) => parentQual(qualOf(c)) === "" && c.record.file !== file) &&
      !this.pickByImports(cands, info, name)
    ) {
      return undefined;
    }

    // 명시 import 가 이 이름을 다른 모듈에서 가져오는데 후보 중 맞는 게 없으면
    // 진짜 대상은 아직 분석 안 됐거나 프로젝트 밖 — 동명 함수로 잇지 않는다
    if (this.importPointsElsewhere(cands, info, name)) {
      return undefined;
    }

    // 1. 유일
    if (cands.length === 1) {
      return { entry: cands[0], how: "unique" };
    }

    // 2. 같은 스코프 — 가까운 조상부터
    for (let p = parentQual(qualOf(from)); p; p = parentQual(p)) {
      const hit = cands.find((c) => c.record.file === file && parentQual(qualOf(c)) === p);
      if (hit) {
        return { entry: hit, how: "scope" };
      }
    }

    // 3. 같은 파일
    const sameFile = cands.find((c) => c.record.file === file);
    if (sameFile) {
      return { entry: sameFile, how: "file" };
    }

    // 4. import
    const viaImport = this.pickByImports(cands, info, name);
    if (viaImport) {
      return { entry: viaImport, how: "import" };
    }

    // 5. 같은 디렉터리
    const dir = path.posix.dirname(file);
    const sameDir = cands.filter((c) => path.posix.dirname(c.record.file) === dir);
    if (sameDir.length > 0) {
      return { entry: sameDir[0], how: sameDir.length === 1 ? "dir" : "guess" };
    }

    // 6. 첫 후보
    return { entry: cands[0], how: "guess" };
  }

  /** 파일의 import / namespace — 소스 추출 + 레코드 imports·ns 병합 (파일당 1회) */
  fileInfo(e: ScopeEntry): FileInfo {
    const key = `${e.folderRoot}\u0000${e.record.file}`;
    const cached = this.infoCache.get(key);
    if (cached) {
      return cached;
    }
    const text = this.readFile(path.join(e.folderRoot, e.record.file));
    const base = text === undefined ? EMPTY_INFO : extractFileInfo(text, e.record.lang, e.record.file);
    const imports: ImportEntry[] = [...base.imports];
    const namespaces = new Set(base.namespaces);
    for (const r of this.byFile.get(key) ?? []) {
      for (const imp of r.record.imports ?? []) {
        imports.push(...fromRecordImport(imp, r.record.lang, r.record.file));
      }
      if (r.record.ns) {
        namespaces.add(r.record.ns.replace(/::/g, "."));
      }
    }
    const info: FileInfo = { imports, namespaces: [...namespaces] };
    this.infoCache.set(key, info);
    return info;
  }

  private lookup(folderRoot: string, name: string): ScopeEntry[] {
    return this.byName.get(`${folderRoot}\u0000${name}`) ?? [];
  }

  /** 접두어로 후보 좁히기: 클래스명 → import 별칭 → 모듈(파일명)·namespace·패키지 */
  private narrowByHint(cands: ScopeEntry[], hint: string, info: FileInfo): ScopeEntry[] {
    const byClass = cands.filter((c) => lastSeg(parentQual(qualOf(c))) === hint);
    if (byClass.length > 0) {
      return byClass;
    }
    const aliased = info.imports.filter((imp) => imp.local === hint);
    if (aliased.length > 0) {
      const scored = cands
        .map((c) => ({ c, s: Math.max(...aliased.map((imp) => this.matchScore(imp, c))) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      if (scored.length > 0) {
        return scored.map((x) => x.c);
      }
    }
    return cands.filter((c) => {
      const f = c.record.file;
      if (path.posix.basename(stripExt(f)) === hint) {
        return true;
      }
      if (langKey(c.record.lang, f) === "go" && path.posix.basename(path.posix.dirname(f)) === hint) {
        return true;
      }
      return this.namespacesOf(c).some((ns) => ns === hint || ns.endsWith("." + hint));
    });
  }

  /** import 단계: 이름 지정 import 먼저, 그다음 모듈 전체 import. 점수가 높은 후보 */
  private pickByImports(cands: ScopeEntry[], info: FileInfo, localName: string): ScopeEntry | undefined {
    const named = info.imports.filter((imp) => imp.names?.includes(localName));
    const wild = info.imports.filter((imp) => !imp.names && !imp.qualifiedOnly);
    for (const group of [named, wild]) {
      let best: ScopeEntry | undefined;
      let bestScore = 0;
      for (const c of cands) {
        for (const imp of group) {
          const s = this.matchScore(imp, c);
          if (s > bestScore) {
            best = c;
            bestScore = s;
          }
        }
      }
      if (best) {
        return best;
      }
    }
    return undefined;
  }

  /** name 을 명시적으로 import 했는데 그 import 가 어느 후보도 가리키지 않음 */
  private importPointsElsewhere(cands: ScopeEntry[], info: FileInfo, localName: string): boolean {
    const named = info.imports.filter((imp) => imp.names?.includes(localName) && imp.module);
    if (named.length === 0) {
      return false;
    }
    return !cands.some((c) => named.some((imp) => this.matchScore(imp, c) > 0));
  }

  /** import 1건이 후보 레코드를 가리키는 정도. 0 = 아님, 클수록 구체적 */
  private matchScore(imp: ImportEntry, cand: ScopeEntry): number {
    if (!imp.module) {
      return 0;
    }
    if (imp.kind === "namespace") {
      const cls = parentQual(qualOf(cand));
      for (const ns of this.namespacesOf(cand)) {
        if (cls && `${ns}.${cls}` === imp.module) {
          return 3; // using static A.B.C / import a.b.C
        }
        if (ns === imp.module) {
          return 2; // using A.B / using namespace X
        }
      }
      // qual 에 namespace 를 포함해 기록한 경우 (A.B.C.m)
      if (cls && (cls === imp.module || cls.startsWith(imp.module + "."))) {
        return 2;
      }
      return 0;
    }
    const keys = candKeys(cand);
    const file = stripExt(cand.record.file);
    if (imp.exact) {
      if (keys.includes(imp.module)) {
        return 100;
      }
      // 디렉터리를 import (index.ts / __init__.py / mod.rs 재수출) — 그 아래 파일
      return file.startsWith(imp.module + "/") ? 50 : 0;
    }
    // 접미 경로 매칭: 길게 맞을수록 높은 점수 (app/services/audit > audit)
    const segs = imp.module.split("/").filter((s) => s && s !== "." && s !== "..");
    for (let k = segs.length; k >= 1; k--) {
      const suffix = segs.slice(-k).join("/");
      if (keys.some((key) => key === suffix || key.endsWith("/" + suffix))) {
        return k;
      }
      // 재수출 디렉터리 아래 파일 — 같은 길이의 직접 일치보다 낮게
      if (file.startsWith(suffix + "/") || file.includes("/" + suffix + "/")) {
        return k - 0.5;
      }
    }
    return 0;
  }

  private namespacesOf(e: ScopeEntry): string[] {
    return this.fileInfo(e).namespaces;
  }

  // --- 구축 -----------------------------------------------------------------

  private buildEdges(): void {
    for (const e of this.entries) {
      const used = this.usedNames.get(e.folderRoot) ?? new Set<string>();
      this.usedNames.set(e.folderRoot, used);
      if (e.record.kind !== "func") {
        // 클래스 레코드의 calls 는 간선으로 쓰지 않지만 "어디선가 불린 이름" 에는 넣는다
        for (const call of e.record.calls ?? []) {
          used.add(splitCall(call).name);
        }
        continue;
      }
      const fkey = entryKey(e);
      const out: CallEdge[] = [];
      const seen = new Set<string>();
      for (const call of e.record.calls ?? []) {
        this.stats.calls++;
        const { name } = splitCall(call);
        used.add(name);
        const r = this.resolve(e, call);
        if (!r) {
          this.stats.unresolved++;
          if (!seen.has(`?${name}`)) {
            seen.add(`?${name}`);
            out.push({ name: call });
          }
          continue;
        }
        this.stats.resolved++;
        if (r.how === "guess") {
          this.stats.guessed++;
        }
        const tkey = entryKey(r.entry);
        if (seen.has(tkey)) {
          continue;
        }
        seen.add(tkey);
        out.push({ name: call, target: r.entry, how: r.how });
        push(this.inEdges, tkey, { name: e.record.name, target: e, how: r.how });
      }
      this.outEdges.set(fkey, out);
    }

    // 에이전트 calledBy — 계산된 역방향에 없는 것만 보탠다 (callee 위치에서 해석)
    for (const e of this.entries) {
      const names = e.record.calledBy;
      if (!names || names.length === 0) {
        continue;
      }
      const key = entryKey(e);
      const list = this.inEdges.get(key) ?? [];
      for (const callerName of names) {
        const { name } = splitCall(callerName);
        if (list.some((x) => (x.target ? symbolName(x.target) : x.name) === name)) {
          continue;
        }
        const r = this.resolve(e, callerName);
        if (r && !list.some((x) => x.target === r.entry)) {
          list.push({ name: callerName, target: r.entry, how: r.how });
        } else if (!r) {
          list.push({ name: callerName });
        }
      }
      this.inEdges.set(key, list);
    }
  }
}

/** 후보 파일이 매칭될 수 있는 경로 키: 확장자 없는 경로 (+ index/mod/__init__ 는 디렉터리, Go 는 패키지 디렉터리) */
function candKeys(e: ScopeEntry): string[] {
  const f = e.record.file;
  const noExt = stripExt(f);
  const keys = [noExt];
  const base = path.posix.basename(noExt);
  if (["index", "__init__", "mod", "lib", "main"].includes(base) || langKey(e.record.lang, f) === "go") {
    keys.push(path.posix.dirname(f));
  }
  return keys;
}

function renamedFrom(info: FileInfo, local: string): string | undefined {
  for (const imp of info.imports) {
    const orig = imp.renames?.[local];
    if (orig) {
      return orig;
    }
  }
  return undefined;
}

/** 심볼 이름 = qual 의 마지막 세그먼트 (규약). name 필드가 틀려도 target 기준 */
export function symbolName(e: ScopeEntry): string {
  return lastSeg(qualOf(e)) || e.record.name;
}

/** 클래스에 속한 메서드인가 — 중첩 함수(outer.<locals>.inner)는 아님 */
function isMethod(e: ScopeEntry): boolean {
  const q = qualOf(e);
  const i = q.lastIndexOf(".");
  return i >= 0 && !q.slice(0, i).endsWith(".<locals>");
}

function lastSeg(q: string): string {
  const i = q.lastIndexOf(".");
  return i < 0 ? q : q.slice(i + 1);
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) {
    list.push(v);
  } else {
    m.set(k, [v]);
  }
}

/** 부분 그래프 → Mermaid flowchart (씨앗 강조, 추정 간선은 점선) */
export function toMermaid(sub: SubGraph): string {
  const index = new Map<string, number>();
  const lines = ["flowchart LR"];
  sub.nodes.forEach((n, i) => {
    const key = entryKey(n);
    index.set(key, i);
    const clean = (t: string) => t.replace(/[[\]"\n|<>{}]/g, " ");
    const label = clean(qualOf(n) || n.record.name).slice(0, 48);
    const file = clean(path.posix.basename(n.record.file));
    lines.push(`    N${i}["${label}<br/><small>${file}</small>"]`);
  });
  for (const e of sub.edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a !== undefined && b !== undefined) {
      lines.push(`    N${a} ${e.guess ? "-.->" : "-->"} N${b}`);
    }
  }
  const seed = index.get(sub.seedKey);
  if (seed !== undefined) {
    lines.push(`    style N${seed} stroke-width:3px`);
  }
  return lines.join("\n");
}
