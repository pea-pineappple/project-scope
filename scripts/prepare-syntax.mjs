// resources/syntax 준비 — tm-grammars / tm-themes (MIT, VS Code 원본 문법·테마) 에서 필요한 것만 복사
// 원격 SSH 에서는 VS Code 내장 문법·테마가 원격 서버에 없어서(로컬 UI 쪽에만 있음) 확장에 함께 넣는다.
// 사용: node scripts/prepare-syntax.mjs  (devDependencies 설치 후, 결과는 resources/syntax 에 커밋)
import * as G from "tm-grammars";
import * as T from "tm-themes";
import fs from "node:fs";
import path from "node:path";

const out = path.resolve("resources/syntax");
// VS Code languageId → tm-grammars 이름
const LANGS = {
  typescript: "typescript", typescriptreact: "tsx", javascript: "javascript", javascriptreact: "jsx",
  python: "python", csharp: "csharp", cpp: "cpp", c: "c", cuda: "cpp", rust: "rust", go: "go",
  java: "java", kotlin: "kotlin", swift: "swift", scala: "scala", dart: "dart", php: "php", ruby: "ruby",
  lua: "lua", sql: "sql", shellscript: "shellscript", json: "json", jsonc: "jsonc", yaml: "yaml",
};
// 문법 안에서 include 하는 보조 문법 (없으면 그 부분만 색 없음)
const EXTRA = ["regexp", "glsl"];
// VS Code 테마 이름(id/label) → tm-themes 이름. 없으면 확장이 종류(어두움/밝음)로 고른다
const THEMES = {
  "dark-plus": ["Default Dark Modern", "Default Dark+", "Dark+", "Dark Modern", "Dark+ (default dark)", "Visual Studio Dark", "Default High Contrast", "Dark High Contrast"],
  "light-plus": ["Default Light Modern", "Default Light+", "Light+", "Light Modern", "Light+ (default light)", "Visual Studio Light", "Default High Contrast Light", "Light High Contrast"],
  monokai: ["Monokai", "Monokai Dimmed"],
  "solarized-dark": ["Solarized Dark"], "solarized-light": ["Solarized Light"],
  "github-dark": ["GitHub Dark"], "github-light": ["GitHub Light"],
  "github-dark-default": ["GitHub Dark Default"], "github-light-default": ["GitHub Light Default"],
  "github-dark-dimmed": ["GitHub Dark Dimmed"],
  "one-dark-pro": ["One Dark Pro", "One Dark Pro Darker", "One Dark Pro Flat", "One Dark Pro Mix"],
  dracula: ["Dracula", "Dracula Theme", "Dracula Soft"], nord: ["Nord"], "tokyo-night": ["Tokyo Night", "Tokyo Night Storm"],
  red: ["Red"], "night-owl": ["Night Owl"], "catppuccin-mocha": ["Catppuccin Mocha"], "catppuccin-latte": ["Catppuccin Latte"],
  "material-theme": ["Material Theme"], "material-theme-darker": ["Material Theme Darker"], "ayu-dark": ["Ayu Dark"], "ayu-light": ["Ayu Light"],
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "grammars"), { recursive: true });
fs.mkdirSync(path.join(out, "themes"), { recursive: true });
const gdir = path.dirname(new URL(import.meta.resolve("tm-grammars/grammars/json.json")).pathname);
const tdir = path.dirname(new URL(import.meta.resolve("tm-themes/themes/dark-plus.json")).pathname);
const index = { languages: LANGS, grammars: {}, themes: {} };
for (const name of new Set([...Object.values(LANGS), ...EXTRA])) {
  const meta = G.grammars.find((g) => g.name === name);
  fs.copyFileSync(path.join(gdir, `${name}.json`), path.join(out, "grammars", `${name}.json`));
  index.grammars[meta.scopeName] = { file: `${name}.json`, name, license: meta.license, source: meta.source };
}
for (const [name, labels] of Object.entries(THEMES)) {
  const meta = T.themes.find((t) => t.name === name);
  fs.copyFileSync(path.join(tdir, `${name}.json`), path.join(out, "themes", `${name}.json`));
  index.themes[name] = { file: `${name}.json`, type: meta.type, labels, license: meta.license, source: meta.source };
}
fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(index, null, 1));
fs.copyFileSync(path.join(gdir, "..", "NOTICE"), path.join(out, "NOTICE-grammars"));
fs.copyFileSync(path.join(gdir, "..", "LICENSE"), path.join(out, "LICENSE-grammars"));
fs.copyFileSync(path.join(tdir, "..", "LICENSE"), path.join(out, "LICENSE-themes"));
let size = 0;
for (const d of ["grammars", "themes"]) for (const f of fs.readdirSync(path.join(out, d))) size += fs.statSync(path.join(out, d, f)).size;
console.log(`grammars ${Object.keys(index.grammars).length} · themes ${Object.keys(index.themes).length} · ${Math.round(size / 1024)}KB → ${out}`);
