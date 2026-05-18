// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/normal.rs normal_object plus normal/delete.rs object
//   post-processing
// - translated concepts: applying normal-mode operators to text objects
// - intentional differences: the editor model is synchronous and range-based; paragraph
//   post-processing is a local approximation of Zed's selection expansion/fixup path.

import { VimEditorCapabilities, rangeText } from "../editor.js";
import { TextObject, textObjectRange } from "../object.js";
import { RegisterName, Registers } from "../registers.js";
import { Operator, Position, TextRange, charwiseSelection, selectionHead } from "../state.js";
import { changeRange } from "./change.js";
import { deleteRange } from "./delete.js";
import { yankRange } from "./yank.js";

export function applyTextObjectOperator(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  operator: Operator,
  object: TextObject,
  { around, count }: { around: boolean; count: number }
): boolean {
  if (object.type === "paragraph") {
    return applyParagraphObjectOperator(editor, registers, registerName, operator, { around, count });
  }

  switch (operator) {
    case "change":
      changeRange(editor, registers, registerName, (head) => textObjectRange(editor, head, object, { around, count }));
      return true;
    case "delete":
      deleteRange(editor, registers, registerName, (head) => textObjectRange(editor, head, object, { around, count }));
      return false;
    case "yank":
      yankRange(editor, registers, registerName, (head) => textObjectRange(editor, head, object, { around, count }));
      return false;
  }
}

function applyParagraphObjectOperator(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  operator: Operator,
  { around, count }: { around: boolean; count: number }
): boolean {
  const paragraphRange = (head: Position) => textObjectRange(editor, head, { type: "paragraph" }, { around, count });
  switch (operator) {
    case "change":
      return changeParagraphRange(editor, registers, registerName, paragraphRange, { around });
    case "delete":
      deleteRange(
        editor,
        registers,
        registerName,
        (head) => paragraphDeleteRange(editor, paragraphRange(head), { around }),
        paragraphCursorAfterDelete({ around })
      );
      return false;
    case "yank":
      yankRange(editor, registers, registerName, paragraphRange);
      return false;
  }
}

function changeParagraphRange(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  rangeForHead: (head: Position) => TextRange,
  { around }: { around: boolean }
): boolean {
  const edits = [];
  const copied: string[] = [];
  const selectionsAfter = [];
  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const range = rangeForHead(head);
    if (paragraphObjectCancelled(editor, head, range, { around })) {
      selectionsAfter.push(charwiseSelection(head));
      continue;
    }
    edits.push({ range, text: "" });
    copied.push(rangeText(editor, range));
    selectionsAfter.push(charwiseSelection(range.start));
  }
  if (copied.length === 0) return false;
  registers.writeDelete(registerName, copied.join("\n"), "characterwise");
  editor.applyEdits(edits, selectionsAfter);
  return true;
}

function paragraphObjectCancelled(
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

function paragraphDeleteRange(_editor: VimEditorCapabilities, range: TextRange, { around }: { around: boolean }): TextRange {
  const editor = _editor;
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

function paragraphCursorAfterDelete(_options: { around: boolean }) {
  return (editor: VimEditorCapabilities, range: TextRange, _head: Position) => {
    if (range.start.column > 0 && range.start.column === editor.lineLength(range.start.row)) {
      return { row: range.start.row, column: 0 };
    }
    return range.start;
  };
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
