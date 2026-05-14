// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/replace.rs
// - translated concepts: replace-mode text application and single-character replace
// - intentional differences: this first slice is model-buffer only and omits undo-stack
//   restoration for replace-mode backspace.

import { VimEditorCapabilities } from "./editor.js";
import { Position, TextEdit, VimSelection, charwiseSelection, selectionHead } from "./state.js";

export function replaceCharacters(
  editor: VimEditorCapabilities,
  text: string,
  count: number
): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const replacement = text === "enter" ? "\n" : text;
    if (replacement !== "\n" && head.column + count > editor.lineLength(head.row)) {
      selectionsAfter.push(charwiseSelection(head));
      continue;
    }
    const end = replacement === "\n" ? endPositionForReplace(editor, head, Math.max(0, count - 1)) : endPositionForReplace(editor, head, count);
    edits.push({ range: { start: head, end }, text: replacement === "\n" ? "\n " : replacement.repeat(count) });
    selectionsAfter.push(charwiseSelection(cursorAfterReplace(head, replacement, count)));
  }
  editor.applyEdits(edits, selectionsAfter);
}

export function replaceModeText(
  editor: VimEditorCapabilities,
  text: string,
  count: number
): void {
  const replacement = text === "\n" || text === "enter" ? "\n" : text.repeat(count);
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const end = replacement === "\n" ? head : endPositionForReplace(editor, head, replacement.length);
    edits.push({ range: { start: head, end }, text: replacement });
    selectionsAfter.push(charwiseSelection(positionAfterInsertedText(head, replacement)));
  }
  editor.applyEdits(edits, selectionsAfter);
}

function endPositionForReplace(editor: VimEditorCapabilities, start: Position, count: number): Position {
  return {
    row: start.row,
    column: Math.min(start.column + count, editor.lineLength(start.row)),
  };
}

function cursorAfterReplace(start: Position, replacement: string, count: number): Position {
  if (replacement === "\n") return { row: start.row + 1, column: 1 };
  return { row: start.row, column: start.column + Math.max(0, count - 1) };
}

function positionAfterInsertedText(start: Position, text: string): Position {
  const lines = text.split("\n");
  if (lines.length === 1) return { row: start.row, column: start.column + text.length };
  return { row: start.row + lines.length - 1, column: lines[lines.length - 1].length };
}
