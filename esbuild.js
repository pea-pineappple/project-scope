// esbuild 번들 스크립트 — extension.ts 를 out/extension.js 로 단일 번들
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  logLevel: "info",
};

/** 문법 색상 토크나이저 wasm (vscode-oniguruma) 을 out/ 로 */
function copyAssets() {
  const fs = require("fs");
  fs.mkdirSync("out", { recursive: true });
  fs.copyFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"), "out/onig.wasm");
}

async function main() {
  copyAssets();
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
