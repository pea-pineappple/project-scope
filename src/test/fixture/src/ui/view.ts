/** fixture — named import 와 namespace import 가 같은 이름을 가리키는 경우. */
import { blankCell } from "../render";
import * as cells from "./cell";

export function makeRow(n: number): unknown[] {
  const a = blankCell(0, n);
  const b = cells.blankCell(n);
  return [a, b];
}
