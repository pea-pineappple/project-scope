/**
 * highlighter.ts — 탐색 창 소스 영역의 문법 색상 (VS Code 와 같은 TextMate 문법 + 현재 테마 색)
 *
 * 토크나이저는 VS Code 가 쓰는 것과 같은 vscode-textmate + vscode-oniguruma(wasm).
 * 문법·테마는 읽을 수 있는 것을 먼저:
 *   1) 설치된 확장(vscode.extensions.all)의 contributes.grammars / themes — 로컬 VS Code,
 *      또는 원격에 설치된 언어 확장(rust-analyzer, C#, Python …)
 *   2) 확장에 함께 넣은 resources/syntax (tm-grammars / tm-themes, VS Code 원본, MIT)
 * 원격 SSH 에서는 VS Code 내장 문법·테마가 로컬(UI) 쪽에만 있어 원격 확장 호스트가 읽을 수 없다 → 2) 로 대체.
 * 테마는 workbench.colorTheme 이름으로 찾고, 못 찾으면 현재 테마 종류(어두움/밝음)로 Dark+/Light+.
 * 편집기의 시맨틱 색상(언어 서버 토큰)은 입히지 않으므로 변수·매개변수 색은 조금 다를 수 있다.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import * as oniguruma from "vscode-oniguruma";
import * as vsctm from "vscode-textmate";

/** vscode-textmate 가 내보내지 않는 IRawThemeSetting 과 같은 모양 */
type ThemeSetting = vsctm.IRawTheme["settings"][number];

/** 줄별 토큰 [텍스트, 색 번호(0 = 기본 글자색), 글꼴 스타일 비트(1 기울임 2 굵게 4 밑줄 8 취소선)] */
export type HlToken = [string, number, number];

export interface Highlighted {
  lines: HlToken[][];
  /** 색 번호 → "#rrggbb" */
  colors: string[];
  /** 실제로 쓴 문법·테마 (툴팁 표시용) */
  grammar: string;
  theme: string;
}

interface GrammarSource {
  scopeName: string;
  file: string;
  language?: string;
  injectTo?: string[];
}

interface SyntaxIndex {
  languages: Record<string, string>;
  grammars: Record<string, { file: string; name: string }>;
  themes: Record<string, { file: string; type: string; labels: string[] }>;
}

/** 파일 상단 문맥을 위해 함수 시작 전 이만큼까지는 처음부터 토큰화 */
const PREFIX_MAX = 4000;
const LINE_TIME_MS = 300;

export class Highlighter {
  private onig: Promise<vsctm.IOnigLib> | undefined;
  private registry: vsctm.Registry | undefined;
  private themeName = "";
  private grammars = new Map<string, GrammarSource>();
  private langToScope = new Map<string, string>();
  private index: SyntaxIndex | undefined;
  private loaded = new Map<string, Promise<vsctm.IGrammar | null>>();

  constructor(private extensionPath: string, private log: (m: string) => void) {}

  /** 테마·확장 목록이 바뀌면 다시 준비 */
  reset(): void {
    this.registry = undefined;
    this.loaded.clear();
  }

  async highlight(abs: string, languageId: string, from: number, to: number): Promise<Highlighted | undefined> {
    try {
      const reg = await this.ensure();
      const scope = this.scopeFor(languageId, abs);
      if (!scope) {
        return undefined;
      }
      let p = this.loaded.get(scope);
      if (!p) {
        p = reg.loadGrammar(scope);
        this.loaded.set(scope, p);
      }
      const grammar = await p;
      if (!grammar) {
        return undefined;
      }
      const all = fs.readFileSync(abs, "utf8").split(/\r?\n/);
      const start = from - 1 > PREFIX_MAX ? from - 1 : 0;
      let state = vsctm.INITIAL;
      const out: HlToken[][] = [];
      const colorMap = reg.getColorMap();
      const defaultFg = colorMap[1]?.toUpperCase();
      for (let i = start; i < Math.min(to, all.length); i++) {
        const line = all[i];
        const r = grammar.tokenizeLine2(line, state, LINE_TIME_MS);
        state = r.ruleStack;
        if (i < from - 1) {
          continue;
        }
        const toks: HlToken[] = [];
        const t = r.tokens;
        for (let j = 0; j < t.length; j += 2) {
          const s = t[j];
          const e = j + 2 < t.length ? t[j + 2] : line.length;
          if (e <= s) {
            continue;
          }
          const meta = t[j + 1];
          const fg = (meta & 0x00ff8000) >>> 15;
          const font = (meta & 0x00007800) >>> 11;
          const color = colorMap[fg]?.toUpperCase() === defaultFg ? 0 : fg;
          const prev = toks[toks.length - 1];
          if (prev && prev[1] === color && prev[2] === font) {
            prev[0] += line.slice(s, e); // 같은 색은 합쳐 DOM 을 줄인다
          } else {
            toks.push([line.slice(s, e), color, font]);
          }
        }
        out.push(toks);
      }
      return { lines: out, colors: colorMap, grammar: scope, theme: this.themeName };
    } catch (e) {
      this.log(`highlight: ${abs} — ${(e as Error).message}`);
      return undefined;
    }
  }

  // --- 준비 ------------------------------------------------------------------------

  private async ensure(): Promise<vsctm.Registry> {
    if (this.registry) {
      return this.registry;
    }
    this.onig ??= (async () => {
      const wasm = fs.readFileSync(path.join(this.extensionPath, "out", "onig.wasm"));
      await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
      return {
        createOnigScanner: (s: string[]) => new oniguruma.OnigScanner(s),
        createOnigString: (s: string) => new oniguruma.OnigString(s),
      };
    })();
    this.collectGrammars();
    const theme = this.loadTheme();
    this.themeName = theme.name;
    const reg = new vsctm.Registry({
      onigLib: this.onig,
      loadGrammar: async (scopeName) => {
        const g = this.grammars.get(scopeName);
        if (!g) {
          return null;
        }
        try {
          return vsctm.parseRawGrammar(fs.readFileSync(g.file, "utf8"), g.file);
        } catch {
          return null;
        }
      },
      getInjections: (scopeName) =>
        [...this.grammars.values()].filter((g) => g.injectTo?.includes(scopeName)).map((g) => g.scopeName),
      theme: { name: theme.name, settings: theme.settings },
    });
    this.registry = reg;
    return reg;
  }

  private syntaxIndex(): SyntaxIndex {
    this.index ??= JSON.parse(
      fs.readFileSync(path.join(this.extensionPath, "resources", "syntax", "index.json"), "utf8")
    ) as SyntaxIndex;
    return this.index;
  }

  /** 번들 문법을 깔고, 읽을 수 있는 설치 확장 문법으로 덮어쓴다 */
  private collectGrammars(): void {
    this.grammars.clear();
    this.langToScope.clear();
    const idx = this.syntaxIndex();
    const dir = path.join(this.extensionPath, "resources", "syntax", "grammars");
    for (const [scopeName, g] of Object.entries(idx.grammars)) {
      this.grammars.set(scopeName, { scopeName, file: path.join(dir, g.file) });
    }
    for (const [lang, name] of Object.entries(idx.languages)) {
      const scope = Object.entries(idx.grammars).find(([, g]) => g.name === name)?.[0];
      if (scope) {
        this.langToScope.set(lang, scope);
      }
    }
    let installed = 0;
    for (const ext of vscode.extensions.all) {
      const list = (ext.packageJSON?.contributes?.grammars ?? []) as {
        language?: string;
        scopeName?: string;
        path?: string;
        injectTo?: string[];
      }[];
      for (const g of list) {
        if (!g.scopeName || !g.path) {
          continue;
        }
        const file = path.join(ext.extensionPath, g.path);
        if (!fs.existsSync(file)) {
          continue; // 원격에서 로컬 UI 확장 경로 — 읽을 수 없음
        }
        this.grammars.set(g.scopeName, { scopeName: g.scopeName, file, language: g.language, injectTo: g.injectTo });
        if (g.language) {
          this.langToScope.set(g.language, g.scopeName);
        }
        installed++;
      }
    }
    this.log(`highlight: ${this.grammars.size} grammars (${installed} from installed extensions)`);
  }

  private scopeFor(languageId: string, abs: string): string | undefined {
    const s = this.langToScope.get(languageId);
    if (s) {
      return s;
    }
    // languageId 를 모를 때 확장자로
    const ext = path.extname(abs).toLowerCase();
    const byExt: Record<string, string> = {
      ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact",
      ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact",
      ".py": "python", ".cs": "csharp", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
      ".h": "cpp", ".c": "c", ".rs": "rust", ".go": "go", ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
      ".swift": "swift", ".scala": "scala", ".dart": "dart", ".php": "php", ".rb": "ruby", ".lua": "lua",
    };
    return byExt[ext] ? this.langToScope.get(byExt[ext]) : undefined;
  }

  /** 현재 테마의 tokenColors — 설치 테마 파일, 없으면 번들(이름 → 종류 순) */
  private loadTheme(): { name: string; settings: ThemeSetting[] } {
    const want = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme") ?? "";
    const kind = vscode.window.activeColorTheme.kind;
    const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
    // 1) 설치된 테마 파일
    for (const ext of vscode.extensions.all) {
      const themes = (ext.packageJSON?.contributes?.themes ?? []) as { id?: string; label?: string; path?: string }[];
      for (const t of themes) {
        if (!t.path || (t.id !== want && t.label !== want)) {
          continue;
        }
        const file = path.join(ext.extensionPath, t.path);
        if (!fs.existsSync(file)) {
          continue;
        }
        const loaded = readThemeFile(file);
        if (loaded && loaded.tokenColors.length > 0) {
          return { name: want, settings: toSettings(loaded.tokenColors, loaded.colors) };
        }
      }
    }
    // 2) 번들 — 이름이 맞는 것, 없으면 종류로
    const idx = this.syntaxIndex();
    let pick = Object.entries(idx.themes).find(([, t]) => t.labels.includes(want))?.[0];
    const fallback = !pick;
    pick ??= light ? "light-plus" : "dark-plus";
    const loaded = readThemeFile(path.join(this.extensionPath, "resources", "syntax", "themes", idx.themes[pick].file));
    return {
      name: fallback ? `${pick} (fallback for ${want || "default"})` : pick,
      settings: toSettings(loaded?.tokenColors ?? [], loaded?.colors ?? {}),
    };
  }
}

/** 기본 글자·배경색 항목 + tokenColors */
function toSettings(tokenColors: ThemeSetting[], colors: Record<string, string>): ThemeSetting[] {
  return [
    { settings: { foreground: colors["editor.foreground"] ?? "#D4D4D4", background: colors["editor.background"] ?? "#1E1E1E" } },
    ...tokenColors.filter((t) => t && t.settings),
  ];
}

/** VS Code 테마 파일 (JSONC, include 체인) → tokenColors·colors 병합 */
function readThemeFile(
  file: string,
  depth = 0
): { tokenColors: ThemeSetting[]; colors: Record<string, string> } | undefined {
  if (depth > 5) {
    return undefined;
  }
  let o: { include?: string; tokenColors?: unknown; colors?: Record<string, string> };
  try {
    o = JSON.parse(stripJsonc(fs.readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
  const base = o.include ? readThemeFile(path.join(path.dirname(file), o.include), depth + 1) : undefined;
  let own: ThemeSetting[] = [];
  if (Array.isArray(o.tokenColors)) {
    own = o.tokenColors as ThemeSetting[];
  } else if (typeof o.tokenColors === "string") {
    // .tmTheme(plist) 경로 — 드묾, 지원 안 함 (include 쪽 색만 사용)
    own = [];
  }
  return {
    tokenColors: [...(base?.tokenColors ?? []), ...own],
    colors: { ...(base?.colors ?? {}), ...(o.colors ?? {}) },
  };
}

/** // · 블록 주석과 끝 쉼표 제거 (문자열 안은 그대로) */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') {
        inStr = false;
      }
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i++;
      }
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
