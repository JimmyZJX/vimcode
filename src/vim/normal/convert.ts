// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/convert.rs
// - translated concepts: first normal-mode opposite-case conversion for `~`
// - intentional differences: this slice only handles simple model-buffer characterwise
//   normal-mode conversion; motion/object/visual conversions remain future work.

import { VimEditorCapabilities, normalCursorPosition, rangeText } from "../editor.js";
import { TextEdit, TextRange, VimSelection, charwiseSelection, selectionHead } from "../state.js";

export type ConvertTarget = "lower" | "upper" | "toggle";

// Zed: `normal::convert::Vim::convert_motion` with `ConvertTarget::OppositeCase`.
export function toggleCaseCharacters(editor: VimEditorCapabilities, count: number): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];

  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const lineLength = editor.lineLength(head.row);
    const endColumn = Math.min(head.column + count, lineLength);
    if (head.column >= endColumn) {
      selectionsAfter.push(charwiseSelection(head));
      continue;
    }

    const text = editor.line(head.row).slice(head.column, endColumn);
    edits.push({
      range: { start: head, end: { row: head.row, column: endColumn } },
      text: toggleCase(text),
    });
    selectionsAfter.push(charwiseSelection(normalCursorPosition(editor, {
      row: head.row,
      column: head.column + count,
    })));
  }

  editor.applyEdits(edits, selectionsAfter);
}

export function convertRanges(
  editor: VimEditorCapabilities,
  ranges: readonly TextRange[],
  target: ConvertTarget,
  cursorForRange: (range: TextRange, index: number) => TextRange["start"] = range => range.start
): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  ranges.forEach((range, index) => {
    edits.push({ range, text: convertText(rangeText(editor, range), target) });
    selectionsAfter.push(charwiseSelection(cursorForRange(range, index)));
  });
  editor.applyEdits(edits, selectionsAfter);
}

function convertText(text: string, target: ConvertTarget): string {
  switch (target) {
    case "lower":
      return text.toLocaleLowerCase();
    case "upper":
      return text.toLocaleUpperCase();
    case "toggle":
      return toggleCase(text);
  }
}

function toggleCase(text: string): string {
  return [...text].map(toggleCaseCharacter).join("");
}

function toggleCaseCharacter(char: string): string {
  const lower = char.toLocaleLowerCase();
  const upper = char.toLocaleUpperCase();
  if (lower === upper) return char;
  return char === lower ? upper : lower;
}
