// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/change.rs
// - translated concepts: change by motion and change current line
// - intentional differences: this first slice reuses delete behavior and lets the caller
//   switch to insert mode; Zed has richer recording, indentation, and selection fixups.

import { VimEditorCapabilities, keepUndoTransactionOpen } from "../editor.js";
import type { ResolvedTarget, RowRange } from "../operator_target.js";
import { RegisterName, Registers } from "../registers.js";
import { deleteTargets } from "./delete.js";

// Zed: `normal::change::Vim::change_motion` / `change_object`; one application
// for every change target source (motion, line, object, visual). Returns
// whether the editor should enter insert mode.
export function applyChange(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  target: ResolvedTarget
): boolean {
  switch (target.kind) {
    case "charwise": {
      // Vim: change deletes the range and leaves the cursor at its start,
      // entering insert there (`:h c`) — including ranges a successful motion
      // left empty (`cb` onto an empty line). Cancelled targets (`cap` on a
      // trailing blank line, a failed motion) keep the cursor and suppress
      // insert-mode entry.
      const targets = target.targets.map(charwiseTarget =>
        charwiseTarget.cancelled === true
          ? charwiseTarget
          : { ...charwiseTarget, cursor: charwiseTarget.cursor ?? charwiseTarget.range.start });
      deleteTargets(editor, registers, registerName, targets, (_editor, range) => range.start, keepUndoTransactionOpen());
      return target.targets.some(({ cancelled }) => cancelled !== true);
    }
    case "linewise":
      return changeLineRange(editor, registers, registerName, target.rows);
  }
}

export function changeLineRange(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  ranges: readonly RowRange[]
): boolean {
  if (ranges.length === 0) return false;

  const edits = [];
  const copied: string[] = [];
  const selectionsAfter = [];

  for (const rangeInfo of ranges) {
    const startRow = rangeInfo.startRow;
    const endRow = rangeInfo.endRow;
    const lines: string[] = [];
    for (let row = startRow; row <= endRow; row++) lines.push(editor.line(row));
    copied.push(`${lines.join("\n")}\n`);
    const range = endRow + 1 < editor.lineCount()
      ? { start: { row: startRow, column: 0 }, end: { row: endRow + 1, column: 0 } }
      : { start: { row: startRow, column: 0 }, end: { row: endRow, column: editor.lineLength(endRow) } };
    const indent = indentation(editor.line(startRow));
    const deletingWholeDocument = startRow === 0 && endRow === editor.lineCount() - 1;
    const replacement = deletingWholeDocument
      ? ""
      : endRow + 1 < editor.lineCount() ? `${indent}\n` : indent;
    edits.push({ range, text: replacement });
    selectionsAfter.push({ type: "charwise" as const, anchor: { row: startRow, column: indent.length }, head: { row: startRow, column: indent.length } });
  }

  if (copied.length > 0) {
    registers.writeDelete(
      registerName,
      copied.join(""),
      "linewise",
      copied.map(text => ({ text, kind: "linewise" }))
    );
  }
  editor.applyEdits(edits, selectionsAfter, keepUndoTransactionOpen());
  return true;
}

function indentation(line: string): string {
  return line.slice(0, line.search(/\S/) < 0 ? 0 : line.search(/\S/));
}
