// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/increment.rs
// - translated concepts: normal-mode increment/decrement of the next number under or
//   after the cursor
// - intentional differences: this first local slice supports decimal integers only.

import { VimEditorCapabilities } from "../editor.js";
import { TextEdit, VimSelection, charwiseSelection, selectionHead } from "../state.js";

export function incrementNumbers(editor: VimEditorCapabilities, delta: number): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];

  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const target = findDecimalNumber(editor.line(head.row), head.column);
    if (target === undefined) {
      selectionsAfter.push(charwiseSelection(head));
      continue;
    }

    const nextValue = incrementDecimalText(target.text, delta);
    edits.push({
      range: { start: { row: head.row, column: target.start }, end: { row: head.row, column: target.end } },
      text: nextValue,
    });
    selectionsAfter.push(charwiseSelection({ row: head.row, column: target.start + Math.max(0, nextValue.length - 1) }));
  }

  if (edits.length === 0) editor.setSelections(selectionsAfter);
  else editor.applyEdits(edits, selectionsAfter);
}

function incrementDecimalText(text: string, delta: number): string {
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  const next = Number(text) + delta;
  const nextNegative = next < 0;
  const absolute = String(Math.abs(next));
  const shouldPad = digits.startsWith("0") && absolute.length <= digits.length;
  const padded = shouldPad ? absolute.padStart(digits.length, "0") : absolute;
  return nextNegative ? `-${padded}` : padded;
}

type DecimalTarget = { start: number; end: number; text: string };

function findDecimalNumber(line: string, column: number): DecimalTarget | undefined {
  const regex = /-?\d+/g;
  for (const match of line.matchAll(regex)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (column < end && !(column === end - 1 && line[end] === "." && /\d/.test(line[end + 1] ?? ""))) {
      return { start, end, text: match[0] };
    }
  }
  return undefined;
}
