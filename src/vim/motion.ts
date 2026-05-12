// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/motion.rs
// - translated concepts: semantic motions and repeated motion application
// - intentional differences: this first slice implements model-position motions only;
//   display-line and fold-aware movement will be adapter capabilities.

import {
  Position,
  TextRange,
  comparePositions,
  orderedRange,
  position,
} from "./state.js";

// Zed: `motion::Motion`. This first slice keeps only
// basic model-position motions; missing Zed variants should be added here with
// provenance as they are translated.
export type Motion =
  | { type: "left" }
  | { type: "wrappingLeft" }
  | { type: "right" }
  | { type: "up" }
  | { type: "down" }
  | { type: "startOfLine" }
  | { type: "firstNonWhitespace" }
  | { type: "endOfLine" }
  | { type: "startOfDocument" }
  | { type: "endOfDocument" }
  | { type: "nextWordStart"; bigWord: boolean }
  | { type: "nextWordEnd"; bigWord: boolean }
  | { type: "previousWordStart"; bigWord: boolean };
import { VimEditorCapabilities, clipPosition, normalCursorPosition } from "./editor.js";

// Zed: `motion::register` maps key actions to `Motion` variants once, while
// `vim::Vim::motion` dispatches those motions by mode. This is the local
// key-to-motion subset used by both normal and visual modes.
export function motionForKey(key: string): Motion | undefined {
  switch (key) {
    case "h":
      return { type: "left" };
    case "l":
      return { type: "right" };
    case "k":
      return { type: "up" };
    case "j":
      return { type: "down" };
    case "0":
      return { type: "startOfLine" };
    case "^":
      return { type: "firstNonWhitespace" };
    case "$":
      return { type: "endOfLine" };
    case "w":
      return { type: "nextWordStart", bigWord: false };
    case "W":
      return { type: "nextWordStart", bigWord: true };
    case "e":
      return { type: "nextWordEnd", bigWord: false };
    case "E":
      return { type: "nextWordEnd", bigWord: true };
    case "b":
      return { type: "previousWordStart", bigWord: false };
    case "B":
      return { type: "previousWordStart", bigWord: true };
    default:
      return undefined;
  }
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isWord(char: string): boolean {
  return /\w/.test(char);
}

function charClass(char: string, bigWord: boolean): "whitespace" | "word" | "other" {
  if (isWhitespace(char)) return "whitespace";
  if (bigWord || isWord(char)) return "word";
  return "other";
}

function charAt(editor: VimEditorCapabilities, pos: Position): string | undefined {
  if (pos.row < 0 || pos.row >= editor.lineCount()) return undefined;
  const line = editor.line(pos.row);
  if (pos.column < line.length) return line[pos.column];
  if (pos.column === line.length && pos.row + 1 < editor.lineCount()) return "\n";
  return undefined;
}

function nextPosition(editor: VimEditorCapabilities, pos: Position): Position | undefined {
  const lineLength = editor.lineLength(pos.row);
  if (pos.column < lineLength) return { row: pos.row, column: pos.column + 1 };
  if (pos.row + 1 < editor.lineCount()) return { row: pos.row + 1, column: 0 };
  return undefined;
}

function previousPosition(editor: VimEditorCapabilities, pos: Position): Position | undefined {
  if (pos.column > 0) return { row: pos.row, column: pos.column - 1 };
  if (pos.row > 0) return { row: pos.row - 1, column: editor.lineLength(pos.row - 1) };
  return undefined;
}

function firstNonWhitespace(editor: VimEditorCapabilities, row: number): Position {
  const line = editor.line(row);
  const first = line.search(/\S/);
  return { row, column: first < 0 ? 0 : first };
}

function endOfLine(editor: VimEditorCapabilities, row: number): Position {
  return normalCursorPosition(editor, { row, column: editor.lineLength(row) });
}

// Zed: `motion::next_word_start`, reached from `motion::Motion::move_point`.
// This is a simplified
// model-buffer implementation; Zed's version works over `DisplaySnapshot`.
function nextWordStart(
  editor: VimEditorCapabilities,
  start: Position,
  bigWord: boolean
): Position {
  let current = nextPosition(editor, start);
  let previousClass = charAt(editor, start);
  let previous = previousClass === undefined ? "whitespace" : charClass(previousClass, bigWord);

  while (current !== undefined) {
    const char = charAt(editor, current);
    if (char === undefined) break;
    if (editor.lineLength(current.row) === 0) {
      return normalCursorPosition(editor, current);
    }
    const currentClass = charClass(char, bigWord);
    if (currentClass !== "whitespace" && currentClass !== previous) {
      return normalCursorPosition(editor, current);
    }
    previous = currentClass;
    current = nextPosition(editor, current);
  }

  return endOfLine(editor, editor.lineCount() - 1);
}

// Zed: `motion::next_word_end`, reached from `motion::Motion::move_point`.
function nextWordEnd(editor: VimEditorCapabilities, start: Position, bigWord: boolean): Position {
  let current = nextPosition(editor, start);
  while (current !== undefined) {
    const char = charAt(editor, current);
    if (char === undefined) break;
    if (charClass(char, bigWord) !== "whitespace") break;
    current = nextPosition(editor, current);
  }

  if (current === undefined) return endOfLine(editor, editor.lineCount() - 1);
  let last = current;
  let currentClass = charClass(charAt(editor, current) ?? " ", bigWord);
  current = nextPosition(editor, current);

  while (current !== undefined) {
    const char = charAt(editor, current);
    if (char === undefined) break;
    const nextClass = charClass(char, bigWord);
    if (nextClass !== currentClass || nextClass === "whitespace") break;
    last = current;
    currentClass = nextClass;
    current = nextPosition(editor, current);
  }

  return normalCursorPosition(editor, last);
}

// Zed: `motion::previous_word_start`, reached from `motion::Motion::move_point`.
function previousWordStart(
  editor: VimEditorCapabilities,
  start: Position,
  bigWord: boolean
): Position {
  let current = previousPosition(editor, start);
  while (current !== undefined) {
    const char = charAt(editor, current);
    if (char !== undefined && charClass(char, bigWord) !== "whitespace") break;
    current = previousPosition(editor, current);
  }

  if (current === undefined) return position(0, 0);
  let first = current;
  let currentClass = charClass(charAt(editor, current) ?? " ", bigWord);
  current = previousPosition(editor, current);

  while (current !== undefined) {
    const char = charAt(editor, current);
    if (char === undefined) break;
    const previousClass = charClass(char, bigWord);
    if (previousClass !== currentClass || previousClass === "whitespace") break;
    first = current;
    currentClass = previousClass;
    current = previousPosition(editor, current);
  }

  return normalCursorPosition(editor, first);
}

// Zed: `motion::Motion::move_point`. We keep the
// same dispatch shape, but delegate only to local model-position helpers for now.
export function applyMotionOnce(
  editor: VimEditorCapabilities,
  start: Position,
  motion: Motion
): Position {
  const clipped = clipPosition(editor, start);
  switch (motion.type) {
    case "left":
      return normalCursorPosition(editor, { row: clipped.row, column: clipped.column - 1 });
    case "wrappingLeft":
      if (clipped.column > 0) return normalCursorPosition(editor, { row: clipped.row, column: clipped.column - 1 });
      if (clipped.row > 0) return normalCursorPosition(editor, { row: clipped.row - 1, column: editor.lineLength(clipped.row - 1) });
      return normalCursorPosition(editor, clipped);
    case "right":
      return normalCursorPosition(editor, { row: clipped.row, column: clipped.column + 1 });
    case "up":
      return normalCursorPosition(editor, { row: clipped.row - 1, column: clipped.column });
    case "down":
      return normalCursorPosition(editor, { row: clipped.row + 1, column: clipped.column });
    case "startOfLine":
      return { row: clipped.row, column: 0 };
    case "firstNonWhitespace":
      return firstNonWhitespace(editor, clipped.row);
    case "endOfLine":
      return endOfLine(editor, clipped.row);
    case "startOfDocument":
      return position(0, 0);
    case "endOfDocument":
      return endOfLine(editor, editor.lineCount() - 1);
    case "nextWordStart":
      return nextWordStart(editor, clipped, motion.bigWord);
    case "nextWordEnd":
      return nextWordEnd(editor, clipped, motion.bigWord);
    case "previousWordStart":
      return previousWordStart(editor, clipped, motion.bigWord);
  }
}

// Local helper corresponding to Zed's repeated `times` argument threaded through
// `vim::Vim::motion` and `motion::Motion::move_point`.
export function applyMotion(
  editor: VimEditorCapabilities,
  start: Position,
  motion: Motion,
  count: number
): Position {
  let current = start;
  for (let i = 0; i < count; i++) {
    current = applyMotionOnce(editor, current, motion);
  }
  return current;
}

// Zed: `motion::Motion::range` / `motion::Motion::expand_selection` decide
// inclusive/exclusive/linewise ranges. This is
// a deliberately small placeholder for that richer logic.
export function motionRange(
  editor: VimEditorCapabilities,
  start: Position,
  motion: Motion,
  count: number
): TextRange {
  const end = applyMotion(editor, start, motion, count);
  if (motion.type === "endOfLine") {
    return orderedRange(start, { row: end.row, column: editor.lineLength(end.row) });
  }
  if (motion.type === "nextWordStart" && currentCharIsWord(editor, start, motion.bigWord)) {
    const wordEnd = currentWordEnd(editor, start, motion.bigWord);
    if (end.row > start.row || comparePositions(end, wordEnd) < 0) {
      return orderedRange(start, wordEnd);
    }
  }
  if (motion.type === "nextWordEnd") {
    const rangeEnd = nextPosition(editor, end) ?? end;
    return orderedRange(start, rangeEnd);
  }
  return orderedRange(start, end);
}

function currentCharIsWord(editor: VimEditorCapabilities, pos: Position, bigWord: boolean): boolean {
  const char = charAt(editor, pos);
  return char !== undefined && charClass(char, bigWord) !== "whitespace";
}

function currentWordEnd(editor: VimEditorCapabilities, start: Position, bigWord: boolean): Position {
  const startChar = charAt(editor, start);
  if (startChar === undefined) return start;
  const startClass = charClass(startChar, bigWord);
  let current = start;
  while (true) {
    const next = nextPosition(editor, current);
    if (next === undefined || next.row !== start.row) return { row: start.row, column: editor.lineLength(start.row) };
    const nextChar = charAt(editor, next);
    if (nextChar === undefined || charClass(nextChar, bigWord) !== startClass) return next;
    current = next;
  }
}

// Zed: linewise operation ranges are built through `Motion::CurrentLine` and
// `motion::MotionKind::Linewise`.
export function changeMotionRange(
  editor: VimEditorCapabilities,
  start: Position,
  motion: Motion,
  count: number
): TextRange {
  if (count === 1 && motion.type === "nextWordStart") {
    if (editor.lineLength(start.row) === 0) return { start, end: start };
    if (currentCharIsWord(editor, start, motion.bigWord)) {
      return orderedRange(start, currentWordEnd(editor, start, motion.bigWord));
    }
  }
  return motionRange(editor, start, motion, count);
}

export function lineRange(
  editor: VimEditorCapabilities,
  row: number,
  count: number
): TextRange {
  const lineCount = editor.lineCount();
  const startRow = Math.max(0, Math.min(row, lineCount - 1));
  const endRow = Math.min(startRow + count, lineCount);
  if (endRow >= lineCount) {
    const lastRow = lineCount - 1;
    if (startRow > 0) {
      const previousRow = startRow - 1;
      return {
        start: { row: previousRow, column: editor.lineLength(previousRow) },
        end: { row: lastRow, column: editor.lineLength(lastRow) },
      };
    }
    return {
      start: { row: startRow, column: 0 },
      end: { row: lastRow, column: editor.lineLength(lastRow) },
    };
  }
  return { start: { row: startRow, column: 0 }, end: { row: endRow, column: 0 } };
}

export function linewiseCursorAfterDelete(
  editor: VimEditorCapabilities,
  row: number,
  column: number,
  deletedLineCount: number
): Position {
  const lineCountBeforeDelete = editor.lineCount();
  const deletingThroughLastLine = row + deletedLineCount >= lineCountBeforeDelete;
  const rowAfterDelete = deletingThroughLastLine && row > 0
    ? row - 1
    : Math.min(row, Math.max(0, lineCountBeforeDelete - deletedLineCount));
  return normalCursorPosition(editor, { row: rowAfterDelete, column });
}

export function isForwardRange(range: TextRange): boolean {
  return comparePositions(range.start, range.end) <= 0;
}
