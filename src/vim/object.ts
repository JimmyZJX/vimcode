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
  { around }: { around: boolean }
): TextRange {
  switch (object.type) {
    case "word":
      return wordRange(editor, head, { around, bigWord: object.bigWord });
    case "paragraph":
      return paragraphRange(editor, head, { around });
    case "sentence":
      return sentenceRange(editor, head, { around });
    case "surround":
      return surroundRange(editor, head, object, { around });
  }
}

function wordRange(
  editor: VimEditorCapabilities,
  head: Position,
  { around, bigWord }: { around: boolean; bigWord: boolean }
): TextRange {
  const line = editor.line(head.row);
  if (line.length === 0) return { start: head, end: head };

  const wordColumn = Math.min(head.column, Math.max(0, line.length - 1));

  const wordClass = charClass(line[wordColumn], bigWord);
  let startColumn = wordColumn;
  while (startColumn > 0 && charClass(line[startColumn - 1], bigWord) === wordClass) {
    startColumn--;
  }

  let endColumn = wordColumn + 1;
  while (endColumn < line.length && charClass(line[endColumn], bigWord) === wordClass) {
    endColumn++;
  }

  if (around) {
    if (endColumn < line.length && isWhitespace(line[endColumn])) {
      while (endColumn < line.length && isWhitespace(line[endColumn])) {
        endColumn++;
      }
    } else {
      while (startColumn > 0 && isWhitespace(line[startColumn - 1])) {
        startColumn--;
      }
    }
  }

  return {
    start: { row: head.row, column: startColumn },
    end: { row: head.row, column: endColumn },
  };
}

function paragraphRange(
  editor: VimEditorCapabilities,
  head: Position,
  { around }: { around: boolean }
): TextRange {
  let startRow = head.row;
  while (startRow > 0 && editor.line(startRow - 1).trim().length > 0) startRow--;
  let endRow = head.row;
  while (endRow + 1 < editor.lineCount() && editor.line(endRow + 1).trim().length > 0) endRow++;

  if (around) {
    if (endRow + 1 < editor.lineCount()) {
      endRow++;
    } else {
      while (startRow > 0 && editor.line(startRow - 1).trim().length === 0) startRow--;
    }
  }

  return {
    start: { row: startRow, column: 0 },
    end: endRow + 1 < editor.lineCount()
      ? { row: endRow + 1, column: 0 }
      : { row: endRow, column: editor.lineLength(endRow) },
  };
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
