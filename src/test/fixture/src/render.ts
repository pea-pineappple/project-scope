/** fixture — 렌더 유틸. TS 쪽 분석 대상 샘플. */
export interface Cell {
  row: number;
  col: number;
  ch: string;
}

export function renderGrid(width: number, height: number): string[] {
  const rows: string[] = [];
  for (let r = 0; r < height; r++) {
    let line = "";
    for (let c = 0; c < width; c++) {
      line += cellChar(r, c, width, height);
    }
    rows.push(line);
  }
  return rows;
}

function cellChar(r: number, c: number, w: number, h: number): string {
  const border = r === 0 || c === 0 || r === h - 1 || c === w - 1;
  return border ? "+" : "-";
}

export function blankCell(row: number, col: number): Cell {
  return { row, col, ch: " " };
}
