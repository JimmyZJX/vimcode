// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/delete.rs
// - translated concepts: delete by motion, delete current line, delete character
// - intentional differences: this first slice uses simple text ranges and the unnamed
//   clipboard string; linewise, register, visual, and multicursor fidelity are incomplete.

import { VimEditorCapabilities, normalCursorPosition, rangeText } from "../editor.js";
import { Motion, lineRange, linewiseCursorAfterDelete, motionRange } from "../motion.js";
import { RegisterName, Registers } from "../registers.js";
import {
  TextEdit,
  VimSelection,
  charwiseSelection,
  orderedRange,
  selectionHead,
} from "../state.js";

// Zed: `normal::delete::Vim::delete_motion`.
export function deleteMotion(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  motion: Motion,
  count: number
): void {
  deleteRange(editor, registers, registerName, (head) => motionRange(editor, head, motion, count));
}

export function deleteRange(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  rangeForHead: (head: ReturnType<typeof selectionHead>) => TextEdit["range"],
  cursorForRange: (editor: VimEditorCapabilities, range: TextEdit["range"]) => ReturnType<typeof selectionHead> = cursorAfterDeletingRange
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
    selectionsAfter.push(charwiseSelection(cursorForRange(editor, range)));
  }

  if (copied.length > 0) registers.write(registerName, copied.join("\n"), "characterwise");
  editor.applyEdits(edits, selectionsAfter);
}

function cursorAfterDeletingRange(editor: VimEditorCapabilities, range: TextEdit["range"]) {
  if (range.start.row === range.end.row) {
    const oldLineLength = editor.lineLength(range.start.row);
    const deletedColumns = range.end.column - range.start.column;
    const newLineLength = oldLineLength - deletedColumns;
    return normalCursorPosition(editor, {
      row: range.start.row,
      column: Math.min(range.start.column, Math.max(0, newLineLength - 1)),
    });
  }
  return normalCursorPosition(editor, range.start);
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
    copied.push(rangeText(editor, range));
    edits.push({ range, text: "" });
    selectionsAfter.push(charwiseSelection(linewiseCursorAfterDelete(editor, row, head.column, count)));
  }

  if (copied.length > 0) registers.write(registerName, copied.join("\n"), "linewise");
  editor.applyEdits(edits, selectionsAfter);
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

  if (copied.length > 0) registers.write(registerName, copied.join("\n"), "characterwise");
  editor.applyEdits(edits, selectionsAfter);
}
