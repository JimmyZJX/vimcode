// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/paste.rs
// - translated concepts: paste before/after the cursor
// - intentional differences: this is a minimal characterwise paste and does not yet
//   implement linewise, visual, counts, registers, or multicursor semantics from Zed.

import { VimEditorCapabilities, normalCursorPosition } from "../editor.js";
import { positionAfterInsertedText } from "../insert.js";
import { TextEdit, VimSelection, charwiseSelection, selectionHead } from "../state.js";

// Zed: `normal::paste::Vim::paste`.
export function paste(editor: VimEditorCapabilities, { before }: { before: boolean }): void {
  const text = editor.readClipboard();
  if (text.length === 0) return;

  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const insertAt = before
      ? head
      : { row: head.row, column: Math.min(head.column + 1, editor.lineLength(head.row)) };
    edits.push({ range: { start: insertAt, end: insertAt }, text });
    selectionsAfter.push(charwiseSelection(normalCursorPosition(editor, positionAfterInsertedText(insertAt, text))));
  }
  editor.applyEdits(edits, selectionsAfter);
}
