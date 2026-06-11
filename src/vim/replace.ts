// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/replace.rs
// - translated concepts: replace-mode text application and single-character replace
// - intentional differences: this first slice is model-buffer only and omits undo-stack
//   restoration for replace-mode backspace.

import { ApplyEditsOptions, VimEditorCapabilities } from "./editor.js";
import { firstNonWhitespaceColumn } from "./motion.js";
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
    if (head.column + count > editor.lineLength(head.row)) {
      selectionsAfter.push(charwiseSelection(head));
      continue;
    }
    if (replacement === "\n") {
      // Vim `r<CR>` (`:h r`): [count] characters are replaced with one line
      // break; the remainder's leading white space collapses, the new line
      // takes the original line's indentation, and the cursor lands on the
      // last indent character (verified against Neovim).
      const line = editor.line(head.row);
      const indent = line.slice(0, firstNonWhitespaceColumn(line));
      let endColumn = head.column + count;
      while (endColumn < line.length && (line[endColumn] === " " || line[endColumn] === "\t")) endColumn++;
      edits.push({ range: { start: head, end: { row: head.row, column: endColumn } }, text: `\n${indent}` });
      selectionsAfter.push(charwiseSelection({ row: head.row + 1, column: Math.max(0, indent.length - 1) }));
      continue;
    }
    const end = endPositionForReplace(editor, head, count);
    edits.push({ range: { start: head, end }, text: replacement.repeat(count) });
    selectionsAfter.push(charwiseSelection(cursorAfterReplace(head, count)));
  }
  editor.applyEdits(edits, selectionsAfter);
}

// Zed: `replace::Vim::multi_replace`. Returns what each edit overwrote so the
// caller can record it for replace-mode backspace (`replace::Vim::undo_replace`).
export type ReplacedText = { start: Position; end: Position; original: string };

export function replaceModeText(
  editor: VimEditorCapabilities,
  text: string,
  count: number,
  options: ApplyEditsOptions = {}
): readonly ReplacedText[] {
  const replacement = text === "\n" || text === "enter" ? "\n" : text.repeat(count);
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  const replaced: ReplacedText[] = [];
  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const end = replacement === "\n" ? head : endPositionForReplace(editor, head, replacement.length);
    replaced.push({
      start: head,
      end: positionAfterInsertedText(head, replacement),
      original: editor.getText({ start: head, end }),
    });
    edits.push({ range: { start: head, end }, text: replacement });
    selectionsAfter.push(charwiseSelection(positionAfterInsertedText(head, replacement)));
  }
  editor.applyEdits(edits, selectionsAfter, options);
  return replaced;
}

function endPositionForReplace(editor: VimEditorCapabilities, start: Position, count: number): Position {
  return {
    row: start.row,
    column: Math.min(start.column + count, editor.lineLength(start.row)),
  };
}

function cursorAfterReplace(start: Position, count: number): Position {
  return { row: start.row, column: start.column + Math.max(0, count - 1) };
}

function positionAfterInsertedText(start: Position, text: string): Position {
  const lines = text.split("\n");
  if (lines.length === 1) return { row: start.row, column: start.column + text.length };
  return { row: start.row + lines.length - 1, column: lines[lines.length - 1].length };
}
