// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `object::Object`, especially word and surrounding-character objects
// - translated concepts: operator-pending text objects such as `iw`, `aw`, `i"`, `a]`
// - intentional differences: this first slice supports same-line word/quote objects and
//   simple bracket matching. Paragraphs, sentences, tree-sitter objects, and escaped
//   multiline quote fidelity remain future work.

import { VimEditorCapabilities } from "./editor.js";
import { Position, TextRange } from "./state.js";

export type TextObject =
  | { type: "word"; bigWord: boolean }
  | { type: "paragraph" }
  | { type: "sentence" }
  | { type: "surround"; open: string; close: string };

export function textObjectForKey(key: string): TextObject | undefined {
  switch (key) {
    case "w":
      return { type: "word", bigWord: false };
    case "W":
      return { type: "word", bigWord: true };
    case "p":
      return { type: "paragraph" };
    case "s":
      return { type: "sentence" };
    case "\"": 
      return { type: "surround", open: "\"", close: "\"" };
    case "'":
      return { type: "surround", open: "'", close: "'" };
    case "`":
      return { type: "surround", open: "`", close: "`" };
    case "|":
      return { type: "surround", open: "|", close: "|" };
    case "(":
    case ")":
    case "b":
      return { type: "surround", open: "(", close: ")" };
    case "[":
    case "]":
    case "r":
      return { type: "surround", open: "[", close: "]" };
    case "{":
    case "}":
    case "B":
      return { type: "surround", open: "{", close: "}" };
    case "<":
    case ">":
      return { type: "surround", open: "<", close: ">" };
    default:
      return undefined;
  }
}

export function textObjectRange(
  editor: VimEditorCapabilities,
  head: Position,
  object: TextObject,
  { around, count = 1 }: { around: boolean; count?: number }
): TextRange {
  switch (object.type) {
    case "word":
      return wordRange(editor, head, { around, bigWord: object.bigWord, count });
    case "paragraph":
      return paragraphRange(editor, head, { around, count });
    case "sentence":
      return sentenceRange(editor, head, { around });
    case "surround":
      return surroundRange(editor, head, object, { around });
  }
}

function wordRange(
  editor: VimEditorCapabilities,
  head: Position,
  { around, bigWord, count }: { around: boolean; bigWord: boolean; count: number }
): TextRange {
  const text = editor.getText();
  if (text.length === 0) return { start: head, end: head };

  const headOffset = Math.min(offsetOfPosition(editor, head), Math.max(0, text.length - 1));
  if (!around && count === 1 && isWhitespace(text[headOffset])) {
    return whitespaceRange(editor, text, headOffset);
  }
  const firstUnit = wordUnitAtOrAfter(text, headOffset, bigWord);
  if (firstUnit === undefined) return { start: head, end: head };

  let endUnit = firstUnit;
  for (let index = 1; index < count; index++) {
    const nextUnit = nextWordUnit(text, endUnit.end, bigWord);
    if (nextUnit === undefined) break;
    endUnit = nextUnit;
  }

  let start = firstUnit.start;
  let end = endUnit.end;
  if (around || count > 1) {
    const expanded = expandWordRangeWhitespace(text, { start, end }, { preferTrailing: around, stopAtNewline: around && start === firstUnit.start && firstUnit.start > 0 });
    start = expanded.start;
    end = expanded.end;
  }

  return { start: positionOfOffset(editor, start), end: positionOfOffset(editor, end) };
}

function paragraphRange(
  editor: VimEditorCapabilities,
  head: Position,
  { around, count }: { around: boolean; count: number }
): TextRange {
  let startRow = startOfParagraph(editor, head.row);
  let endRow = endOfParagraph(editor, head.row);

  for (let index = 0; index < count; index++) {
    if (!around) break;

    if (paragraphEndsAtEof(editor, endRow)) {
      if (isBlankLine(editor, head.row)) return { start: head, end: head };
      if (startRow > 0) startRow = startOfParagraph(editor, startRow - 1);
    } else {
      let nextRow = endRow + 1;
      if (index > 0) nextRow++;
      endRow = endOfParagraph(editor, Math.min(nextRow, editor.lineCount() - 1));
    }
  }

  return {
    start: { row: startRow, column: 0 },
    end: { row: endRow, column: editor.lineLength(endRow) },
  };
}

function startOfParagraph(editor: VimEditorCapabilities, row: number): number {
  const currentIsBlank = isBlankLine(editor, row);
  for (let current = row - 1; current >= 0; current--) {
    if (isBlankLine(editor, current) !== currentIsBlank) return current + 1;
  }
  return 0;
}

function endOfParagraph(editor: VimEditorCapabilities, row: number): number {
  const currentIsBlank = isBlankLine(editor, row);
  for (let current = row + 1; current < editor.lineCount(); current++) {
    if (isBlankLine(editor, current) !== currentIsBlank) return current - 1;
  }
  return editor.lineCount() - 1;
}

function paragraphEndsAtEof(editor: VimEditorCapabilities, endRow: number): boolean {
  return endRow >= editor.lineCount() - 1;
}

function isBlankLine(editor: VimEditorCapabilities, row: number): boolean {
  return editor.line(row).trim().length === 0;
}

function sentenceRange(
  editor: VimEditorCapabilities,
  head: Position,
  { around }: { around: boolean }
): TextRange {
  const text = editor.getText();
  const offset = offsetOfPosition(editor, head);
  let start = 0;
  for (let index = Math.max(0, offset - 1); index >= 0; index--) {
    if (/[.!?]/.test(text[index])) {
      start = index + 1;
      while (start < text.length && /\s/.test(text[start])) start++;
      break;
    }
  }

  let end = text.length;
  for (let index = offset; index < text.length; index++) {
    if (/[.!?]/.test(text[index])) {
      end = index + 1;
      break;
    }
  }

  if (around) {
    while (end < text.length && /\s/.test(text[end])) end++;
  }

  return { start: positionOfOffset(editor, start), end: positionOfOffset(editor, end) };
}

function surroundRange(
  editor: VimEditorCapabilities,
  head: Position,
  object: Extract<TextObject, { type: "surround" }>,
  { around }: { around: boolean }
): TextRange {
  return surroundingMarkers(editor, head, around, object.open, object.close) ?? { start: head, end: head };
}

// Zed: `object::surrounding_markers`. This is the local model-buffer version
// for same-line objects. It first tries an opening marker at/behind the cursor,
// then falls back to the next opening marker on the line.
function surroundingMarkers(
  editor: VimEditorCapabilities,
  head: Position,
  around: boolean,
  openMarker: string,
  closeMarker: string
): TextRange | undefined {
  const text = editor.getText();
  const point = offsetOfPosition(editor, head);
  const lineStart = offsetOfPosition(editor, { row: head.row, column: 0 });
  const lineEnd = lineStart + editor.lineLength(head.row);
  let opening: number | undefined;

  const charAfter = text[point];
  const charBefore = point > 0 ? text[point - 1] : "\0";
  if (charAfter === openMarker && charBefore !== "\\") {
    if (openMarker === closeMarker) {
      let total = 0;
      for (let index = point - 1; index >= lineStart; index--) {
        if (text[index] === openMarker && !isEscapedInText(text, index)) total++;
      }
      if (total % 2 === 0) opening = point;
    } else {
      opening = point;
    }
  }

  if (opening === undefined) {
    let matchedCloses = 0;
    const backwardStart = openMarker === closeMarker ? point - 1 : point;
    for (let index = Math.min(backwardStart, lineEnd - 1); index >= lineStart; index--) {
      if (isEscapedInText(text, index)) continue;
      if (text[index] === openMarker) {
        if (matchedCloses === 0) {
          opening = index;
          break;
        }
        matchedCloses--;
      } else if (text[index] === closeMarker) {
        matchedCloses++;
      }
    }
  }

  if (opening === undefined) {
    let previous = charBefore;
    for (let index = point; index < lineEnd; index++) {
      if (previous !== "\\") {
        if (text[index] === openMarker) {
          opening = index;
          break;
        }
        if (text[index] === closeMarker) break;
      }
      previous = text[index];
    }
  }

  if (opening === undefined) return undefined;

  let matchedOpens = 0;
  let closing: number | undefined;
  let previous = text[opening] ?? "\0";
  for (let index = opening + 1; index < lineEnd; index++) {
    if (previous !== "\\") {
      if (text[index] === closeMarker) {
        if (matchedOpens === 0) {
          closing = index;
          break;
        }
        matchedOpens--;
      } else if (text[index] === openMarker) {
        matchedOpens++;
      }
    }
    previous = text[index];
  }

  if (closing === undefined) return undefined;

  let start = around ? opening : opening + 1;
  let end = around ? closing + 1 : closing;

  if (around) {
    let foundTrailingWhitespace = false;
    while (end < lineEnd && /\s/.test(text[end]) && text[end] !== "\n") {
      foundTrailingWhitespace = true;
      end++;
    }
    if (!foundTrailingWhitespace) {
      while (start > lineStart && /\s/.test(text[start - 1]) && text[start - 1] !== "\n") start--;
    }
  }

  return { start: positionOfOffset(editor, start), end: positionOfOffset(editor, end) };
}


type WordUnit = { start: number; end: number };

function whitespaceRange(editor: VimEditorCapabilities, text: string, offset: number): TextRange {
  let start = offset;
  while (start > 0 && isWhitespace(text[start - 1]) && text[start - 1] !== "\n") start--;
  let end = offset + 1;
  while (end < text.length && isWhitespace(text[end]) && text[end - 1] !== "\n" && text[end] !== "\n") end++;
  return { start: positionOfOffset(editor, start), end: positionOfOffset(editor, end) };
}

function wordUnitAtOrAfter(text: string, offset: number, bigWord: boolean): WordUnit | undefined {
  const containing = wordUnitAt(text, offset, bigWord);
  if (containing !== undefined) return containing;
  return nextWordUnit(text, offset, bigWord);
}

function wordUnitAt(text: string, offset: number, bigWord: boolean): WordUnit | undefined {
  if (offset < 0 || offset >= text.length || isWhitespace(text[offset])) return undefined;
  const unitClass = charClass(text[offset], bigWord);
  let start = offset;
  while (start > 0 && !isWhitespace(text[start - 1]) && charClass(text[start - 1], bigWord) === unitClass) start--;
  let end = offset + 1;
  while (end < text.length && !isWhitespace(text[end]) && charClass(text[end], bigWord) === unitClass) end++;
  return { start, end };
}

function nextWordUnit(text: string, offset: number, bigWord: boolean): WordUnit | undefined {
  for (let index = Math.max(0, offset); index < text.length; index++) {
    if (!isWhitespace(text[index])) return wordUnitAt(text, index, bigWord);
  }
  return undefined;
}

function expandWordRangeWhitespace(
  text: string,
  range: { start: number; end: number },
  { preferTrailing, stopAtNewline }: { preferTrailing: boolean; stopAtNewline: boolean }
): { start: number; end: number } {
  let { start, end } = range;
  let includedTrailingWhitespace = false;
  while (end < text.length && isWhitespace(text[end]) && !(stopAtNewline && text[end] === "\n")) {
    includedTrailingWhitespace = true;
    end++;
  }
  if ((!preferTrailing || !includedTrailingWhitespace) && !isFirstWordOnLine(text, start)) {
    while (start > 0 && isWhitespace(text[start - 1]) && !(stopAtNewline && text[start - 1] === "\n")) start--;
  }
  return { start, end };
}

function isFirstWordOnLine(text: string, start: number): boolean {
  for (let index = start - 1; index >= 0 && text[index] !== "\n"; index--) {
    if (!isWhitespace(text[index])) return false;
  }
  return true;
}

function isEscapedInText(text: string, index: number): boolean {
  let backslashes = 0;
  for (let current = index - 1; current >= 0 && text[current] === "\\"; current--) backslashes++;
  return backslashes % 2 === 1;
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

function charClass(char: string, bigWord: boolean): "whitespace" | "word" | "other" {
  if (isWhitespace(char)) return "whitespace";
  if (bigWord || /\w/.test(char)) return "word";
  return "other";
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}
