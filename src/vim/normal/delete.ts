// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/delete.rs
// - translated concepts: delete by motion, delete current line, delete character
// - intentional differences: this first slice uses simple text ranges and the unnamed
//   clipboard string; linewise, register, visual, and multicursor fidelity are incomplete.

import { ApplyEditsOptions, VimEditorCapabilities, normalCursorPosition, rangeText } from "../editor.js";
import { Motion, lineRange, linewiseCursorAfterDelete, motionRange } from "../motion.js";
import { RegisterName, Registers } from "../registers.js";
import {
  TextEdit,
  VimSelection,
  charwiseSelection,
  orderedRange,
  selectionHead,
} from "../state.js";

export type LinewiseOperationRange = { startRow: number; endRow: number; column: number; cursorRow?: number };

// Zed: `normal::delete::Vim::delete_motion`.
export function deleteMotion(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  motion: Motion,
  count: number
): void {
  if (motion.type === "up" || motion.type === "down") {
    const ranges = editor.getSelections().map(selection => {
      const head = selectionHead(selection);
      const targetRow = Math.max(0, Math.min(head.row + (motion.type === "up" ? -count : count), editor.lineCount() - 1));
      return targetRow === head.row ? undefined : { startRow: Math.min(head.row, targetRow), endRow: Math.max(head.row, targetRow), column: head.column };
    }).filter(range => range !== undefined);
    deleteLineRange(editor, registers, registerName, ranges);
    return;
  }

  deleteRange(editor, registers, registerName, (head) => motionRange(editor, head, motion, count));
}

export function deleteRange(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  rangeForHead: (head: ReturnType<typeof selectionHead>) => TextEdit["range"],
  cursorForRange: (editor: VimEditorCapabilities, range: TextEdit["range"], head: ReturnType<typeof selectionHead>) => ReturnType<typeof selectionHead> = cursorAfterDeletingRange,
  options: ApplyEditsOptions = {}
): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  const copied: string[] = [];

  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const range = rangeForHead(head);
    if (range.start.row === range.end.row && range.start.column === range.end.column) {
      selectionsAfter.push(charwiseSelection(head));
      continue;
    }
    copied.push(rangeText(editor, range));
    edits.push({ range, text: "" });
    selectionsAfter.push(charwiseSelection(cursorForRange(editor, range, head)));
  }

  if (copied.length > 0) registers.writeDelete(registerName, copied.join("\n"), "characterwise");
  editor.applyEdits(edits, selectionsAfter, options);
}

export function cursorAfterDeletingRange(editor: VimEditorCapabilities, range: TextEdit["range"]) {
  if (range.start.row === range.end.row) {
    const oldLineLength = editor.lineLength(range.start.row);
    const deletedColumns = range.end.column - range.start.column;
    const newLineLength = oldLineLength - deletedColumns;
    return normalCursorPosition(editor, {
      row: range.start.row,
      column: Math.min(range.start.column, Math.max(0, newLineLength - 1)),
    });
  }
  const newLineLength = range.start.column + editor.line(range.end.row).slice(range.end.column).length;
  return normalCursorPosition(editor, {
    row: range.start.row,
    column: Math.min(range.start.column, Math.max(0, newLineLength - 1)),
  });
}

export function deleteLineRange(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  ranges: readonly LinewiseOperationRange[]
): void {
  if (ranges.length === 0) return;

  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  const copied: string[] = [];

  for (const rangeInfo of ranges) {
    const range = lineRange(editor, rangeInfo.startRow, rangeInfo.endRow - rangeInfo.startRow + 1);
    copied.push(linewiseContent(editor, rangeInfo.startRow, rangeInfo.endRow - rangeInfo.startRow + 1));
    edits.push({ range, text: "" });
    selectionsAfter.push(charwiseSelection(linewiseCursorAfterDelete(editor, rangeInfo.cursorRow ?? rangeInfo.startRow, rangeInfo.column, rangeInfo.endRow - rangeInfo.startRow + 1)));
  }

  if (copied.length > 0) registers.writeDelete(registerName, copied.join(""), "linewise");
  editor.applyEdits(edits, selectionsAfter);
}

// Zed: `Motion::CurrentLine` flowing into `normal::delete::Vim::delete_motion`.
export function deleteLines(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  count: number
): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  const copied: string[] = [];

  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const row = head.row;
    const range = lineRange(editor, row, count);
    copied.push(linewiseContent(editor, row, count));
    edits.push({ range, text: "" });
    selectionsAfter.push(charwiseSelection(linewiseCursorAfterDelete(editor, row, head.column, count)));
  }

  if (copied.length > 0) registers.writeDelete(registerName, copied.join(""), "linewise");
  editor.applyEdits(edits, selectionsAfter);
}

function linewiseContent(editor: VimEditorCapabilities, row: number, count: number): string {
  const startRow = Math.max(0, Math.min(row, editor.lineCount() - 1));
  const endRow = Math.min(startRow + count, editor.lineCount());
  const lines: string[] = [];
  for (let current = startRow; current < endRow; current++) lines.push(editor.line(current));
  return `${lines.join("\n")}\n`;
}

// Zed: the `normal::DeleteRight` action calls `delete_motion(Motion::Right, ...)`.
export function deleteCharacters(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  count: number
): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  const copied: string[] = [];

  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const oldLineLength = editor.lineLength(head.row);
    const end = {
      row: head.row,
      column: Math.min(head.column + count, oldLineLength),
    };
    const range = orderedRange(head, end);
    const deletedColumns = Math.max(0, range.end.column - range.start.column);
    const newLineLength = oldLineLength - deletedColumns;
    copied.push(rangeText(editor, range));
    edits.push({ range, text: "" });
    selectionsAfter.push(charwiseSelection(normalCursorPosition(editor, {
      row: head.row,
      column: Math.min(head.column, Math.max(0, newLineLength - 1)),
    })));
  }

  if (copied.length > 0) registers.writeDelete(registerName, copied.join("\n"), "characterwise");
  editor.applyEdits(edits, selectionsAfter);
}
