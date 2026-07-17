// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/insert.rs, crates/vim/src/normal.rs, crates/vim/src/vim.rs
// - translated concepts: insert-mode text application and normal/insert cursor transitions
// - intentional differences: ordinary insert-mode typing is modeled as host edits through
//   `VimEditorCapabilities`; production VSCode should usually delegate to native typing.

import { ApplyEditsOptions, VimEditorCapabilities, normalCursorPosition } from "./editor.js";
import { charClass } from "./motion.js";
import {
  Position,
  TextEdit,
  VimSelection,
  charwiseSelection,
  rangeOfSelection,
  selectionHead,
} from "./state.js";

export function insertText(editor: VimEditorCapabilities, text: string, options: ApplyEditsOptions = {}): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];

  for (const selection of editor.getSelections()) {
    const range = rangeOfSelection(selection);
    edits.push({ range, text });
    selectionsAfter.push(charwiseSelection(positionAfterInsertedText(range.start, text)));
  }

  editor.applyEdits(edits, selectionsAfter, options);
}

export function insertCharacterFromAdjacentLine(
  editor: VimEditorCapabilities,
  side: "above" | "below",
  options: ApplyEditsOptions = {}
): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];

  for (const selection of editor.getSelections()) {
    const range = rangeOfSelection(selection);
    const sourceRow = range.start.row + (side === "above" ? -1 : 1);
    if (sourceRow < 0 || sourceRow >= editor.lineCount()) {
      selectionsAfter.push(charwiseSelection(range.start));
      continue;
    }

    const sourceLine = editor.line(sourceRow);
    const text = sourceLine[range.start.column];
    if (text === undefined) {
      selectionsAfter.push(charwiseSelection(range.start));
      continue;
    }

    edits.push({ range, text });
    selectionsAfter.push(charwiseSelection(positionAfterInsertedText(range.start, text)));
  }

  if (edits.length > 0) editor.applyEdits(edits, selectionsAfter, options);
}

// Zed: `normal::Vim::insert_after`, `normal::Vim::insert_before`, 
// `normal::Vim::insert_first_non_whitespace`, and `normal::Vim::insert_end_of_line`.
export function enterInsertAtSelections(
  editor: VimEditorCapabilities,
  map: (pos: Position) => Position
): void {
  editor.setCursorStyle("line");
  editor.setSelections(
    editor.getSelections().map((selection) => charwiseSelection(map(selectionHead(selection))))
  );
}

// Zed: `normal::Vim::insert_line_above` and `normal::Vim::insert_line_below`.
export function openLine(editor: VimEditorCapabilities, { above }: { above: boolean }, options: ApplyEditsOptions = {}): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];

  for (const selection of editor.getSelections()) {
    const row = selectionHead(selection).row;
    const insertAt = above ? { row, column: 0 } : { row, column: editor.lineLength(row) };
    edits.push({ range: { start: insertAt, end: insertAt }, text: "\n" });
    selectionsAfter.push(charwiseSelection({ row: above ? row : row + 1, column: 0 }));
  }

  editor.applyEdits(edits, selectionsAfter, options);
  editor.setCursorStyle("line");
}

// Zed: `vim::Vim::switch_mode`. The cursor-left behavior when leaving insert
// mode mirrors the normal-mode cursor fixup, but is simplified.
export function deleteToBeginningOfLine(editor: VimEditorCapabilities, options: ApplyEditsOptions = {}): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const start = { row: head.row, column: 0 };
    edits.push({ range: { start, end: head }, text: "" });
    selectionsAfter.push(charwiseSelection(start));
  }
  editor.applyEdits(edits, selectionsAfter, options);
}

export function deleteToPreviousWord(editor: VimEditorCapabilities, options: ApplyEditsOptions = {}): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const start = previousWordStart(editor, head);
    edits.push({ range: { start, end: head }, text: "" });
    selectionsAfter.push(charwiseSelection(start));
  }
  editor.applyEdits(edits, selectionsAfter, options);
}

export function enterNormalMode(
  editor: VimEditorCapabilities,
  { moveLeft }: { moveLeft: boolean }
): void {
  editor.setCursorStyle("block");
  editor.setSelections(
    editor.getSelections().map((selection) => {
      const head = selectionHead(selection);
      const target = moveLeft ? { row: head.row, column: head.column - 1 } : head;
      return charwiseSelection(normalCursorPosition(editor, target));
    })
  );
}

// Vim `i_CTRL-W` (Neovim-verified): word-wise and line-local, unlike the `b`
// motion the previous version approximated with a whitespace-only scan.
// - At the start of a line, delete just the line break (nvim 'backspace'
//   includes "eol"), never words on the previous line.
// - Otherwise skip the whitespace run before the cursor, then delete one run
//   of same-class characters (keyword vs punctuation, like `b`), stopping at
//   the line start.
function previousWordStart(editor: VimEditorCapabilities, head: Position): Position {
  if (head.column === 0) {
    if (head.row === 0) return head;
    return { row: head.row - 1, column: editor.lineLength(head.row - 1) };
  }
  const line = editor.line(head.row);
  let column = head.column;
  while (column > 0 && charClass(line[column - 1], false) === "whitespace") column--;
  if (column === 0) return { row: head.row, column };
  const kind = charClass(line[column - 1], false);
  while (column > 0 && charClass(line[column - 1], false) === kind) column--;
  return { row: head.row, column };
}

export function firstNonWhitespace(line: string, row: number): Position {
  const column = line.search(/\S/);
  return { row, column: column < 0 ? 0 : column };
}

export function positionAfterInsertedText(start: Position, text: string): Position {
  const lines = text.split("\n");
  if (lines.length === 1) return { row: start.row, column: start.column + text.length };
  return {
    row: start.row + lines.length - 1,
    column: lines[lines.length - 1].length,
  };
}
