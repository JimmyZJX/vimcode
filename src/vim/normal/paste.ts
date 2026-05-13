// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/paste.rs
// - translated concepts: paste before/after the cursor
// - intentional differences: this is still a small subset of Zed paste behavior; visual,
//   counts, multicursor details, and auto-indent are future work.

import { VimEditorCapabilities, normalCursorPosition } from "../editor.js";
import { positionAfterInsertedText } from "../insert.js";
import { RegisterName, Registers } from "../registers.js";
import { TextEdit, VimSelection, charwiseSelection, selectionHead } from "../state.js";

// Zed: `normal::paste::Vim::paste`.
export function paste(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  { before }: { before: boolean }
): void {
  const content = registers.readContent(registerName);
  if (content.text.length === 0) return;

  if (content.kind === "linewise") {
    pasteLinewise(editor, content.text, { before });
  } else if (content.kind === "blockwise") {
    pasteBlockwise(editor, content.text, { before });
  } else {
    pasteCharacterwise(editor, content.text, { before });
  }
}

function pasteCharacterwise(
  editor: VimEditorCapabilities,
  text: string,
  { before }: { before: boolean }
): void {
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

function pasteBlockwise(
  editor: VimEditorCapabilities,
  text: string,
  { before }: { before: boolean }
): void {
  const blockLines = text.split("\n");
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];

  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const column = before ? head.column : head.column;
    for (let index = 0; index < blockLines.length; index++) {
      const row = Math.min(head.row + index, editor.lineCount() - 1);
      const insertAt = { row, column: Math.min(column, editor.lineLength(row)) };
      edits.push({ range: { start: insertAt, end: insertAt }, text: blockLines[index] });
    }
    selectionsAfter.push(charwiseSelection({ row: head.row, column: head.column + blockLines[0].length }));
  }

  editor.applyEdits(edits, selectionsAfter);
}

function pasteLinewise(
  editor: VimEditorCapabilities,
  text: string,
  { before }: { before: boolean }
): void {
  const lineText = text.endsWith("\n") ? text.slice(0, -1) : text;
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];

  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const insertAt = before
      ? { row: head.row, column: 0 }
      : { row: head.row, column: editor.lineLength(head.row) };
    const insertedText = before ? `${lineText}\n` : `\n${lineText}`;
    edits.push({ range: { start: insertAt, end: insertAt }, text: insertedText });
    selectionsAfter.push(charwiseSelection({ row: before ? head.row : head.row + 1, column: 0 }));
  }

  editor.applyEdits(edits, selectionsAfter);
}
