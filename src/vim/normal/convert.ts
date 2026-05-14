// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/convert.rs
// - translated concepts: first normal-mode opposite-case conversion for `~`
// - intentional differences: this slice only handles simple model-buffer characterwise
//   normal-mode conversion; motion/object/visual conversions remain future work.

import { VimEditorCapabilities, normalCursorPosition } from "../editor.js";
import { TextEdit, charwiseSelection, selectionHead } from "../state.js";

// Zed: `normal::convert::Vim::convert_motion` with `ConvertTarget::OppositeCase`.
export function toggleCaseCharacters(editor: VimEditorCapabilities, count: number): void {
  const edits: TextEdit[] = [];
  const selectionsAfter = [];

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

function toggleCase(text: string): string {
  return [...text].map(toggleCaseCharacter).join("");
}

function toggleCaseCharacter(char: string): string {
  const lower = char.toLocaleLowerCase();
  const upper = char.toLocaleUpperCase();
  if (lower === upper) return char;
  return char === lower ? upper : lower;
}
