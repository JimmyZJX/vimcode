// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/yank.rs
// - translated concepts: yank by motion and yank current line
// - intentional differences: this first slice writes only an unnamed clipboard string.

import { VimEditorCapabilities, normalCursorPosition, rangeText } from "../editor.js";
import type { CharwiseTarget, ResolvedTarget, RowRange } from "../operator_target.js";
import { RegisterName, Registers } from "../registers.js";
import { charwiseSelection, comparePositions } from "../state.js";

// Zed: `normal::yank::Vim::yank_motion` / `yank_object`; one application for
// every yank target source (motion, line, object, visual).
export function applyYank(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  target: ResolvedTarget
): void {
  switch (target.kind) {
    case "charwise":
      yankTargets(editor, registers, registerName, target.targets);
      return;
    case "linewise":
      yankLineRanges(editor, registers, registerName, target.rows);
      return;
  }
}

export function yankTargets(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  targets: readonly CharwiseTarget[]
): void {
  const copied = targets.map(({ range }) => rangeText(editor, range));

  if (copied.length > 0) {
    registers.writeYank(
      registerName,
      copied.join("\n"),
      "characterwise",
      copied.map(text => ({ text, kind: "characterwise" }))
    );
  }
  // Vim moves the cursor to the start of the yanked region (in effect only
  // for backward motions, where the range starts before the cursor).
  editor.setSelections(targets.map(({ range, head }) =>
    charwiseSelection(comparePositions(range.start, head) < 0 ? range.start : head)));
}

// Zed: `normal::Vim::yank_line` dispatches `Motion::CurrentLine` to `yank_motion`.
export function yankLineRanges(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  rows: readonly RowRange[]
): void {
  if (rows.length === 0) return;
  const copied = rows.map(({ startRow, endRow }) => linewiseContent(editor, startRow, endRow - startRow + 1));
  if (copied.length > 0) {
    registers.writeYank(
      registerName,
      copied.join(""),
      "linewise",
      copied.map(text => ({ text, kind: "linewise" }))
    );
  }
  // Vim moves the cursor to the start of a linewise-yanked region.
  editor.setSelections(rows.map(({ startRow, column }) =>
    charwiseSelection(normalCursorPosition(editor, { row: startRow, column }))));
}

function linewiseContent(editor: VimEditorCapabilities, row: number, count: number): string {
  const startRow = Math.max(0, Math.min(row, editor.lineCount() - 1));
  const endRow = Math.min(startRow + count, editor.lineCount());
  const lines: string[] = [];
  for (let current = startRow; current < endRow; current++) lines.push(editor.line(current));
  return `${lines.join("\n")}\n`;
}
