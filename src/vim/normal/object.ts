// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/normal.rs normal_object plus normal/delete.rs object
//   post-processing
// - translated concepts: paragraph-object fixups consumed by
//   `textObjectOperatorTarget`; the operator dispatch itself lives in
//   operator_target.ts.
// - intentional differences: the editor model is synchronous and range-based; paragraph
//   post-processing is a local approximation of Zed's selection expansion/fixup path.

import { VimEditorCapabilities } from "../editor.js";
import { Position, TextRange } from "../state.js";

// Zed: `normal_object`'s paragraph special case — `cap` on a trailing blank
// run at end of file cancels instead of editing.
export function paragraphObjectCancelled(
  editor: VimEditorCapabilities,
  head: Position,
  range: TextRange,
  { around }: { around: boolean }
): boolean {
  return around
    && range.start.row === range.end.row
    && range.start.column === range.end.column
    && editor.line(head.row).trim().length === 0
    && endOfParagraph(editor, head.row) === editor.lineCount() - 1;
}

// Zed: `normal/delete.rs` object post-processing — deleting a paragraph also
// consumes the surrounding newlines so no blank shell is left behind.
export function paragraphDeleteRange(editor: VimEditorCapabilities, range: TextRange, { around }: { around: boolean }): TextRange {
  const text = editor.getText();
  const originalStart = offsetOfPosition(editor, range.start);
  const originalEnd = offsetOfPosition(editor, range.end);
  if (around && originalStart === originalEnd) return range;
  let start = originalStart;
  let end = originalEnd;
  const endAtNewline = text[originalEnd] === "\n";
  const containsOnlyNewlinesInRange = containsOnlyNewlines(text, originalStart, originalEnd);

  if (around && containsOnlyNewlinesInRange) {
    if (endAtNewline) end = Math.min(text.length, end + 1);
    else if (start > 0 && text[start - 1] === "\n") start--;
  }

  if (end === text.length && start > 0 && text[start - 1] === "\n") start--;
  if (endAtNewline) end = Math.min(text.length, end + 1);

  return { start: positionOfOffset(editor, start), end: positionOfOffset(editor, end) };
}

// Cursor rule for paragraph deletes: the cursor lands at the range start,
// except that a start clamped to a line end snaps to column zero.
export function paragraphCursorAfterDelete(editor: VimEditorCapabilities, range: TextRange): Position {
  if (range.start.column > 0 && range.start.column === editor.lineLength(range.start.row)) {
    return { row: range.start.row, column: 0 };
  }
  return range.start;
}

function endOfParagraph(editor: VimEditorCapabilities, row: number): number {
  const currentIsBlank = editor.line(row).trim().length === 0;
  for (let current = row + 1; current < editor.lineCount(); current++) {
    if ((editor.line(current).trim().length === 0) !== currentIsBlank) return current - 1;
  }
  return editor.lineCount() - 1;
}

function containsOnlyNewlines(text: string, start: number, end: number): boolean {
  if (start === end) return false;
  for (let index = start; index < end; index++) {
    if (text[index] !== "\n") return false;
  }
  return true;
}

function offsetOfPosition(editor: VimEditorCapabilities, position: Position): number {
  let offset = 0;
  for (let row = 0; row < position.row; row++) offset += editor.lineLength(row) + 1;
  return offset + position.column;
}

function positionOfOffset(editor: VimEditorCapabilities, offset: number): Position {
  let remaining = offset;
  for (let row = 0; row < editor.lineCount(); row++) {
    const lineLength = editor.lineLength(row);
    if (remaining <= lineLength) return { row, column: remaining };
    remaining -= lineLength + 1;
  }
  const row = editor.lineCount() - 1;
  return { row, column: editor.lineLength(row) };
}
