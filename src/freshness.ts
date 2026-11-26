/**
 * freshness.ts — srcHash 재계산 및 stale 판정
 *
 * 규약: srcHash = 파일의 line..endLine 범위 원문의 sha1 앞 16자.
 * 줄 끝 \r 은 제거하고 \n 으로 잇는다 — CRLF 파일도 LF 와 같은 해시 (Python splitlines 와 동일).
 * 현재 소스 해시 != 레코드 해시면 stale (본문이 수정됨).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ScopeRecord } from "./store";

/** 임의 텍스트의 sha1 앞 16자 — 규약의 해시 정의 그대로 */
export function sha1_16(text: string): string {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * record.line..record.endLine (1-based, inclusive) 범위 원문을 추출.
 * 파일을 읽지 못하면 null.
 */
export function extractBody(absFile: string, line: number, endLine: number): string | null {
  let text: string;
    try {
    text = fs.readFileSync(absFile, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  // 1-based inclusive → slice (line-1 .. endLine)
  const from = Math.max(0, line - 1);
  const to = Math.min(lines.length, endLine);
  if (from >= to) {
    return null; // 범위 비정상
  }
  return lines.slice(from, to).join("\n");
}

export interface Freshness {
  stale: boolean;
  /** 소스 파일 부재/판독 불가 — 판정 자체가 불가 */
  missing: boolean;
}

/** 단일 레코드의 신선도 판정 */
export function checkFreshness(workspaceRoot: string, rec: ScopeRecord): Freshness {
  const abs = path.join(workspaceRoot, rec.file);
  const body = extractBody(abs, rec.line, rec.endLine);
  if (body === null) {
    return { stale: false, missing: true };
  }
  return { stale: sha1_16(body) !== rec.srcHash, missing: false };
}
