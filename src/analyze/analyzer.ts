/**
 * analyzer.ts — 확장이 직접 하는 분석: 구조 갱신(무료) + 요약(LLM)
 *
 * 갱신 refresh():
 *   언어 서버(executeDocumentSymbolProvider)로 파일의 함수·클래스와 범위를 다시 읽어
 *   기존 레코드와 대조(symbols.matchFile) —
 *     위치만 이동  → 같은 요약으로 새 범위 레코드 append (LLM 없음)
 *     사라짐       → 삭제 표시 append
 *     새 함수      → 메모리의 "분석 전" 항목 (store.setPending, jsonl 에는 안 씀)
 *     본문 변경    → 그대로 stale (분석 대상)
 *   대상 파일: 레코드가 있는 파일 + 열린 편집기 + git 변경 파일. mtime 이 그대로면 건너뜀.
 *
 * 분석 analyze():
 *   대상(stale·분석 전)을 파일별로 다시 스캔해 본문·범위·srcHash·호출(호출 계층)을
 *   확장이 만들고, LLM(claude CLI) 에게는 요약·파라미터만 받는다. 묶음마다 즉시 append.
 *   같은 대상은 동시에 한 번만(single-flight), 같은 본문(srcHash)은 자동 분석에서 다시 안 함.
 *
 * 자동 분석 auto(): 설정 autoAnalyze (off | onClick | onSave) + 시간당 한도.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FolderRef, ScopeEntry, ScopeRecord, ScopeStore } from "../store";
import { normalizeQual } from "../graph/callgraph";
import { IGNORED_PATH, SOURCE_FILE, type GitWatch } from "./git";
import { languageName, type EngineId, type SummarizeItem } from "./llm";
import { engineSettings, summarizeWith } from "./engines";
import {
  flatten,
  guessParams,
  matchFile,
  splitLines,
  type ExistingRec,
  type RawSymbol,
  type Scanned,
} from "./symbols";

export interface AnalyzerDeps {
  store: ScopeStore;
  folders: () => FolderRef[];
  jsonlPath: (folderRoot: string) => string;
  /** jsonl 다시 읽기 + 뷰 갱신 */
  reload: () => void;
  /** 뷰만 갱신 (분석 중 표시 등) */
  repaint: () => void;
  log: (msg: string) => void;
  cfg: () => vscode.WorkspaceConfiguration;
  git: () => GitWatch | undefined;
  /** 요약 언어 설정 값 — "ask" 면 사용자에게 물어 저장한 값, 취소하면 undefined */
  ensureLanguage: () => Promise<string | undefined>;
}

export interface RefreshReport {
  files: number;
  moved: number;
  gone: number;
  added: number;
  changed: number;
  skipped: string[];
}

export interface AnalyzeReport {
  done: number;
  failed: number;
  skipped: number;
  errors: string[];
  costUsd: number;
}

const MAX_CODE_LINES = 300;
const BATCH_ITEMS = 12;
const BATCH_CHARS = 60_000;
const PARALLEL = 2;
const PENDING_CALLS_CAP = 150;
const DEFAULT_EXCLUDE = "**/{node_modules,out,dist,build,target,bin,obj,.git,.scope,test,tests,__tests__,spec,fixtures,vendor,third_party}/**";

const LANG_OF: Record<string, string> = {
  typescriptreact: "typescript",
  javascriptreact: "javascript",
  "objective-c": "c",
  "objective-cpp": "cpp",
};

interface FileScan {
  abs: string;
  folder: FolderRef;
  rel: string;
  lines: string[];
  scanned: Scanned[];
  uri: vscode.Uri;
  lang: string;
}

export class ScopeAnalyzer {
  /** 절대경로 → 마지막 스캔 때 mtime */
  private scannedAt = new Map<string, number>();
  /** 절대경로 → 그 파일의 새 함수 (분석 전) */
  private pendingByFile = new Map<string, { rec: ScopeRecord; folderName: string; folderRoot: string }[]>();
  /** 절대경로 → 마지막 스캔 결과 (호출 대상 qual 찾기용) */
  private lastScan = new Map<string, Scanned[]>();
  private inFlight = new Set<string>();
  /** 자동 분석이 이미 시도한 본문 — key → srcHash (실패해도 같은 본문은 다시 안 함) */
  private tried = new Map<string, string>();
  private autoTimes: number[] = [];
  private capWarned = 0;
  private refreshing: Promise<RefreshReport> | undefined;
  /** 워크스페이스 폴더 세대 — 바뀌면 진행 중인 갱신 결과를 버린다 */
  private gen = 0;

  constructor(private deps: AnalyzerDeps) {}

  /**
   * 워크스페이스 폴더가 바뀜 (Project Hub 의 폴더 교체 포함).
   * 이전 폴더의 스캔 캐시·새 함수 목록을 버리고, 진행 중인 갱신은 결과를 쓰지 않게 한다.
   * (안 그러면 이전 폴더 기준 갱신이 새 스토어와 섞여 기존 함수가 전부 "분석 전"으로 보임)
   */
  resetFolders(): void {
    this.gen++;
    this.scannedAt.clear();
    this.pendingByFile.clear();
    this.lastScan.clear();
    this.deps.store.setPending([]);
  }

  /** 분석이 필요한 항목 — 본문이 바뀐 레코드 + 새 함수 */
  needs(filter?: (e: ScopeEntry) => boolean): ScopeEntry[] {
    return this.deps.store.all().filter((e) => (e.stale || e.pending) && !e.missing && (!filter || filter(e)));
  }

  get busyCount(): number {
    return this.inFlight.size;
  }

  // --- 구조 갱신 --------------------------------------------------------------

  /** 겹쳐 부르면 진행 중인 갱신이 끝난 뒤 한 번 더 */
  refresh(opts: { files?: string[]; full?: boolean } = {}): Promise<RefreshReport> {
    const run = async () => {
      if (this.refreshing) {
        await this.refreshing.catch(() => undefined);
      }
      return this.doRefresh(opts);
    };
    const p = run();
    this.refreshing = p;
    void p.finally(() => {
      if (this.refreshing === p) {
        this.refreshing = undefined;
      }
    });
    return p;
  }

  private async doRefresh(opts: { files?: string[]; full?: boolean }): Promise<RefreshReport> {
    const report: RefreshReport = { files: 0, moved: 0, gone: 0, added: 0, changed: 0, skipped: [] };
    const store = this.deps.store;
    const gen = this.gen;
    const folders = this.deps.folders();
    const aborted = (): RefreshReport => {
      this.deps.log("refresh: aborted — workspace folders changed");
      return { files: 0, moved: 0, gone: 0, added: 0, changed: 0, skipped: [] };
    };
    // 지금 열려 있지 않은 폴더의 새 함수 목록은 버린다
    for (const [abs, list] of this.pendingByFile) {
      if (!folderOf(folders, abs) || list.some((p) => !folders.some((f) => f.fsPath === p.folderRoot))) {
        this.pendingByFile.delete(abs);
      }
    }
    const explicit = new Set((opts.files ?? []).map((f) => path.normalize(f)));

    // 대상 파일: 레코드 파일 + (전체 갱신이면) 열린 편집기·git 변경 + 명시된 파일
    const targets = new Set<string>(explicit);
    if (!opts.files) {
      for (const e of store.all()) {
        if (!e.pending) {
          targets.add(path.normalize(path.join(e.folderRoot, e.record.file)));
        }
      }
      for (const d of vscode.workspace.textDocuments) {
        if (d.uri.scheme === "file" && SOURCE_FILE.test(d.uri.fsPath)) {
          targets.add(path.normalize(d.uri.fsPath));
        }
      }
      for (const f of this.deps.git()?.changedFiles() ?? []) {
        targets.add(path.normalize(f));
      }
      for (const f of this.pendingByFile.keys()) {
        targets.add(f);
      }
      for (const f of await this.discover()) {
        targets.add(f);
      }
      if (gen !== this.gen) {
        return aborted();
      }
    }

    const appendBy = new Map<string, object[]>();
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    let pendingCalls = 0;
    for (const abs of targets) {
      const folder = folderOf(folders, abs);
      if (!folder || IGNORED_PATH.test(abs)) {
        continue;
      }
      const rel = path.relative(folder.fsPath, abs).split(path.sep).join("/");
      const recs = store
        .all()
        .filter((e) => !e.pending && e.folderRoot === folder.fsPath && e.record.file === rel);
      let mtime = -1;
      try {
        mtime = fs.statSync(abs).mtimeMs;
      } catch {
        // 파일 자체가 사라짐 — 레코드 전부 삭제 표시
        for (const e of recs) {
          push(appendBy, folder.fsPath, { v: 1, target: e.record.target, deleted: true, generatedAt: now });
          report.gone++;
        }
        this.pendingByFile.delete(abs);
        this.scannedAt.delete(abs);
        continue;
      }
      const hasStale = recs.some((e) => e.stale);
      if (!opts.full && !explicit.has(abs) && !hasStale && this.scannedAt.get(abs) === mtime) {
        continue;
      }
      const scan = await this.scanFile(abs, folder);
      if (gen !== this.gen) {
        return aborted();
      }
      if (!scan) {
        report.skipped.push(rel);
        continue;
      }
      if (scan.scanned.length === 0 && recs.length > 0) {
        // 언어 서버가 아직 준비 안 됐을 수 있음 — 지우지 않고 다음 기회에
        report.skipped.push(rel);
        continue;
      }
      report.files++;
      this.scannedAt.set(abs, mtime);
      this.lastScan.set(abs, scan.scanned);
      const m = matchFile(
        recs.map((e) => toExisting(e)),
        scan.scanned,
        scan.lines
      );
      for (const mv of m.moved) {
        const old = mv.rec.entry.record;
        push(appendBy, folder.fsPath, {
          ...recordJson(old),
          line: mv.line,
          endLine: mv.endLine,
          generatedAt: now,
        });
        report.moved++;
      }
      for (const g of m.gone) {
        push(appendBy, folder.fsPath, { v: 1, target: g.target, deleted: true, generatedAt: now });
        report.gone++;
      }
      report.changed += m.changed.length;
      const pend: { rec: ScopeRecord; folderName: string; folderRoot: string }[] = [];
      for (const s of m.added) {
        let calls: string[] | undefined;
        if (s.kind === "func" && pendingCalls < PENDING_CALLS_CAP) {
          pendingCalls++;
          calls = await this.callsOf(scan, s);
        }
        pend.push({
          folderName: folder.name,
          folderRoot: folder.fsPath,
          rec: {
            v: 1,
            target: `${s.kind}:${rel}:${s.qual}`,
            kind: s.kind,
            name: s.name,
            file: rel,
            line: s.line,
            endLine: s.endLine,
            lang: scan.lang,
            srcHash: s.srcHash,
            summary: "",
            params: s.kind === "func" ? guessParams(header(scan.lines, s)) : undefined,
            calls: calls?.length ? calls : undefined,
            ns: s.ns,
            generatedAt: "",
          },
        });
      }
      if (gen !== this.gen) {
        return aborted();
      }
      report.added += pend.length;
      if (pend.length) {
        this.pendingByFile.set(abs, pend);
      } else {
        this.pendingByFile.delete(abs);
      }
    }

    store.setPending([...this.pendingByFile.values()].flat());
    for (const [root, lines] of appendBy) {
      this.append(root, lines);
    }
    this.deps.log(
      `refresh: files=${report.files} moved=${report.moved} gone=${report.gone} added=${report.added} changed=${report.changed}` +
        (report.skipped.length ? ` skipped=${report.skipped.join(",")}` : "")
    );
    this.deps.reload();
    return report;
  }

  // --- 요약 분석 ----------------------------------------------------------------

  async analyze(
    entries: ScopeEntry[],
    opts: { auto?: boolean; token?: vscode.CancellationToken; progress?: (msg: string, inc: number) => void } = {}
  ): Promise<AnalyzeReport> {
    const rep: AnalyzeReport = { done: 0, failed: 0, skipped: 0, errors: [], costUsd: 0 };
    const store = this.deps.store;
    const cfg = this.deps.cfg();
    const engine = cfg.get<string>("analyzer", "claude-cli") ?? "claude-cli";
    if (engine === "off") {
      rep.errors.push(vscode.l10n.t("The analysis engine is turned off (projectScope.analyzer)"));
      return rep;
    }
    // 요약 언어가 정해지지 않았으면 분석 전에 묻는다 (취소 = 분석 안 함)
    const langSetting = await this.deps.ensureLanguage();
    if (!langSetting) {
      rep.errors.push(vscode.l10n.t("Analysis cancelled — no summary language chosen"));
      return rep;
    }
    const todo = entries.filter((e) => {
      const k = keyOf(e);
      // 자동 분석은 바뀐·새 항목만 (수동은 최신이어도 다시 분석 가능)
      if (this.inFlight.has(k) || e.missing || (opts.auto && !e.stale && !e.pending)) {
        rep.skipped++;
        return false;
      }
      return true;
    });
    if (todo.length === 0) {
      return rep;
    }
    for (const e of todo) {
      this.inFlight.add(keyOf(e));
      store.setBusy(e.folderRoot, e.record.target, true);
    }
    this.deps.repaint();

    // 파일별로 다시 스캔해 대상의 현재 위치·본문 확정
    type Job = { entry: ScopeEntry; scan: FileScan; sym: Scanned; item: SummarizeItem };
    const jobs: Job[] = [];
    const byFile = new Map<string, ScopeEntry[]>();
    for (const e of todo) {
      const abs = path.normalize(path.join(e.folderRoot, e.record.file));
      byFile.set(abs, [...(byFile.get(abs) ?? []), e]);
    }
    const release = (e: ScopeEntry) => {
      this.inFlight.delete(keyOf(e));
      store.setBusy(e.folderRoot, e.record.target, false);
    };
    for (const [abs, list] of byFile) {
      const folder = this.deps.folders().find((f) => f.fsPath === list[0].folderRoot);
      const scan = folder && (await this.scanFile(abs, folder));
      if (!scan) {
        for (const e of list) {
          rep.skipped++;
          release(e);
        }
        rep.errors.push(vscode.l10n.t("{0}: could not read symbols (no language server or unsaved changes)", list[0].record.file));
        continue;
      }
      this.lastScan.set(abs, scan.scanned);
      for (const e of list) {
        const sym = findSym(scan.scanned, e);
        if (!sym) {
          rep.skipped++;
          release(e);
          continue;
        }
        if (opts.auto) {
          if (this.tried.get(keyOf(e)) === sym.srcHash) {
            rep.skipped++;
            release(e);
            continue;
          }
          this.tried.set(keyOf(e), sym.srcHash);
        }
        jobs.push({
          entry: e,
          scan,
          sym,
          item: {
            id: String(jobs.length),
            kind: sym.kind,
            qual: sym.qual,
            lang: scan.lang,
            file: scan.rel,
            line: sym.line,
            endLine: sym.endLine,
            code: codeOf(scan.lines, sym),
          },
        });
      }
    }

    // 묶음 만들기 (항목 수·글자 수 한도)
    const batches: Job[][] = [];
    let cur: Job[] = [];
    let chars = 0;
    for (const j of jobs) {
      if (cur.length >= BATCH_ITEMS || (cur.length && chars + j.item.code.length > BATCH_CHARS)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(j);
      chars += j.item.code.length;
    }
    if (cur.length) {
      batches.push(cur);
    }

    const llmOpt = {
      model: cfg.get<string>("analyzeModel", "sonnet") ?? "",
      language: languageName(langSetting, vscode.env.language),
      timeoutMs: 300_000,
    };
    const settings = engineSettings(cfg);
    const total = jobs.length;
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        if (opts.token?.isCancellationRequested) {
          for (const j of batch) {
            rep.skipped++;
            release(j.entry);
          }
          continue;
        }
        try {
          const res = await summarizeWith(
            engine as EngineId,
            batch.map((j) => j.item),
            { ...llmOpt, onCancel: (kill) => opts.token?.onCancellationRequested(kill) },
            settings,
            opts.token
          );
          rep.costUsd += res.costUsd ?? 0;
          const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
          const lines = new Map<string, object[]>();
          for (const j of batch) {
            const got = res.items.get(j.item.id);
            if (!got) {
              rep.failed++;
              continue;
            }
            const calls = j.sym.kind === "func" ? await this.callsOf(j.scan, j.sym) : undefined;
            const old = j.entry.record;
            push(lines, j.entry.folderRoot, {
              v: 1,
              target: old.target,
              kind: old.kind,
              name: old.name,
              file: old.file,
              line: j.sym.line,
              endLine: j.sym.endLine,
              lang: j.entry.pending ? j.scan.lang : old.lang,
              srcHash: j.sym.srcHash,
              summary: got.summary,
              ...(old.kind === "func"
                ? { params: got.params ?? old.params ?? guessParams(header(j.scan.lines, j.sym)) }
                : {}),
              ...(old.kind === "func" ? { calls: calls ?? old.calls ?? [] } : {}),
              ...(old.imports ? { imports: old.imports } : {}),
              ...((j.sym.ns ?? old.ns) ? { ns: j.sym.ns ?? old.ns } : {}),
              ...(old.entry ? { entry: true } : {}),
              model: res.model ?? (llmOpt.model || engine),
              generatedAt: now,
            });
            rep.done++;
          }
          for (const [root, l] of lines) {
            this.append(root, l);
          }
        } catch (e) {
          rep.failed += batch.length;
          const msg = (e as Error).message;
          if (!rep.errors.includes(msg)) {
            rep.errors.push(msg);
          }
          this.deps.log(`analyze: failed — ${msg}`);
        } finally {
          for (const j of batch) {
            release(j.entry);
          }
          opts.progress?.(`${rep.done + rep.failed}/${total}`, (batch.length / Math.max(1, total)) * 100);
          this.deps.reload();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
    // 위치 확인 단계에서 제외된 것도 확실히 해제
    for (const e of todo) {
      if (this.inFlight.has(keyOf(e))) {
        release(e);
      }
    }
    this.deps.log(
      `analyze: done=${rep.done} failed=${rep.failed} skipped=${rep.skipped} cost=$${rep.costUsd.toFixed(4)}` +
        (rep.errors.length ? ` errors=${rep.errors.join(" | ")}` : "")
    );
    this.deps.reload();
    return rep;
  }

  /** 자동 분석 — 설정과 시간당 한도를 지키며 백그라운드로 */
  auto(entries: ScopeEntry[], trigger: "click" | "save"): void {
    const mode = this.deps.cfg().get<string>("autoAnalyze", "off");
    if (mode === "off" || (trigger === "click" && mode !== "onClick" && mode !== "onSave") || (trigger === "save" && mode !== "onSave")) {
      return;
    }
    const want = entries.filter((e) => (e.stale || e.pending) && !e.missing && !this.inFlight.has(keyOf(e)));
    if (want.length === 0) {
      return;
    }
    const hour = Date.now() - 3_600_000;
    this.autoTimes = this.autoTimes.filter((t) => t > hour);
    const max = this.deps.cfg().get<number>("autoAnalyzeMaxPerHour", 60);
    const room = Math.max(0, max - this.autoTimes.length);
    if (room === 0) {
      if (Date.now() - this.capWarned > 3_600_000) {
        this.capWarned = Date.now();
        void vscode.window.showWarningMessage(
          vscode.l10n.t("Scope: auto-analysis reached its hourly limit ({0}) — manual analysis still works (projectScope.autoAnalyzeMaxPerHour)", String(max))
        );
      }
      return;
    }
    const pick = want.slice(0, room);
    for (const _ of pick) {
      this.autoTimes.push(Date.now());
    }
    void this.analyze(pick, { auto: true }).then((r) => {
      if (r.errors.length && r.done === 0) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Scope auto-analysis failed: {0}", r.errors[0]));
      }
    });
  }

  // --- 내부 ------------------------------------------------------------------------

  /**
   * 기록이 없는 새 소스 파일 찾기 — git 이 없어도 새 파일이 보이도록.
   * 범위: 설정 scanInclude (비우면 이미 분석된 파일들의 최상위 폴더, 예: src/**),
   * 제외: scanExclude (테스트·빌드·의존성 폴더)
   */
  private async discover(): Promise<string[]> {
    const cfg = this.deps.cfg();
    const exclude = cfg.get<string>("scanExclude", DEFAULT_EXCLUDE) || DEFAULT_EXCLUDE;
    const include = cfg.get<string>("scanInclude", "") ?? "";
    const out: string[] = [];
    for (const f of this.deps.folders()) {
      let glob = include;
      if (!glob) {
        const tops = new Set<string>();
        for (const e of this.deps.store.all()) {
          if (e.folderRoot === f.fsPath && !e.pending && e.record.file.includes("/")) {
            tops.add(e.record.file.split("/")[0]);
          }
        }
        if (tops.size === 0) {
          continue;
        }
        glob = `{${[...tops].join(",")}}/**/*`;
      }
      try {
        const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(f.fsPath, glob), exclude, 3000);
        for (const u of uris) {
          if (SOURCE_FILE.test(u.fsPath) && !IGNORED_PATH.test(u.fsPath)) {
            out.push(path.normalize(u.fsPath));
          }
        }
      } catch {
        // 검색 실패는 무시 — 기존 파일 갱신은 계속
      }
    }
    return out;
  }

  /** 디스크 내용 기준 스캔 — 편집 중(저장 안 됨)이면 범위가 어긋나므로 건너뜀 */
  private async scanFile(abs: string, folder: FolderRef): Promise<FileScan | undefined> {
    try {
      const uri = vscode.Uri.file(abs);
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.isDirty) {
        return undefined;
      }
      const raw = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
        "vscode.executeDocumentSymbolProvider",
        uri
      );
      if (!raw) {
        return undefined;
      }
      const lines = splitLines(fs.readFileSync(abs, "utf8"));
      return {
        abs,
        folder,
        rel: path.relative(folder.fsPath, abs).split(path.sep).join("/"),
        lines,
        scanned: flatten(toRaw(raw), lines),
        uri,
        lang: LANG_OF[doc.languageId] ?? doc.languageId,
      };
    } catch (e) {
      this.deps.log(`scan: ${abs} — ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * 호출 계층(언어 서버)으로 이 함수가 부르는 프로젝트 내부 함수 — 규약 calls 표기
   * (메서드는 `Class.method`, 그 외 이름만). 언어 서버가 지원 안 하면 undefined.
   */
  private async callsOf(scan: FileScan, sym: Scanned): Promise<string[] | undefined> {
    try {
      const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        "vscode.prepareCallHierarchy",
        scan.uri,
        new vscode.Position(sym.selLine - 1, sym.selChar)
      );
      if (!items || items.length === 0) {
        return undefined;
      }
      const outs = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
        "vscode.provideOutgoingCalls",
        items[0]
      );
      const calls: string[] = [];
      for (const o of outs ?? []) {
        const abs = path.normalize(o.to.uri.fsPath);
        if (o.to.uri.scheme !== "file" || IGNORED_PATH.test(abs) || !folderOf(this.deps.folders(), abs)) {
          continue;
        }
        const line = o.to.selectionRange.start.line + 1;
        const qual = this.qualAt(abs, line, o.to.name);
        if (!qual || qual === sym.qual && abs === scan.abs) {
          continue;
        }
        const segs = qual.split(".");
        const isMethod = segs.length > 1 && segs[segs.length - 2] !== "<locals>";
        const text = isMethod ? segs.slice(-2).join(".") : segs[segs.length - 1];
        if (!calls.includes(text)) {
          calls.push(text);
        }
      }
      return calls;
    } catch {
      return undefined;
    }
  }

  /** 파일의 그 줄을 정의로 가진 함수·클래스 qual — 마지막 스캔 결과, 없으면 레코드 */
  private qualAt(abs: string, line: number, name: string): string | undefined {
    const inner = <T extends { line: number; endLine: number }>(list: T[]) =>
      list
        .filter((x) => x.line <= line && line <= x.endLine)
        .sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
    const s = inner(this.lastScan.get(abs) ?? []) as Scanned | undefined;
    if (s) {
      return s.qual;
    }
    const recs = this.deps.store
      .all()
      .filter((e) => path.normalize(path.join(e.folderRoot, e.record.file)) === abs)
      .map((e) => ({ line: e.record.line, endLine: e.record.endLine, qual: normalizeQual(qualPart(e.record.target)) }));
    return inner(recs)?.qual ?? name;
  }

  /** jsonl 끝에 줄들을 한 번에 append — 마지막 줄에 개행이 없으면 먼저 보충 */
  private append(folderRoot: string, objs: object[]): void {
    if (objs.length === 0) {
      return;
    }
    const p = this.deps.jsonlPath(folderRoot);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let lead = "";
    try {
      const st = fs.statSync(p);
      if (st.size > 0) {
        const fd = fs.openSync(p, "r");
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, st.size - 1);
        fs.closeSync(fd);
        lead = b[0] === 0x0a ? "" : "\n";
      }
    } catch {
      // 새 파일
    }
    fs.appendFileSync(p, lead + objs.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
  }
}

// --- 도우미 ------------------------------------------------------------------------

function keyOf(e: ScopeEntry): string {
  return `${e.folderRoot}\u0000${e.record.target}`;
}

function qualPart(target: string): string {
  return target.split(":").slice(2).join(":");
}

function folderOf(folders: FolderRef[], abs: string): FolderRef | undefined {
  return folders
    .filter((f) => abs === f.fsPath || abs.startsWith(f.fsPath + path.sep))
    .sort((a, b) => b.fsPath.length - a.fsPath.length)[0];
}

function push(m: Map<string, object[]>, k: string, v: object): void {
  const l = m.get(k);
  if (l) {
    l.push(v);
  } else {
    m.set(k, [v]);
  }
}

function toExisting(e: ScopeEntry): ExistingRec & { entry: ScopeEntry } {
  const r = e.record;
  return { target: r.target, kind: r.kind, qual: normalizeQual(qualPart(r.target)), line: r.line, endLine: r.endLine, srcHash: r.srcHash, entry: e };
}

/** 레코드를 그대로 다시 쓸 때의 JSON (undefined 필드 제외) */
function recordJson(r: ScopeRecord): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v !== undefined) {
      o[k] = v;
    }
  }
  return o;
}

/** 레코드에 대응하는 현재 심볼 — qual 일치, 없으면 같은 이름·kind 중 가장 가까운 줄 */
function findSym(list: Scanned[], e: ScopeEntry): Scanned | undefined {
  const q = normalizeQual(qualPart(e.record.target));
  const exact = list.find((s) => s.kind === e.record.kind && s.qual === q);
  if (exact) {
    return exact;
  }
  return list
    .filter((s) => s.kind === e.record.kind && s.name === e.record.name)
    .sort((a, b) => Math.abs(a.line - e.record.line) - Math.abs(b.line - e.record.line))[0];
}

function header(lines: string[], s: Scanned): string {
  return lines.slice(s.selLine - 1, Math.min(s.endLine, s.selLine + 4)).join("\n");
}

function codeOf(lines: string[], s: Scanned): string {
  const body = lines.slice(s.line - 1, s.endLine);
  if (body.length <= MAX_CODE_LINES) {
    return body.join("\n");
  }
  return body.slice(0, MAX_CODE_LINES).join("\n") + `\n… (${body.length - MAX_CODE_LINES} more lines)`;
}

const KIND_MAP: Partial<Record<vscode.SymbolKind, RawSymbol["kind"]>> = {
  [vscode.SymbolKind.Class]: "class",
  [vscode.SymbolKind.Struct]: "class",
  [vscode.SymbolKind.Function]: "func",
  [vscode.SymbolKind.Method]: "func",
  [vscode.SymbolKind.Constructor]: "func",
  [vscode.SymbolKind.Namespace]: "ns",
  [vscode.SymbolKind.Module]: "ns",
  [vscode.SymbolKind.Package]: "ns",
  [vscode.SymbolKind.Variable]: "var",
  [vscode.SymbolKind.Constant]: "var",
  [vscode.SymbolKind.Property]: "var",
  [vscode.SymbolKind.Field]: "var",
};

/** DocumentSymbol(계층) 또는 SymbolInformation(평면, containerName) → RawSymbol 트리 */
function toRaw(list: (vscode.DocumentSymbol | vscode.SymbolInformation)[]): RawSymbol[] {
  const kindOf = (k: vscode.SymbolKind, name: string): RawSymbol["kind"] =>
    k === vscode.SymbolKind.Object && /^impl\b/.test(name) ? "impl" : KIND_MAP[k] ?? "other";
  if (list.length > 0 && "children" in list[0]) {
    const conv = (d: vscode.DocumentSymbol): RawSymbol => ({
      name: d.name,
      kind: kindOf(d.kind, d.name),
      line: d.range.start.line + 1,
      endLine: d.range.end.line + 1,
      selLine: d.selectionRange.start.line + 1,
      selChar: d.selectionRange.start.character,
      children: (d.children ?? []).map(conv),
    });
    return (list as vscode.DocumentSymbol[]).map(conv);
  }
  // 평면 목록 — containerName 이 바로 위 컨테이너 이름이라고 보고 이름으로 잇는다
  const nodes = (list as vscode.SymbolInformation[]).map((s) => ({
    info: s,
    raw: {
      name: s.name,
      kind: kindOf(s.kind, s.name),
      line: s.location.range.start.line + 1,
      endLine: s.location.range.end.line + 1,
      selLine: s.location.range.start.line + 1,
      selChar: s.location.range.start.character,
      children: [],
    } as RawSymbol,
  }));
  const roots: RawSymbol[] = [];
  for (const n of nodes) {
    const parent = n.info.containerName
      ? nodes.find(
          (p) =>
            p !== n &&
            p.info.name === n.info.containerName &&
            p.raw.line <= n.raw.line &&
            n.raw.endLine <= p.raw.endLine
        )
      : undefined;
    (parent ? parent.raw.children : roots).push(n.raw);
  }
  return roots;
}
