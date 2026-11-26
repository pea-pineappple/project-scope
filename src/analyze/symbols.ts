/**
 * symbols.ts — 언어 서버 심볼 트리 → 규약 qual, 기존 레코드와 대조 (vscode 의존 없음)
 *
 * 구조(함수 목록·줄 범위·srcHash)는 확장이 직접 만든다 — LLM 은 요약만.
 * qual 규칙은 AGENTS.md 그대로: 클래스 메서드 `C.m`, 중첩 함수 `f.<locals>.g`,
 * namespace/package/module 은 qual 이 아니라 ns, C++/Rust 의 `::` 는 `.`.
 *
 * 대조(matchFile): 같은 파일의 기존 레코드와 새 스캔 결과를 비교해
 *   unchanged(그대로) / moved(본문 같고 위치만 이동 → 요약 재사용) /
 *   changed(본문 바뀜 → 요약 필요) / added(새 함수) / gone(사라짐 → 삭제 표시)
 * 로 나눈다. 언어 서버의 범위가 에이전트가 쓴 범위와 1~2줄 다를 수 있어
 * 레코드 길이를 유지한 후보 범위들도 해시로 확인한다.
 */
import * as crypto from "node:crypto";

/** 언어 서버 심볼을 단순화한 것 — 줄은 1-based */
export interface RawSymbol {
  name: string;
  /** ns: namespace·module·package, impl: Rust impl 블록, var: 함수일 수도 있는 변수·속성 */
  kind: "class" | "func" | "ns" | "impl" | "var" | "other";
  line: number;
  endLine: number;
  /** 이름 위치 (호출 계층·참조 찾기 기준점), 0-based 열 */
  selLine: number;
  selChar: number;
  children: RawSymbol[];
}

export interface Scanned {
  kind: "func" | "class";
  qual: string;
  name: string;
  line: number;
  endLine: number;
  selLine: number;
  selChar: number;
  ns?: string;
  srcHash: string;
}

/** 규약 해시 — line..endLine 각 줄(\r 제거)을 \n 으로 이은 것의 sha1 앞 16자 */
export function bodyHash(lines: string[], line: number, endLine: number): string | undefined {
  if (line < 1 || endLine < line || endLine > lines.length) {
    return undefined;
  }
  const body = lines.slice(line - 1, endLine).join("\n");
  return crypto.createHash("sha1").update(body, "utf8").digest("hex").slice(0, 16);
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * 언어 서버가 주는 이름을 정리 — 시그니처 꼬리 제거, `::` → `.`,
 * Go 리시버 `(*T).M` → `T.M`, Rust `impl Trait for T<X>` → `T`
 */
export function cleanName(raw: string, kind: RawSymbol["kind"]): string {
  let n = raw.trim();
  if (kind === "impl") {
    n = n.replace(/^impl(<[^>]*>)?\s+/, "");
    const forAt = n.lastIndexOf(" for ");
    if (forAt >= 0) {
      n = n.slice(forAt + 5);
    }
    return n.replace(/<.*$/, "").replace(/::/g, ".").trim();
  }
  const go = /^\(\*?\s*([\w.]+)(\[[^\]]*\])?\)\.(\w+)/.exec(n);
  if (go) {
    return `${go[1]}.${go[3]}`;
  }
  n = n.replace(/\s*\(.*$/s, ""); // C#/Java "Add(int, int)"
  n = n.replace(/<[^<>]*>$/, ""); // 제네릭 꼬리
  return n.replace(/::/g, ".").trim();
}

/** 이름 없는 함수 심볼 — TS "x() callback" / "<function>", 일반 "(anonymous)", "lambda" */
const ANONYMOUS = /(^|\s)callback$|^<[^>]*>$|^\(anonymous|^anonymous$|^lambda$|^<lambda>$/;

/**
 * 이름 뒤가 `= 함수` 인지 — `const f = () =>`, `f = function`, 클래스 속성 `f = async (x) =>`,
 * Python `f = lambda`. 객체 리터럴 `key: () =>` 과 타입 멤버 `key: (x) => T` 는 아님 (기존 규약과 같음).
 * rest 는 선언 줄에서 이름이 시작하는 곳부터의 텍스트.
 */
export function looksLikeFunctionValue(rest: string): boolean {
  const m = /^[\w$]+\s*(?::\s*[^=]*?)?\s*=(?!=|>)\s*(.*)$/.exec(rest);
  if (!m) {
    return false;
  }
  const v = m[1];
  return (
    /^(async\s+)?function\b/.test(v) ||
    /^(async\s*)?[\w$]+\s*=>/.test(v) ||
    // (a, b) => / (a: T): R => — 괄호 한 겹 중첩까지. 여러 줄 파라미터는 "(" 나 "," 로 끝남
    /^(async\s*)?\((?:[^()]|\([^()]*\))*\)\s*(?::\s*[^=]+?)?\s*=>/.test(v) ||
    /^(async\s*)?\(\s*$/.test(v) ||
    /^(async\s*)?\([^()]*,\s*$/.test(v) ||
    /^lambda\b/.test(v)
  );
}

/** 객체 리터럴 속성에 함수를 넣은 것 (`key: () =>`, `key: function`) — 규약상 레코드 아님 */
export function isObjectPropertyFunction(rest: string): boolean {
  return /^[\w$]+\s*:\s*(async\s*)?(function\b|[\w$]+\s*=>|\()/.test(rest);
}

/**
 * 심볼 트리 → 레코드 후보. lines 는 파일 줄 배열, lineText(줄) 로 변수 선언 판별.
 * 클래스 안 → `C.x`, 함수 안 → `f.<locals>.x`, ns 는 qual 에서 빼고 ns 필드로.
 */
export function flatten(raw: RawSymbol[], lines: string[]): Scanned[] {
  const out: Scanned[] = [];
  const walk = (list: RawSymbol[], prefix: string, inFunc: boolean, ns: string[]) => {
    for (const s of list) {
      if (s.kind === "ns") {
        walk(s.children, prefix, inFunc, [...ns, cleanName(s.name, "ns")]);
        continue;
      }
      if (ANONYMOUS.test(s.name.trim())) {
        // 익명 콜백 (TS "map() callback", "<function>") — 기록하지 않고 안쪽만 같은 스코프로
        walk(s.children, prefix, inFunc, ns);
        continue;
      }
      if (s.kind === "impl") {
        const owner = cleanName(s.name, "impl");
        walk(s.children, (prefix ? prefix : "") + owner + ".", false, ns);
        continue;
      }
      let kind: "func" | "class" | undefined;
      if (s.kind === "class") {
        kind = "class";
      } else if (s.kind === "func") {
        kind = isObjectPropertyFunction((lines[s.selLine - 1] ?? "").slice(s.selChar)) ? undefined : "func";
      } else if (s.kind === "var" && looksLikeFunctionValue((lines[s.selLine - 1] ?? "").slice(s.selChar))) {
        kind = "func";
      }
      if (!kind) {
        continue; // 일반 변수·속성·enum 등은 기록하지 않음 (안의 함수도 건너뜀)
      }
      const name = cleanName(s.name, s.kind);
      // 이름에 이미 한정자가 있으면(C++ 클래스 밖 정의 Foo::bar) 그대로 qual 로
      const qual = name.includes(".") && !prefix ? name : prefix + name;
      const hash = bodyHash(lines, s.line, s.endLine);
      if (hash) {
        out.push({
          kind,
          qual,
          name: qual.slice(qual.lastIndexOf(".") + 1),
          line: s.line,
          endLine: s.endLine,
          selLine: s.selLine,
          selChar: s.selChar,
          ns: ns.length ? ns.join(".") : undefined,
          srcHash: hash,
        });
      }
      const childPrefix = kind === "class" ? qual + "." : qual + ".<locals>.";
      walk(s.children, childPrefix, kind === "func", ns);
    }
  };
  walk(raw, "", false, []);
  return out;
}

/** 대조에 필요한 기존 레코드 최소 정보 */
export interface ExistingRec {
  target: string;
  kind: "func" | "class";
  qual: string;
  line: number;
  endLine: number;
  srcHash: string;
}

export interface FileMatch<R extends ExistingRec> {
  unchanged: R[];
  /** 본문은 같고 위치만 바뀜 — 새 범위로 다시 기록 (요약 재사용) */
  moved: { rec: R; line: number; endLine: number }[];
  /** 본문이 바뀜 — 요약 필요. sym 은 새 위치 */
  changed: { rec: R; sym: Scanned }[];
  /** 새 함수 */
  added: Scanned[];
  /** 소스에서 사라짐 */
  gone: R[];
}

function lastSeg(q: string): string {
  return q.slice(q.lastIndexOf(".") + 1);
}

/** 한 파일의 기존 레코드와 스캔 결과를 대조 */
export function matchFile<R extends ExistingRec>(recs: R[], scanned: Scanned[], lines: string[]): FileMatch<R> {
  const res: FileMatch<R> = { unchanged: [], moved: [], changed: [], added: [], gone: [] };
  const free = new Set(scanned);
  const pairs: [R, Scanned][] = [];
  const left: R[] = [];
  // 1) 같은 kind + qual
  for (const r of recs) {
    const s = [...free].find((x) => x.kind === r.kind && x.qual === r.qual);
    if (s) {
      free.delete(s);
      pairs.push([r, s]);
    } else {
      left.push(r);
    }
  }
  // 2) qual 표기가 다른 레코드(에이전트 규칙 차이) — 같은 이름·kind 중 줄이 가장 가까운 것
  for (const r of left) {
    const cands = [...free].filter((x) => x.kind === r.kind && x.name === lastSeg(r.qual));
    if (cands.length === 0) {
      res.gone.push(r);
      continue;
    }
    cands.sort((a, b) => Math.abs(a.line - r.line) - Math.abs(b.line - r.line));
    free.delete(cands[0]);
    pairs.push([r, cands[0]]);
  }
  for (const [r, s] of pairs) {
    if (bodyHash(lines, r.line, r.endLine) === r.srcHash) {
      res.unchanged.push(r);
      continue;
    }
    const len = r.endLine - r.line;
    const tries: [number, number][] = [
      [s.line, s.endLine],
      [s.line, s.line + len],
      [s.endLine - len, s.endLine],
    ];
    // 언어 서버 범위 ±2줄 안에서 레코드 길이 그대로
    for (let d = -2; d <= 2; d++) {
      tries.push([s.line + d, s.line + d + len]);
    }
    const hit = tries.find(([a, b]) => bodyHash(lines, a, b) === r.srcHash);
    if (hit) {
      res.moved.push({ rec: r, line: hit[0], endLine: hit[1] });
    } else {
      res.changed.push({ rec: r, sym: s });
    }
  }
  res.added = [...free];
  return res;
}

/** 시그니처 첫 줄들에서 파라미터 이름 추정 — LLM 이 params 를 못 줄 때의 대비 */
export function guessParams(header: string): string[] {
  const open = header.indexOf("(");
  if (open < 0) {
    return [];
  }
  let depth = 0;
  let end = -1;
  for (let i = open; i < header.length; i++) {
    const c = header[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}" || c === ">") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    return [];
  }
  const inner = header.slice(open + 1, end);
  const parts: string[] = [];
  let cur = "";
  depth = 0;
  for (const c of inner) {
    if ("([{<".includes(c)) {
      depth++;
    } else if (")]}>".includes(c)) {
      depth--;
    }
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  const names: string[] = [];
  for (let p of parts) {
    p = p
      .replace(/=.*$/s, "")
      .replace(/^\s*((out|ref|in|params|const|final|mut|readonly|public|private|protected|var|val)\s+)+/, "")
      .trim();
    if (!p) {
      continue;
    }
    let name: string;
    if (/(^|[^:]):(?!:)/.test(p)) {
      name = p.slice(0, p.search(/(^|[^:]):(?!:)/) + 1).replace(/:$/, ""); // TS / Python / Rust
    } else {
      const words = p.split(/\s+/); // C# / Java / C++ "int a", Go "a int"
      name = /^[A-Z]|[*&\]]|^(int|long|float|double|bool|char|string|void|auto|const)$/.test(words[0]) || words.length === 1
        ? words[words.length - 1]
        : words[0];
    }
    name = name.replace(/^(\.\.\.|\*\*|\*|&|mut\s+|ref\s+|out\s+|in\s+|public\s+|private\s+|protected\s+|readonly\s+)+/, "");
    name = name.replace(/[?!*&]+$/, "").replace(/^[*&]+/, "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name) && !["self", "cls", "this"].includes(name)) {
      names.push(name);
    }
  }
  return names;
}
