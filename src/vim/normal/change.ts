// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/change.rs
// - translated concepts: change by motion and change current line
// - intentional differences: this first slice reuses delete behavior and lets the caller
//   switch to insert mode; Zed has richer recording, indentation, and selection fixups.

import { VimEditorCapabilities, keepUndoTransactionOpen } from "../editor.js";
import { Motion, changeMotionRange } from "../motion.js";
import { RegisterName, Registers } from "../registers.js";
import { TextRange, selectionHead } from "../state.js";
import { LinewiseOperationRange, deleteRange } from "./delete.js";

// Zed: `normal::change::Vim::change_motion`.
export function changeMotion(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  motion: Motion,
  count: number
): boolean {
  if (motion.type === "up" || motion.type === "down") {
    const ranges = editor.getSelections().map(selection => {
      const head = selectionHead(selection);
      const targetRow = Math.max(0, Math.min(head.row + (motion.type === "up" ? -count : count), editor.lineCount() - 1));
      return targetRow === head.row ? undefined : { startRow: Math.min(head.row, targetRow), endRow: Math.max(head.row, targetRow), column: head.column };
    }).filter(range => range !== undefined);
    return changeLineRange(editor, registers, registerName, ranges);
  }

  changeRange(editor, registers, registerName, (head) => changeMotionRange(editor, head, motion, count));
  return true;
}

export function changeRange(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  rangeForHead: (head: ReturnType<typeof selectionHead>) => TextRange
): void {
  deleteRange(
    editor,
    registers,
    registerName,
    rangeForHead,
    (_editor, range) => range.start,
    keepUndoTransactionOpen()
  );
}

export function changeLineRange(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  ranges: readonly LinewiseOperationRange[]
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
    const cursorRow = rangeInfo.cursorRow ?? startRow;
    selectionsAfter.push({ type: "charwise" as const, anchor: { row: cursorRow, column: indent.length }, head: { row: cursorRow, column: indent.length } });
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

// Zed: `Motion::CurrentLine` flowing into `normal::change::Vim::change_motion`.
export function changeLines(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  count: number
): void {
  const ranges = editor.getSelections().map(selection => {
    const head = selectionHead(selection);
    return {
      startRow: head.row,
      endRow: Math.min(head.row + count - 1, editor.lineCount() - 1),
      column: head.column,
    };
  });
  changeLineRange(editor, registers, registerName, ranges);
}

function indentation(line: string): string {
  return line.slice(0, line.search(/\S/) < 0 ? 0 : line.search(/\S/));
}
