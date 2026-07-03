// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/delete.rs
// - translated concepts: delete by motion, delete current line, delete character
// - intentional differences: this first slice uses simple text ranges and the unnamed
//   clipboard string; linewise, register, visual, and multicursor fidelity are incomplete.

import { ApplyEditsOptions, VimEditorCapabilities, normalCursorPosition, rangeText } from "../editor.js";
import { lineRange, linewiseCursorAfterDelete } from "../motion.js";
import type { CharwiseTarget, ResolvedTarget, RowRange } from "../operator_target.js";
import { RegisterName, Registers } from "../registers.js";
import {
  TextEdit,
  VimSelection,
  charwiseSelection,
  orderedRange,
  selectionHead,
} from "../state.js";

// Zed: `normal::delete::Vim::delete_motion` / `delete_object`; one application
// for every delete target source (motion, line, object, visual).
export function applyDelete(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  target: ResolvedTarget
): void {
  switch (target.kind) {
    case "charwise":
      deleteTargets(editor, registers, registerName, target.targets);
      return;
    case "linewise":
      deleteLineRange(editor, registers, registerName, target.rows);
      return;
  }
}

export function deleteTargets(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  targets: readonly CharwiseTarget[],
  cursorForRange: (editor: VimEditorCapabilities, range: TextEdit["range"], head: ReturnType<typeof selectionHead>) => ReturnType<typeof selectionHead> = cursorAfterDeletingRange,
  options: ApplyEditsOptions = {}
): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  const copied: string[] = [];

  for (const { range, head, cursor } of targets) {
    if (range.start.row === range.end.row && range.start.column === range.end.column) {
      // Vim: an empty target deletes nothing but still moves the cursor to
      // its start (`di(` on an empty pair parks the cursor inside it).
      selectionsAfter.push(charwiseSelection(cursor ?? range.start));
      continue;
    }
    copied.push(rangeText(editor, range));
    edits.push({ range, text: "" });
    selectionsAfter.push(charwiseSelection(cursor ?? cursorForRange(editor, range, head)));
  }

  if (copied.length > 0) {
    registers.writeDelete(
      registerName,
      copied.join("\n"),
      "characterwise",
      copied.map(text => ({ text, kind: "characterwise" }))
    );
  }
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
  // Clamp against the post-edit joined line, not the pre-edit buffer: deleting
  // a multi-row range can make a column valid that was one past the old line
  // end (`dit` on a multiline tag leaves the cursor between the joined tags).
  const newLineLength = range.start.column + editor.line(range.end.row).slice(range.end.column).length;
  return {
    row: range.start.row,
    column: Math.min(range.start.column, Math.max(0, newLineLength - 1)),
  };
}

export function deleteLineRange(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  ranges: readonly RowRange[]
): void {
  if (ranges.length === 0) return;

  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  const copied: string[] = [];

  for (const rangeInfo of ranges) {
    const range = lineRange(editor, rangeInfo.startRow, rangeInfo.endRow - rangeInfo.startRow + 1);
    copied.push(linewiseContent(editor, rangeInfo.startRow, rangeInfo.endRow - rangeInfo.startRow + 1));
    edits.push({ range, text: "" });
    selectionsAfter.push(charwiseSelection(
      rangeInfo.cursor ?? linewiseCursorAfterDelete(editor, rangeInfo.startRow, rangeInfo.column, rangeInfo.endRow - rangeInfo.startRow + 1)));
  }

  if (copied.length > 0) {
    registers.writeDelete(
      registerName,
      copied.join(""),
      "linewise",
      copied.map(text => ({ text, kind: "linewise" }))
    );
  }
  editor.applyEdits(edits, selectionsAfter);
}

function linewiseContent(editor: VimEditorCapabilities, row: number, count: number): string {
  const startRow = Math.max(0, Math.min(row, editor.lineCount() - 1));
  const endRow = Math.min(startRow + count, editor.lineCount());
  const lines: string[] = [];
  for (let current = startRow; current < endRow; current++) lines.push(editor.line(current));
  return `${lines.join("\n")}\n`;
}

// Zed: the `normal::DeleteLeft` action deletes before the cursor without crossing
// line boundaries.
export function deleteCharactersBefore(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  count: number,
  options: ApplyEditsOptions = {}
): void {
  deleteTargets(
    editor,
    registers,
    registerName,
    editor.getSelections().map(selection => {
      const head = selectionHead(selection);
      const range = head.column === 0
        ? { start: head, end: head }
        : { start: { row: head.row, column: Math.max(0, head.column - count) }, end: head };
      return { head, range };
    }),
    (_editor, range, head) => ({ row: head.row, column: range.start.column }),
    options
  );
}

// Zed: the `normal::DeleteRight` action calls `delete_motion(Motion::Right, ...)`.
export function deleteCharacters(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  count: number,
  options: ApplyEditsOptions = {}
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

  if (copied.length > 0) {
    registers.writeDelete(
      registerName,
      copied.join("\n"),
      "characterwise",
      copied.map(text => ({ text, kind: "characterwise" }))
    );
  }
  editor.applyEdits(edits, selectionsAfter, options);
}
