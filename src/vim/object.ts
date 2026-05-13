// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `object::Object`, especially `Object::Word` and word object range helpers
// - translated concepts: operator-pending text objects such as `iw` and `aw`
// - intentional differences: this first slice supports only same-line word objects.
//   Paragraphs, sentences, brackets, quotes, tree-sitter objects, and multiline edge
//   cases remain future work.

import { VimEditorCapabilities } from "./editor.js";
import { Position, TextRange } from "./state.js";

export type TextObject = { type: "word"; bigWord: boolean };

export function textObjectForKey(key: string): TextObject | undefined {
  switch (key) {
    case "w":
      return { type: "word", bigWord: false };
    case "W":
      return { type: "word", bigWord: true };
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


function charClass(char: string, bigWord: boolean): "whitespace" | "word" | "other" {
  if (isWhitespace(char)) return "whitespace";
  if (bigWord || /\w/.test(char)) return "word";
  return "other";
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}
