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
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  const copied: string[] = [];

  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const range = motionRange(editor, head, motion, count);
    if (range.start.row === range.end.row && range.start.column === range.end.column) {
      selectionsAfter.push(charwiseSelection(head));
      continue;
    }
    copied.push(rangeText(editor, range));
    edits.push({ range, text: "" });
    selectionsAfter.push(charwiseSelection(normalCursorPosition(editor, range.start)));
  }

  if (copied.length > 0) registers.write(registerName, copied.join("\n"));
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
    const row = selectionHead(selection).row;
    const range = lineRange(editor, row, count);
    copied.push(rangeText(editor, range));
    edits.push({ range, text: "" });
    selectionsAfter.push(charwiseSelection(linewiseCursorAfterDelete(editor, row)));
  }

  if (copied.length > 0) registers.write(registerName, copied.join("\n"));
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
    const end = {
      row: head.row,
      column: Math.min(head.column + count, editor.lineLength(head.row)),
    };
    const range = orderedRange(head, end);
    copied.push(rangeText(editor, range));
    edits.push({ range, text: "" });
    selectionsAfter.push(charwiseSelection(normalCursorPosition(editor, head)));
  }

  if (copied.length > 0) registers.write(registerName, copied.join("\n"));
  editor.applyEdits(edits, selectionsAfter);
}
