/**
 * imports.ts — 소스 파일의 import / namespace 경량 추출
 *
 * 호출 해석 래더의 import 단계(같은 이름 함수가 여러 파일에 있을 때 어느 쪽인지)에 쓴다.
 * 확장은 분석을 하지 않지만 원본 소스는 직접 읽는다 — import 줄은 정규식으로 충분히 뽑힌다.
 * 에이전트가 레코드에 imports / ns 를 주면 callgraph 에서 이 결과와 병합된다.
 *
 * 지원: python, typescript/javascript, csharp, c/cpp, rust, go, java/kotlin
 */
import * as path from "node:path";

/** path: 파일 경로 조각으로 매칭. namespace: 선언된 namespace/package 로 매칭 */
export type ImportKind = "path" | "namespace";

export interface ImportEntry {
  /** path: "/" 구분 경로 조각(확장자 없음). namespace: "." 구분 이름공간 */
  module: string;
  kind: ImportKind;
  /** 상대 import 로 워크스페이스 상대경로가 확정됨 — 정확 일치만 인정 */
  exact?: boolean;
  /** 이 import 로 들어온 로컬 이름들. 없으면 와일드카드(모듈 전체) */
  names?: string[];
  /** 로컬 이름 -> 원래 이름 (as 별칭) */
  renames?: Record<string, string>;
  /** 모듈 자체의 로컬 이름 — `ns.f()` / `mod::f()` 처럼 한정 호출의 접두어 해석용 */
  local?: string;
  /** 한정 호출 접두어 해석에만 쓰고, 이름 없는 호출의 와일드카드로는 쓰지 않음 */
  qualifiedOnly?: boolean;
}

export interface FileInfo {
  imports: ImportEntry[];
  /** 파일이 선언한 namespace / package ("." 구분) */
  namespaces: string[];
}

export const EMPTY_INFO: FileInfo = { imports: [], namespaces: [] };

/** 레코드 lang 값 또는 확장자로 추출기 선택 */
export function langKey(lang: string, file: string): string {
  const l = lang.toLowerCase();
  if (l === "py" || l === "python") return "python";
  if (["typescript", "javascript", "tsx", "jsx", "ts", "js"].includes(l)) return "ts";
  if (l === "csharp" || l === "c#" || l === "cs") return "csharp";
  if (["c", "cpp", "c++", "cxx", "objc"].includes(l)) return "cpp";
  if (l === "rust" || l === "rs") return "rust";
  if (l === "go" || l === "golang") return "go";
  if (l === "java" || l === "kotlin" || l === "kt") return "java";
  const ext = path.posix.extname(file).toLowerCase();
  const byExt: Record<string, string> = {
    ".py": "python",
    ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
    ".js": "ts", ".jsx": "ts", ".mjs": "ts", ".cjs": "ts",
    ".cs": "csharp",
    ".c": "cpp", ".h": "cpp", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
    ".rs": "rust",
    ".go": "go",
    ".java": "java", ".kt": "java", ".kts": "java",
  };
  return byExt[ext] ?? "";
}

/** 소스 텍스트 → FileInfo. file 은 워크스페이스 상대경로("/" 구분) */
export function extractFileInfo(text: string, lang: string, file: string): FileInfo {
  switch (langKey(lang, file)) {
    case "python":
      return extractPython(stripHashComments(text), file);
    case "ts":
      return extractTs(stripCComments(text), file);
    case "csharp":
      return extractCsharp(stripCComments(text));
    case "cpp":
      return extractCpp(stripCComments(text));
    case "rust":
      return extractRust(stripCComments(text), file);
    case "go":
      return extractGo(stripCComments(text));
    case "java":
      return extractJava(stripCComments(text));
    default:
      return EMPTY_INFO;
  }
}

/** 확장자 제거 (경로 조각 비교용) */
export function stripExt(p: string): string {
  const ext = path.posix.extname(p);
  return ext ? p.slice(0, -ext.length) : p;
}

// --- 공통 -------------------------------------------------------------------

function stripCComments(text: string): string {
  // 문자열 안의 // 는 드물게 깨질 수 있지만 import 줄 추출에는 충분하다
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

function stripHashComments(text: string): string {
  return text.replace(/^\s*#.*$/gm, "");
}

/** "a as b" / "a" → [local, orig] */
function splitAlias(item: string, sep: RegExp): [string, string] | undefined {
  const t = item.trim();
  if (!t) return undefined;
  const parts = t.split(sep).map((s) => s.trim());
  const orig = parts[0];
  const local = parts[1] || orig;
  return [local, orig];
}

function namedEntry(base: Omit<ImportEntry, "names" | "renames">, items: [string, string][]): ImportEntry {
  const names: string[] = [];
  const renames: Record<string, string> = {};
  for (const [local, orig] of items) {
    names.push(local);
    if (local !== orig) renames[local] = orig;
  }
  const e: ImportEntry = { ...base, names };
  if (Object.keys(renames).length > 0) e.renames = renames;
  return e;
}

// --- python -----------------------------------------------------------------

function pyModulePath(mod: string, file: string): { module: string; exact: boolean } {
  let dots = 0;
  while (mod[dots] === ".") dots++;
  const rest = mod.slice(dots).replace(/\./g, "/");
  if (dots === 0) {
    return { module: rest, exact: false };
  }
  let base = path.posix.dirname(file);
  for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
  const joined = rest ? path.posix.join(base, rest) : base;
  return { module: joined === "." ? "" : joined, exact: true };
}

function extractPython(text: string, file: string): FileInfo {
  const imports: ImportEntry[] = [];
  const fromRe = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm;
  for (const m of text.matchAll(fromRe)) {
    const { module, exact } = pyModulePath(m[1], file);
    const body = m[2].replace(/[()\\]/g, " ").replace(/\s+/g, " ").trim();
    if (body === "*") {
      imports.push({ module, kind: "path", exact });
      continue;
    }
    const items = body
      .split(",")
      .map((s) => splitAlias(s, /\s+as\s+/))
      .filter((x): x is [string, string] => !!x);
    imports.push(namedEntry({ module, kind: "path", exact }, items));
    // from pkg import mod → mod.f() 접두어 해석용 (mod 가 서브모듈일 수 있음)
    for (const [local, orig] of items) {
      imports.push({
        module: module ? `${module}/${orig}` : orig,
        kind: "path",
        exact,
        local,
        qualifiedOnly: true,
      });
    }
  }
  const importRe = /^[ \t]*import[ \t]+([^\n]+)/gm;
  for (const m of text.matchAll(importRe)) {
    for (const part of m[1].split(",")) {
      const pair = splitAlias(part, /\s+as\s+/);
      if (!pair) continue;
      const [alias, dotted] = pair;
      const local = alias !== dotted ? alias : dotted.split(".").pop() ?? dotted;
      imports.push({
        module: dotted.replace(/\./g, "/"),
        kind: "path",
        local,
        qualifiedOnly: true,
      });
    }
  }
  return { imports, namespaces: [] };
}

// --- typescript / javascript ------------------------------------------------

function tsModulePath(spec: string, file: string): { module: string; exact: boolean } {
  if (spec.startsWith(".")) {
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    return { module: stripExt(joined), exact: true };
  }
  // 경로 별칭(@/lib/x, ~/x) 은 접미 매칭으로
  if (spec.startsWith("@/") || spec.startsWith("~/")) {
    return { module: stripExt(spec.slice(2)), exact: false };
  }
  return { module: stripExt(spec), exact: false };
}

function extractTs(text: string, file: string): FileInfo {
  const imports: ImportEntry[] = [];
  const importRe = /\bimport\s+(?:type\s+)?([\w$*{}\s,]+?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(importRe)) {
    const { module, exact } = tsModulePath(m[2], file);
    const clause = m[1];
    const items: [string, string][] = [];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const it of braces[1].split(",")) {
        const pair = splitAlias(it.replace(/^\s*type\s+/, ""), /\s+as\s+/);
        if (pair) items.push(pair);
      }
    }
    const ns = clause.match(/\*\s*as\s+([\w$]+)/);
    if (ns) {
      imports.push({ module, kind: "path", exact, local: ns[1], qualifiedOnly: true });
    }
    const def = clause.replace(/\{[^}]*\}/, "").replace(/\*\s*as\s+[\w$]+/, "").match(/([\w$]+)/);
    if (def) items.push([def[1], def[1]]);
    if (items.length > 0) {
      imports.push(namedEntry({ module, kind: "path", exact }, items));
    }
  }
  const requireRe = /(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(requireRe)) {
    const { module, exact } = tsModulePath(m[2], file);
    if (m[1].startsWith("{")) {
      const items = m[1]
        .slice(1, -1)
        .split(",")
        // { a: b } 에서 로컬은 b, 원래 이름은 a
        .map((s) => splitAlias(s, /\s*:\s*/))
        .filter((x): x is [string, string] => !!x);
      imports.push(namedEntry({ module, kind: "path", exact }, items));
    } else {
      imports.push({ module, kind: "path", exact, local: m[1], qualifiedOnly: true });
    }
  }
  return { imports, namespaces: [] };
}

// --- C# ---------------------------------------------------------------------

function extractCsharp(text: string): FileInfo {
  const imports: ImportEntry[] = [];
  const aliasRe = /^\s*(?:global\s+)?using\s+(\w+)\s*=\s*([\w.]+)\s*;/gm;
  for (const m of text.matchAll(aliasRe)) {
    imports.push({ module: m[2], kind: "namespace", local: m[1], qualifiedOnly: true });
  }
  const usingRe = /^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*;/gm;
  for (const m of text.matchAll(usingRe)) {
    imports.push({ module: m[1], kind: "namespace" });
  }
  const namespaces = [...text.matchAll(/\bnamespace\s+([\w.]+)/g)].map((m) => m[1]);
  return { imports, namespaces: uniq(namespaces) };
}

// --- C / C++ ----------------------------------------------------------------

function extractCpp(text: string): FileInfo {
  const imports: ImportEntry[] = [];
  for (const m of text.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)) {
    const spec = m[1].replace(/^(\.\.?\/)+/, "");
    imports.push({ module: stripExt(spec), kind: "path" });
  }
  for (const m of text.matchAll(/\busing\s+namespace\s+([\w:]+)\s*;/g)) {
    imports.push({ module: m[1].replace(/::/g, "."), kind: "namespace" });
  }
  for (const m of text.matchAll(/\busing\s+((?:\w+::)+)(\w+)\s*;/g)) {
    const ns = m[1].slice(0, -2).replace(/::/g, ".");
    imports.push({ module: ns, kind: "namespace", names: [m[2]] });
  }
  for (const m of text.matchAll(/\bnamespace\s+(\w+)\s*=\s*([\w:]+)\s*;/g)) {
    imports.push({
      module: m[2].replace(/::/g, "."),
      kind: "namespace",
      local: m[1],
      qualifiedOnly: true,
    });
  }
  const namespaces = [...text.matchAll(/\bnamespace\s+([\w:]+)\s*\{/g)].map((m) =>
    m[1].replace(/::/g, ".")
  );
  return { imports, namespaces: uniq(namespaces) };
}

// --- Rust -------------------------------------------------------------------

interface UseItem {
  segs: string[];
  glob?: boolean;
}

/**
 * use 트리 펼치기: a::{b, c::d, f::*} → [a,b], [a,c,d], [a,f]+glob.
 * as 별칭은 호출부(extractRust)가 미리 "x@y" 로 표시해 둔다 — 여기선 경로만 다룬다.
 */
export function expandUse(src: string, prefix: string[] = []): UseItem[] {
  const s = src.replace(/\s+/g, "");
  const brace = s.indexOf("{");
  if (brace < 0) {
    const segs = [...prefix, ...s.split("::").filter(Boolean)];
    if (segs[segs.length - 1] === "*") {
      return [{ segs: segs.slice(0, -1), glob: true }];
    }
    return segs.length > 0 ? [{ segs }] : [];
  }
  const head = s.slice(0, brace).replace(/::$/, "");
  const inner = s.slice(brace + 1, s.lastIndexOf("}"));
  const base = [...prefix, ...head.split("::").filter(Boolean)];
  const out: UseItem[] = [];
  for (const part of splitTopLevel(inner)) {
    // use a::{self, b} — self 는 a 자신
    out.push(...(part === "self" ? [{ segs: base }] : expandUse(part, base)));
  }
  return out;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** 파일 기준 rust 모듈 디렉터리: src/a/b.rs → src/a/b, src/a/mod.rs → src/a */
function rustModuleDir(file: string): string {
  const base = path.posix.basename(stripExt(file));
  const dir = path.posix.dirname(file);
  return ["mod", "lib", "main"].includes(base) ? dir : path.posix.join(dir, base);
}

function rustPath(segs: string[], file: string): { module: string; exact: boolean } {
  if (segs.length === 0) return { module: "", exact: false };
  const first = segs[0];
  if (first === "crate") {
    return { module: segs.slice(1).join("/"), exact: false };
  }
  if (first === "self" || first === "super") {
    let dir = rustModuleDir(file);
    let i = 0;
    if (segs[0] === "self") i = 1;
    while (segs[i] === "super") {
      dir = path.posix.dirname(dir);
      i++;
    }
    const rest = segs.slice(i).join("/");
    return { module: rest ? path.posix.join(dir, rest) : dir, exact: true };
  }
  return { module: segs.join("/"), exact: false };
}

function extractRust(text: string, file: string): FileInfo {
  const imports: ImportEntry[] = [];
  // as 별칭이 공백 제거로 깨지지 않도록 "x as y" 를 "x@y" 로 먼저 표시
  for (const m of text.matchAll(/\buse\s+([^;]+);/g)) {
    const marked = m[1].replace(/\s+as\s+/g, "@");
    for (const item of expandUse(marked)) {
      let segs = item.segs;
      let alias: string | undefined;
      const last = segs[segs.length - 1] ?? "";
      if (last.includes("@")) {
        const [orig, al] = last.split("@");
        segs = [...segs.slice(0, -1), orig];
        alias = al;
      }
      if (item.glob) {
        const { module, exact } = rustPath(segs, file);
        imports.push({ module, kind: "path", exact });
        continue;
      }
      const name = segs[segs.length - 1];
      if (!name || name === "self" || name === "super" || name === "crate") continue;
      const local = alias ?? name;
      const parent = rustPath(segs.slice(0, -1), file);
      imports.push(namedEntry({ module: parent.module, kind: "path", exact: parent.exact }, [[local, name]]));
      // use a::b; 이후 b::f() — b 가 모듈인 경우의 접두어 해석
      const full = rustPath(segs, file);
      imports.push({ module: full.module, kind: "path", exact: full.exact, local, qualifiedOnly: true });
    }
  }
  return { imports, namespaces: [] };
}

// --- Go ---------------------------------------------------------------------

function extractGo(text: string): FileInfo {
  const imports: ImportEntry[] = [];
  const add = (alias: string | undefined, spec: string) => {
    if (alias === "_") return;
    const local = alias && alias !== "." ? alias : spec.split("/").pop() ?? spec;
    // Go 는 다른 패키지 함수를 항상 pkg.F 로 부르므로 접두어 해석 + 와일드카드 둘 다
    imports.push({ module: spec, kind: "path", local });
  };
  for (const m of text.matchAll(/^\s*import\s+(?:(\w+|\.|_)\s+)?"([^"]+)"/gm)) {
    add(m[1], m[2]);
  }
  for (const block of text.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
    for (const m of block[1].matchAll(/(?:(\w+|\.|_)\s+)?"([^"]+)"/g)) {
      add(m[1], m[2]);
    }
  }
  const pkg = text.match(/^\s*package\s+(\w+)/m);
  return { imports, namespaces: pkg ? [pkg[1]] : [] };
}

// --- Java / Kotlin ----------------------------------------------------------

function extractJava(text: string): FileInfo {
  const imports: ImportEntry[] = [];
  for (const m of text.matchAll(/^\s*import\s+(static\s+)?([\w.]+?)(\.\*)?(?:\s+as\s+\w+)?\s*;?\s*$/gm)) {
    const [, isStatic, dotted, star] = m;
    if (isStatic && !star) {
      // import static a.b.C.max → 클래스 a.b.C 의 max
      const i = dotted.lastIndexOf(".");
      imports.push({ module: dotted.slice(0, i), kind: "namespace", names: [dotted.slice(i + 1)] });
    } else {
      imports.push({ module: dotted, kind: "namespace" });
    }
  }
  const pkg = text.match(/^\s*package\s+([\w.]+)/m);
  return { imports, namespaces: pkg ? [pkg[1]] : [] };
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * 에이전트가 레코드에 적은 import 1건 → ImportEntry 들.
 * 소스 추출과 같은 해석 규칙(언어별 경로/namespace 판정)을 쓴다.
 */
export function fromRecordImport(
  imp: { module: string; names?: string[]; alias?: string },
  lang: string,
  file: string
): ImportEntry[] {
  const key = langKey(lang, file);
  let module = imp.module;
  let kind: ImportKind = "path";
  let exact = false;
  switch (key) {
    case "python":
      ({ module, exact } = pyModulePath(module, file));
      break;
    case "ts":
      ({ module, exact } = tsModulePath(module, file));
      break;
    case "rust":
      ({ module, exact } = rustPath(module.split("::").filter(Boolean), file));
      break;
    case "csharp":
    case "java":
      kind = "namespace";
      break;
    case "cpp":
      if (module.includes("/") || /\.(h|hh|hpp|hxx)$/i.test(module)) {
        module = stripExt(module.replace(/^(\.\.?\/)+/, ""));
      } else {
        kind = "namespace";
        module = module.replace(/::/g, ".");
      }
      break;
    default:
      module = module.replace(/::/g, "/");
  }
  const out: ImportEntry[] = [];
  if (imp.names && imp.names.length > 0) {
    out.push({ module, kind, exact, names: imp.names });
  } else {
    out.push({ module, kind, exact });
  }
  if (imp.alias) {
    out.push({ module, kind, exact, local: imp.alias, qualifiedOnly: true });
  }
  return out;
}
