// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/indent.rs
// - translated concepts: indent, outdent, and autoindent actions over line ranges
// - intentional differences: local autoindent is model-buffer-only and approximates by
//   preserving existing indentation; language-aware indentation belongs in the host.

import { VimEditorCapabilities } from "../editor.js";
import type { OperatorTarget } from "../operator_target.js";
import { TextEdit, TextRange, VimSelection, charwiseSelection, selectionHead } from "../state.js";

export type IndentDirection = "in" | "out" | "auto";

// Zed: `indent::Vim::indent_motion` / `indent_object`; one application for
// every indent target source (motion, object, line, visual). The cursor rule
// lives in [indentRanges]: heads keep their position, shifted by the indent
// delta on affected rows (Zed: `restore_selection_cursors`).
export function applyIndent(
  editor: VimEditorCapabilities,
  direction: IndentDirection,
  target: OperatorTarget
): void {
  switch (target.kind) {
    case "charwise":
      indentRanges(editor, target.targets.map(({ range }) => range), direction);
      return;
    case "linewise":
      indentRanges(
        editor,
        target.rows.map(({ startRow, endRow }) => ({
          start: { row: startRow, column: 0 },
          end: { row: endRow, column: editor.lineLength(endRow) },
        })),
        direction
      );
      return;
  }
}

export function indentRanges(
  editor: VimEditorCapabilities,
  ranges: readonly TextRange[],
  direction: IndentDirection,
  count: number = 1
): void {
  const rows = rowsForRanges(ranges, editor.lineCount());
  const edits: TextEdit[] = [];
  const shiftWidth = 4;
  const shift = direction === "in" ? shiftWidth * count : direction === "out" ? -shiftWidth * count : 0;

  for (const row of rows) {
    if (direction === "auto") continue;
    if (shift > 0) {
      edits.push({ range: { start: { row, column: 0 }, end: { row, column: 0 } }, text: " ".repeat(shift) });
    } else if (shift < 0) {
      const removeColumns = Math.min(-shift, leadingWhitespaceLength(editor.line(row)));
      edits.push({ range: { start: { row, column: 0 }, end: { row, column: removeColumns } }, text: "" });
    }
  }

  const selectionsAfter = editor.getSelections().map(selection => {
    const head = selectionHead(selection);
    const lineShift = rows.includes(head.row) ? shift : 0;
    return charwiseSelection({
      row: head.row,
      column: Math.max(0, head.column + lineShift),
    });
  });

  if (edits.length === 0) {
    editor.setSelections(selectionsAfter);
  } else {
    editor.applyEdits(edits, selectionsAfter);
  }
}

export function visualIndentRanges(editor: VimEditorCapabilities, selections: readonly VimSelection[]): readonly TextRange[] {
  return selections.map(selection => {
    switch (selection.type) {
      case "charwise": {
        const startRow = Math.min(selection.anchor.row, selection.head.row);
        const endRow = Math.max(selection.anchor.row, selection.head.row);
        return { start: { row: startRow, column: 0 }, end: { row: endRow, column: editor.lineLength(endRow) } };
      }
      case "linewise": {
        const startRow = Math.min(selection.anchorLine, selection.headLine);
        const endRow = Math.max(selection.anchorLine, selection.headLine);
        return { start: { row: startRow, column: 0 }, end: { row: endRow, column: editor.lineLength(endRow) } };
      }
      case "blockwise": {
        const startRow = Math.min(selection.anchor.row, selection.head.row);
        const endRow = Math.max(selection.anchor.row, selection.head.row);
        return { start: { row: startRow, column: 0 }, end: { row: endRow, column: editor.lineLength(endRow) } };
      }
    }
  });
}

function rowsForRanges(ranges: readonly TextRange[], lineCount: number): number[] {
  const rows = new Set<number>();
  for (const range of ranges) {
    const startRow = Math.max(0, Math.min(range.start.row, lineCount - 1));
    const rawEndRow = range.end.column === 0 && range.end.row > range.start.row ? range.end.row - 1 : range.end.row;
    const endRow = Math.max(0, Math.min(rawEndRow, lineCount - 1));
    for (let row = Math.min(startRow, endRow); row <= Math.max(startRow, endRow); row++) rows.add(row);
  }
  return [...rows].sort((a, b) => a - b);
}

function leadingWhitespaceLength(line: string): number {
  const match = /^\s*/.exec(line);
  return match?.[0].length ?? 0;
}
