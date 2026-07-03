// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/motion.rs
// - translated concepts: semantic motions and repeated motion application
// - intentional differences: this first slice implements model-position motions only;
//   display-line and fold-aware movement will be adapter capabilities.

import {
  Position,
  TextRange,
  VimSelection,
  VimSelectionGoal,
  comparePositions,
  orderedRange,
  position,
} from "./state.js";

// Zed: `motion::Motion`. This first slice keeps only
// basic model-position motions; missing Zed variants should be added here with
// provenance as they are translated.
export type FindMotion =
  | { type: "findForward"; before: boolean; char: string }
  | { type: "findBackward"; after: boolean; char: string }
  | { type: "searchForward"; query: string; options?: SearchOptions; offset?: SearchOffset }
  | { type: "searchBackward"; query: string; options?: SearchOptions; offset?: SearchOffset };

export function reverseFindMotion(motion: FindMotion): FindMotion {
  switch (motion.type) {
    case "findForward":
      return { type: "findBackward", after: motion.before, char: motion.char };
    case "findBackward":
      return { type: "findForward", before: motion.after, char: motion.char };
    case "searchForward":
      return { ...motion, type: "searchBackward" };
    case "searchBackward":
      return { ...motion, type: "searchForward" };
  }
}

// Zed: `motion::Motion`, including `Motion::MiddleOfLine` and the forced-motion
// wrapper applied when `v` is pressed with a pending operator (Vim `o_v`).
export type Motion =
  | { type: "left" }
  | { type: "wrappingLeft" }
  | { type: "right" }
  | { type: "wrappingRight" }
  | { type: "up"; displayLine?: boolean }
  | { type: "down"; displayLine?: boolean }
  | { type: "startOfLine" }
  | { type: "firstNonWhitespace" }
  | { type: "lastNonWhitespace" }
  | { type: "middleOfLine" }
  | { type: "endOfLine" }
  | { type: "startOfDocument" }
  | { type: "startOfFile" }
  | { type: "endOfDocument" }
  // Go to an absolute 1-based line, keeping the column (Vim `G`/`NG` with
  // 'nostartofline'). Count-agnostic: the target line is baked in by the caller.
  | { type: "goToLine"; line: number }
  // Go [count] lines down/up to the first non-blank character (Vim `+`/`<CR>`
  // and `-`). Count-aware: the row delta is [count] in [direction].
  | { type: "firstNonBlankLine"; direction: "down" | "up" }
  // Go to the (1-based) [column] of the current line (Vim `|`). The column is
  // baked in by the caller (from the count) so the motion is idempotent, like
  // `goToLine`/`goToPercentage`; exclusive as an operator target.
  | { type: "goToColumn"; column: number }
  | { type: "nextWordStart"; bigWord: boolean }
  | { type: "nextWordEnd"; bigWord: boolean }
  | { type: "previousWordStart"; bigWord: boolean }
  | { type: "previousWordEnd"; bigWord: boolean }
  | { type: "matching" }
  | { type: "unmatchedForward"; char: string }
  | { type: "unmatchedBackward"; char: string }
  | { type: "nextSentence" }
  | { type: "previousSentence" }
  | { type: "endOfParagraph" }
  | { type: "startOfParagraph" }
  | { type: "goToPercentage"; percent: number }
  | { type: "windowLine"; target: "top" | "middle" | "bottom" }
  | { type: "forcedCharwise"; motion: Motion }
  | { type: "jump"; position: Position; line: boolean }
  | { type: "searchMatch"; range: TextRange }
  | FindMotion;
import { VimEditorCapabilities, clipPosition, normalCursorPosition } from "./editor.js";
import { SearchOffset, SearchOptions } from "./search.js";

// Zed: `motion::register` maps key actions to `Motion` variants once, while
// Unmatched-bracket motions (`]}`/`])`/`[{`/`[(`): the second key after `]`/`[`
// names the unmatched bracket to jump to. Shared by the operator operand grammar,
// the standalone motion handler, and visual selection extension.
export function bracketMotion(bracket: string, key: string): Motion | undefined {
  if (bracket === "]" && key === "}") return { type: "unmatchedForward", char: "}" };
  if (bracket === "]" && key === ")") return { type: "unmatchedForward", char: ")" };
  if (bracket === "[" && key === "{") return { type: "unmatchedBackward", char: "{" };
  if (bracket === "[" && key === "(") return { type: "unmatchedBackward", char: "(" };
  return undefined;
}

// `vim::Vim::motion` dispatches those motions by mode. This is the local
// key-to-motion subset used by both normal and visual modes.
export function motionForKey(key: string): Motion | undefined {
  switch (key) {
    case "h":
    case "left":
      return { type: "left" };
    case "l":
    case "right":
      return { type: "right" };
    case "space":
      return { type: "wrappingRight" };
    case "backspace":
      return { type: "wrappingLeft" };
    case "ctrl-left":
      return { type: "previousWordStart", bigWord: false };
    case "ctrl-right":
      return { type: "nextWordStart", bigWord: false };
    case "k":
    case "up":
      return { type: "up" };
    case "j":
    case "down":
      return { type: "down" };
    case "0":
    case "home":
      return { type: "startOfLine" };
    case "ctrl-home":
      return { type: "startOfFile" };
    case "ctrl-end":
      return { type: "endOfDocument" };
    case "^":
      return { type: "firstNonWhitespace" };
    case "$":
    case "end":
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
    case "%":
      return { type: "matching" };
    case "H":
      return { type: "windowLine", target: "top" };
    case "M":
      return { type: "windowLine", target: "middle" };
    case "L":
      return { type: "windowLine", target: "bottom" };
    case ")":
      return { type: "nextSentence" };
    case "(":
      return { type: "previousSentence" };
    case "}":
      return { type: "endOfParagraph" };
    case "{":
      return { type: "startOfParagraph" };
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

function wrappingRight(editor: VimEditorCapabilities, pos: Position): Position {
  const clipped = clipPosition(editor, pos);
  const lineLength = editor.lineLength(clipped.row);
  if (lineLength === 0) {
    if (clipped.row + 1 < editor.lineCount()) return { row: clipped.row + 1, column: 0 };
    return clipped;
  }
  if (clipped.column + 1 < lineLength) return { row: clipped.row, column: clipped.column + 1 };
  if (clipped.row + 1 < editor.lineCount()) return { row: clipped.row + 1, column: 0 };
  return normalCursorPosition(editor, clipped);
}

function firstNonWhitespace(editor: VimEditorCapabilities, row: number): Position {
  return { row, column: firstNonWhitespaceColumn(editor.line(row)) };
}

export function firstNonWhitespaceColumn(line: string): number {
  const first = line.search(/\S/);
  return first < 0 ? 0 : first;
}

function firstNonWhitespaceOrCurrent(editor: VimEditorCapabilities, current: Position): Position {
  const line = editor.line(current.row);
  return line.search(/\S/) < 0 ? current : firstNonWhitespace(editor, current.row);
}

function lastNonWhitespace(editor: VimEditorCapabilities, row: number): Position {
  const line = editor.line(row);
  const match = /\S\s*$/.exec(line);
  return { row, column: match === null ? 0 : match.index };
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
    if (editor.lineLength(current.row) === 0) return normalCursorPosition(editor, current);
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

// Zed: `motion::previous_word_end`, reached from `motion::Motion::move_point`.
function previousWordEnd(editor: VimEditorCapabilities, start: Position, bigWord: boolean): Position {
  let current: Position | undefined = start;
  const startChar = charAt(editor, current);
  if (startChar !== undefined && charClass(startChar, bigWord) !== "whitespace") {
    const startClass = charClass(startChar, bigWord);
    current = previousPosition(editor, current);
    while (current !== undefined) {
      const char = charAt(editor, current);
      if (char === undefined || charClass(char, bigWord) !== startClass) break;
      current = previousPosition(editor, current);
    }
  } else {
    current = previousPosition(editor, current);
  }

  while (current !== undefined) {
    if (editor.lineLength(current.row) === 0) return normalCursorPosition(editor, current);
    const char = charAt(editor, current);
    if (char !== undefined && charClass(char, bigWord) !== "whitespace") break;
    current = previousPosition(editor, current);
  }

  return current === undefined ? position(0, 0) : normalCursorPosition(editor, current);
}

// Zed: `motion::Motion::move_point`. We keep the
// same dispatch shape, but delegate only to local model-position helpers for now.
export function matchingPositionFromLine(editor: VimEditorCapabilities, start: Position): Position {
  return matching(editor, start, { searchBackwardOnLine: true });
}

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
    case "wrappingRight":
      return wrappingRight(editor, clipped);
    case "up":
      return normalCursorPosition(editor, { row: clipped.row - 1, column: clipped.column });
    case "down":
      return normalCursorPosition(editor, { row: clipped.row + 1, column: clipped.column });
    case "startOfLine":
      return { row: clipped.row, column: 0 };
    case "firstNonWhitespace":
      return firstNonWhitespaceOrCurrent(editor, clipped);
    case "lastNonWhitespace":
      return lastNonWhitespace(editor, clipped.row);
    case "middleOfLine":
      return middleOfLine(editor, clipped.row, 50);
    case "forcedCharwise":
      return applyMotionOnce(editor, start, motion.motion);
    case "endOfLine":
      return endOfLine(editor, clipped.row);
    case "startOfDocument":
      return normalCursorPosition(editor, { row: 0, column: clipped.column });
    case "startOfFile":
      return position(0, 0);
    case "endOfDocument":
      return endOfLine(editor, editor.lineCount() - 1);
    case "goToLine":
      return normalCursorPosition(editor, {
        row: Math.max(0, Math.min(motion.line - 1, editor.lineCount() - 1)),
        column: clipped.column,
      });
    case "goToColumn":
      return normalCursorPosition(editor, { row: clipped.row, column: motion.column - 1 });
    case "firstNonBlankLine":
      return firstNonWhitespace(editor, motion.direction === "down"
        ? Math.min(clipped.row + 1, editor.lineCount() - 1)
        : Math.max(clipped.row - 1, 0));
    case "nextWordStart":
      return nextWordStart(editor, clipped, motion.bigWord);
    case "nextWordEnd":
      return nextWordEnd(editor, clipped, motion.bigWord);
    case "previousWordStart":
      return previousWordStart(editor, clipped, motion.bigWord);
    case "previousWordEnd":
      return previousWordEnd(editor, clipped, motion.bigWord);
    case "matching":
      return matching(editor, clipped);
    case "windowLine": {
      const visible = editor.visibleRowRange() ?? { top: 0, bottom: editor.lineCount() - 1 };
      const row = motion.target === "top"
        ? visible.top
        : motion.target === "bottom"
          ? visible.bottom
          : Math.floor((visible.top + visible.bottom) / 2);
      return normalCursorPosition(editor, { row, column: clipped.column });
    }
    case "unmatchedForward":
      return unmatched(editor, clipped, motion.char, "forward");
    case "unmatchedBackward":
      return unmatched(editor, clipped, motion.char, "backward");
    case "nextSentence":
      return sentenceForward(editor, clipped, 1);
    case "previousSentence":
      return sentenceBackward(editor, clipped, 1);
    case "endOfParagraph":
      return endOfParagraphMotion(editor, clipped, 1);
    case "startOfParagraph":
      return startOfParagraphMotion(editor, clipped, 1);
    case "goToPercentage":
      return goToPercentage(editor, clipped, motion.percent);
    case "jump":
      return motion.line ? firstNonWhitespace(editor, motion.position.row) : normalCursorPosition(editor, motion.position);
    case "searchMatch":
      return normalCursorPosition(editor, motion.range.start);
    case "findForward":
      return findForward(editor, clipped, motion.char, 1, { before: motion.before }) ?? clipped;
    case "findBackward":
      return findBackward(editor, clipped, motion.char, 1, { after: motion.after });
    case "searchForward":
      return searchForward(editor, clipped, motion.query, motion.options, motion.offset) ?? clipped;
    case "searchBackward":
      return searchBackward(editor, clipped, motion.query, motion.options, motion.offset) ?? clipped;
  }
}

// Local helper corresponding to Zed's repeated `times` argument threaded through
// `vim::Vim::motion` and `motion::Motion::move_point`.
/** Motions whose natural operator range includes the character the motion
    lands on (Vim "inclusive" motions); used to toggle inclusivity for forced
    charwise motions. */
function isInclusiveMotion(motion: Motion): boolean {
  switch (motion.type) {
    case "endOfLine":
    case "nextWordEnd":
    case "previousWordEnd":
    case "lastNonWhitespace":
    case "matching":
    case "findForward":
    case "goToPercentage":
      return true;
    case "searchForward":
    case "searchBackward":
      // Vim: an `e` (end) search offset makes the motion inclusive; a `start`
      // offset (or none) leaves it exclusive.
      return motion.offset?.type === "end";
    default:
      return false;
  }
}

function middleOfLine(editor: VimEditorCapabilities, row: number, percent: number): Position {
  const column = Math.floor((editor.lineLength(row) * percent) / 100);
  return normalCursorPosition(editor, { row, column });
}

export function applyMotion(
  editor: VimEditorCapabilities,
  start: Position,
  motion: Motion,
  count: number
): Position {
  return applyMotionWithGoal(editor, start, motion, count).position;
}

// VSCode-specific motion capability hook. Zed computes display/fold-aware motion
// directly against its DisplaySnapshot. Locally, the core asks the host for
// view-line motion targets when a motion is inherently view-dependent.
export function hostViewLineSelectionsForMotion(
  editor: VimEditorCapabilities,
  motion: Motion,
  count: number,
  options: { displayLine: boolean; extend: boolean }
): readonly VimSelection[] | undefined {
  if (motion.type !== "up" && motion.type !== "down") return undefined;
  return editor.moveByViewLines(motion.type === "down" ? "down" : "up", count, {
    ...options,
    displayLine: motion.displayLine ?? options.displayLine,
  });
}

export type MotionResult = {
  position: Position;
  goal?: VimSelectionGoal;
};

// Zed: vertical movement preserves a `SelectionGoal` through repeated up/down
// motions. This is the local model-position equivalent: while moving vertically,
// remember the original target column even when shorter lines temporarily clip the
// cursor. Non-vertical motions clear the goal, except `$` which sets an explicit
// end-of-line goal.
export function applyMotionWithGoal(
  editor: VimEditorCapabilities,
  start: Position,
  motion: Motion,
  count: number,
  goal?: VimSelectionGoal,
  { allowEndOfLine = false }: { allowEndOfLine?: boolean } = {}
): MotionResult {
  if (motion.type === "findForward") {
    return { position: findForward(editor, start, motion.char, count, { before: motion.before }) ?? start };
  }
  if (motion.type === "startOfDocument") {
    const row = Math.max(0, Math.min(count - 1, editor.lineCount() - 1));
    return { position: normalCursorPosition(editor, { row, column: start.column }) };
  }
  if (motion.type === "startOfFile") {
    return { position: position(0, 0) };
  }
  if (motion.type === "endOfLine") {
    const row = Math.max(0, Math.min(start.row + count - 1, editor.lineCount() - 1));
    return { position: endOfLine(editor, row), goal: { type: "endOfLine" } };
  }
  if (motion.type === "lastNonWhitespace") {
    const row = Math.max(0, Math.min(start.row + count - 1, editor.lineCount() - 1));
    return { position: lastNonWhitespace(editor, row) };
  }
  if (motion.type === "middleOfLine") {
    // Vim `gM`: middle of the line, or [count] percent of the line width. A
    // count of 1 is indistinguishable from no count here; Vim's `1gM` is a
    // corner case this approximation accepts.
    return { position: middleOfLine(editor, start.row, count > 1 ? count : 50) };
  }
  if (motion.type === "forcedCharwise") {
    return applyMotionWithGoal(editor, start, motion.motion, count, goal, { allowEndOfLine });
  }
  if (motion.type === "windowLine") {
    // Vim `H`/`M`/`L`: move to the window's top/middle/bottom line, keeping
    // the column ('startofline' is off in Neovim). A count on `H`/`L` offsets
    // into the window. ('scrolloff' margins are not applied here yet.)
    const visible = editor.visibleRowRange() ?? { top: 0, bottom: editor.lineCount() - 1 };
    const row = (() => {
      switch (motion.target) {
        case "top":
          return Math.min(visible.top + count - 1, visible.bottom);
        case "middle":
          return Math.floor((visible.top + visible.bottom) / 2);
        case "bottom":
          return Math.max(visible.bottom - (count - 1), visible.top);
      }
    })();
    const nextGoal = goal ?? { type: "modelColumn" as const, column: start.column };
    return {
      position: { row, column: modelColumnForGoal(editor, row, nextGoal, { allowEndOfLine }) },
      goal: nextGoal,
    };
  }
  if (motion.type === "firstNonBlankLine") {
    // Vim `+`/`<CR>` (down) and `-` (up): [count] lines in [direction], first
    // non-blank column.
    const delta = motion.direction === "down" ? count : -count;
    const row = Math.max(0, Math.min(start.row + delta, editor.lineCount() - 1));
    return { position: firstNonWhitespace(editor, row) };
  }
  if (motion.type === "matching" || motion.type === "unmatchedForward" || motion.type === "unmatchedBackward" || motion.type === "nextSentence" || motion.type === "previousSentence" || motion.type === "endOfParagraph" || motion.type === "startOfParagraph" || motion.type === "goToPercentage" || motion.type === "jump" || motion.type === "searchMatch" || motion.type === "goToLine" || motion.type === "goToColumn") {
    if (motion.type === "nextSentence") return { position: sentenceForward(editor, start, count) };
    if (motion.type === "previousSentence") return { position: sentenceBackward(editor, start, count) };
    if (motion.type === "endOfParagraph") return { position: endOfParagraphMotion(editor, start, count) };
    if (motion.type === "startOfParagraph") return { position: startOfParagraphMotion(editor, start, count) };
    return { position: applyMotionOnce(editor, start, motion) };
  }
  if (motion.type === "findBackward") {
    return { position: findBackward(editor, start, motion.char, count, { after: motion.after }) };
  }
  if (motion.type === "searchForward") {
    return { position: searchForward(editor, start, motion.query, motion.options, motion.offset) ?? start };
  }
  if (motion.type === "searchBackward") {
    return { position: searchBackward(editor, start, motion.query, motion.options, motion.offset) ?? start };
  }
  if (motion.type === "up" || motion.type === "down") {
    const nextGoal = goal ?? { type: "modelColumn", column: start.column };
    const rowDelta = motion.type === "up" ? -count : count;
    const row = Math.max(0, Math.min(start.row + rowDelta, editor.lineCount() - 1));
    const column = modelColumnForGoal(editor, row, nextGoal, { allowEndOfLine });
    return {
      position: { row, column },
      goal: nextGoal,
    };
  }

  let current = start;
  for (let i = 0; i < count; i++) {
    current = applyMotionOnce(editor, current, motion);
  }
  return { position: current, goal: undefined };
}

function modelColumnForGoal(
  editor: VimEditorCapabilities,
  row: number,
  goal: VimSelectionGoal,
  { allowEndOfLine }: { allowEndOfLine: boolean }
): number {
  const maxColumn = allowEndOfLine ? editor.lineLength(row) : Math.max(0, editor.lineLength(row) - 1);
  switch (goal.type) {
    case "endOfLine":
      return maxColumn;
    case "modelColumn":
      return Math.min(goal.column, maxColumn);
    case "viewColumn":
      // View-column goals are 1-based VSCode view coordinates (set by the host
      // view-line movements, e.g. `ctrl-d`/`ctrl-u`). The model core cannot see
      // soft wraps or folds, so approximate with the 0-based model column.
      return Math.max(0, Math.min(goal.column - 1, maxColumn));
  }
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
  // Vim `o_v` (Zed: forced-motion handling in `motion::Motion::range`): `v`
  // after an operator forces the motion charwise. Linewise motions become
  // exclusive charwise ranges at the goal column; charwise motions toggle
  // inclusivity, adjusting the ordered range end by one character.
  if (motion.type === "forcedCharwise") {
    const inner = motion.motion;
    if (inner.type === "up" || inner.type === "down") {
      const target = applyMotion(editor, start, inner, count);
      const column = Math.min(start.column, editor.lineLength(target.row));
      // Vim `exclusive-linewise` rule 1: an exclusive motion ending in column
      // one instead ends at the end of the previous line. (Rule 2 — becoming
      // linewise when the start is at/before the first non-blank — is handled
      // by the operator layer, which can apply linewise operations.)
      if (column === 0 && target.row > start.row) {
        const previousRow = target.row - 1;
        return orderedRange(start, { row: previousRow, column: editor.lineLength(previousRow) });
      }
      return orderedRange(start, { row: target.row, column });
    }
    const range = motionRange(editor, start, inner, count);
    if (isInclusiveMotion(inner)) {
      const end = { row: range.end.row, column: Math.max(0, range.end.column - 1) };
      return { start: range.start, end: comparePositions(end, range.start) < 0 ? range.start : end };
    }
    const endLineLength = editor.lineLength(range.end.row);
    return {
      start: range.start,
      end: { row: range.end.row, column: Math.min(range.end.column + 1, endLineLength) },
    };
  }
  // Vim `c<BS>`/`d<BS>`: backspace is an exclusive motion to the previous
  // character; at the start of a line it targets the previous line's end-of-
  // line position (the newline), joining lines, rather than the clamped
  // normal-mode cursor cell.
  if (motion.type === "wrappingLeft") {
    if (start.column > 0) {
      return { start: { row: start.row, column: Math.max(0, start.column - count) }, end: start };
    }
    if (start.row > 0) {
      return { start: { row: start.row - 1, column: editor.lineLength(start.row - 1) }, end: start };
    }
    return { start, end: start };
  }
  const end = applyMotion(editor, start, motion, count);
  if (motion.type === "right") {
    return {
      start,
      end: { row: start.row, column: Math.min(start.column + count, editor.lineLength(start.row)) },
    };
  }
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
  if (motion.type === "endOfParagraph") {
    if (end.row > start.row && end.column === 0) {
      const startColumn = firstNonWhitespaceColumn(editor.line(start.row));
      if (start.column <= startColumn) {
        return lineRange(editor, start.row, Math.max(1, end.row - start.row));
      }
      const previousRow = end.row - 1;
      return orderedRange(start, { row: previousRow, column: editor.lineLength(previousRow) });
    }
    return orderedRange(start, nextPosition(editor, end) ?? end);
  }
  if (motion.type === "unmatchedForward") {
    // Vim `exclusive-linewise` rule 1: an exclusive motion ending in column
    // one ends at the end of the previous line instead (`d]}` does not join
    // the unmatched brace's line).
    if (end.column === 0 && end.row > start.row) {
      return orderedRange(start, { row: end.row - 1, column: editor.lineLength(end.row - 1) });
    }
    return orderedRange(start, end);
  }
  if (motion.type === "startOfParagraph" || motion.type === "nextSentence" || motion.type === "previousSentence" || motion.type === "goToPercentage" || motion.type === "matching" || motion.type === "unmatchedBackward" || motion.type === "jump") {
    return orderedRange(start, end);
  }
  if (motion.type === "searchMatch") {
    return motion.range;
  }
  if (motion.type === "findForward") {
    const target = findForwardTarget(editor, start, motion.char, count);
    if (target === undefined) return { start, end: start };
    return orderedRange(start, motion.before ? target : nextPosition(editor, target) ?? target);
  }
  if (motion.type === "findBackward") {
    const target = findBackwardTarget(editor, start, motion.char, count);
    if (target === undefined) return { start, end: start };
    return orderedRange(motion.after ? nextPosition(editor, target) ?? target : target, nextPosition(editor, start) ?? start);
  }
  if (motion.type === "searchForward" || motion.type === "searchBackward") {
    const target = editor.findSearchMatch(
      motion.query,
      start,
      motion.type === "searchForward" ? "forward" : "backward",
      motion.options
    );
    if (target === undefined) return { start, end: start };
    const offsetPosition = applySearchOffset(editor, target, motion.offset);
    // Vim: `/pat/e` (end offset) makes the operator motion inclusive of the
    // landed-on character; without an `e` offset it stays exclusive, as a plain
    // `/pat` search does. The inclusive extension only makes sense for a forward
    // landing (the common `d/pat/e`); for a backward landing the position is the
    // ordered start and is already included.
    if (motion.offset?.type === "end" && comparePositions(offsetPosition, start) >= 0) {
      return orderedRange(start, nextPosition(editor, offsetPosition) ?? offsetPosition);
    }
    return orderedRange(start, offsetPosition);
  }
  if (motion.type === "previousWordStart" && end.row < start.row && start.column === 0) {
    const lastIncludedRow = start.row - 1;
    return orderedRange(end, { row: lastIncludedRow, column: editor.lineLength(lastIncludedRow) });
  }
  return orderedRange(start, end);
}

function findForward(
  editor: VimEditorCapabilities,
  start: Position,
  char: string,
  count: number,
  { before }: { before: boolean }
): Position | undefined {
  const target = findForwardTarget(editor, start, char, count);
  if (target === undefined) return undefined;
  if (!before) return target;
  if (target.column > 0) return { row: target.row, column: target.column - 1 };
  return target;
}

function findBackward(
  editor: VimEditorCapabilities,
  start: Position,
  char: string,
  count: number,
  { after }: { after: boolean }
): Position {
  const target = findBackwardTarget(editor, start, char, count);
  if (target === undefined) return start;
  if (!after) return target;
  return { row: target.row, column: Math.min(target.column + 1, Math.max(0, editor.lineLength(target.row) - 1)) };
}

function findForwardTarget(editor: VimEditorCapabilities, start: Position, char: string, count: number): Position | undefined {
  const line = editor.line(start.row);
  let from = Math.min(start.column + 1, line.length);
  let found = -1;
  for (let index = 0; index < count; index++) {
    found = line.indexOf(char, from);
    if (found < 0) return undefined;
    from = found + 1;
  }
  return { row: start.row, column: found };
}

function findBackwardTarget(editor: VimEditorCapabilities, start: Position, char: string, count: number): Position | undefined {
  const line = editor.line(start.row);
  let from = Math.min(start.column - 1, line.length - 1);
  let found = -1;
  for (let index = 0; index < count; index++) {
    found = line.lastIndexOf(char, from);
    if (found < 0) return undefined;
    from = found - 1;
  }
  return { row: start.row, column: found };
}

function searchForward(editor: VimEditorCapabilities, start: Position, query: string, options: SearchOptions = {}, offset?: SearchOffset): Position | undefined {
  return searchWithOffset(editor, start, query, "forward", options, offset);
}

function searchBackward(editor: VimEditorCapabilities, start: Position, query: string, options: SearchOptions = {}, offset?: SearchOffset): Position | undefined {
  return searchWithOffset(editor, start, query, "backward", options, offset);
}

function searchWithOffset(
  editor: VimEditorCapabilities,
  start: Position,
  query: string,
  direction: "forward" | "backward",
  options: SearchOptions,
  offset: SearchOffset | undefined
): Position | undefined {
  const match = editor.findSearchMatch(query, start, direction, options);
  if (match === undefined) return undefined;
  const position = applySearchOffset(editor, match, offset);
  // Vim: a search always makes progress. An offset can land the cursor back on
  // its starting position (e.g. `N` after `/pat/e` re-finds the same match, since
  // the cursor sits past that match's start); when it does, skip to the adjacent
  // match in the search direction.
  if (offset !== undefined && comparePositions(position, start) === 0) {
    const next = editor.findSearchMatch(query, match.start, direction, options);
    if (next !== undefined) return applySearchOffset(editor, next, offset);
  }
  return position;
}

// Vim `search-offset`: translate a match range into the cursor position implied
// by the offset. `end` targets the last character of the match (`range.end` is
// exclusive, so `end - 1`); `start` its first character; both shifted by the
// signed character delta (which may cross line boundaries via the buffer
// offset). With no offset the cursor goes to the match start, as before.
function applySearchOffset(editor: VimEditorCapabilities, range: TextRange, offset?: SearchOffset): Position {
  if (offset === undefined) return range.start;
  const base = offset.type === "end"
    ? offsetOfPosition(editor, range.end) - 1
    : offsetOfPosition(editor, range.start);
  return positionOfOffset(editor, Math.max(0, base + offset.delta));
}

function documentText(editor: VimEditorCapabilities): string {
  const lines: string[] = [];
  for (let row = 0; row < editor.lineCount(); row++) lines.push(editor.line(row));
  return lines.join("\n");
}

function goToPercentage(editor: VimEditorCapabilities, start: Position, percent: number): Position {
  const row = Math.max(0, Math.min(editor.lineCount() - 1, Math.floor(editor.lineCount() * percent / 100)));
  return normalCursorPosition(editor, { row, column: start.column });
}

// Zed: `motion::start_of_paragraph` / `end_of_paragraph`. Paragraphs are runs of
// non-empty lines; whitespace-only lines are not boundaries.
function startOfParagraphMotion(editor: VimEditorCapabilities, start: Position, count: number): Position {
  if (start.row === 0) return position(0, 0);

  let remaining = Math.max(1, count);
  let foundNonEmptyLine = false;
  for (let row = start.row; row >= 0; row--) {
    const empty = editor.lineLength(row) === 0;
    if (foundNonEmptyLine && empty) {
      if (remaining <= 1) return { row, column: 0 };
      remaining--;
      foundNonEmptyLine = false;
    }
    foundNonEmptyLine ||= !empty;
  }
  return position(0, 0);
}

function endOfParagraphMotion(editor: VimEditorCapabilities, start: Position, count: number): Position {
  if (start.row === editor.lineCount() - 1) return endOfLine(editor, editor.lineCount() - 1);

  let remaining = Math.max(1, count);
  let foundNonEmptyLine = false;
  for (let row = start.row; row < editor.lineCount(); row++) {
    const empty = editor.lineLength(row) === 0;
    if (foundNonEmptyLine && empty) {
      if (remaining <= 1) return { row, column: 0 };
      remaining--;
      foundNonEmptyLine = false;
    }
    foundNonEmptyLine ||= !empty;
  }
  return endOfLine(editor, editor.lineCount() - 1);
}

// Zed: `motion::sentence_forwards` / `sentence_backwards`, translated to offsets
// over the model buffer. A sentence starts after `.`, `?`, or `!` followed by
// whitespace/nonblank text, or after blank-line boundaries.
function sentenceForward(editor: VimEditorCapabilities, start: Position, count: number): Position {
  const text = documentText(editor);
  const startOffset = offsetOfPosition(editor, start);
  let remaining = Math.max(1, count);
  let wasBlankBoundary = startOffset > 0 && text[startOffset - 1] === "\n" && text[startOffset] === "\n";

  for (let offset = startOffset; offset < text.length; offset++) {
    const char = text[offset];
    if (wasBlankBoundary && char === "\n") continue;

    const next = wasBlankBoundary
      ? nextNonBlankOffset(text, offset)
      : char === "\n" && text[offset + 1] === "\n"
        ? nextNonBlankOffset(text, offset + 1)
        : char === "." || char === "?" || char === "!"
          ? startOfNextSentenceOffset(text, offset + 1)
          : undefined;

    if (next !== undefined) {
      remaining--;
      if (remaining === 0) return normalCursorPosition(editor, positionOfOffset(editor, next));
    }

    wasBlankBoundary = char === "\n" && text[offset + 1] === "\n";
  }

  return endOfLine(editor, editor.lineCount() - 1);
}

function sentenceBackward(editor: VimEditorCapabilities, start: Position, count: number): Position {
  const text = documentText(editor);
  const originalStart = offsetOfPosition(editor, start);
  let startOffset = originalStart;
  let remaining = Math.max(1, count);
  let wasNewline = text[startOffset] === "\n";

  for (let offset = startOffset - 1; offset >= 0; offset--) {
    const char = text[offset];
    const next = wasNewline && char === "\n"
      ? offset + 1
      : char === "\n" && text[offset - 1] === "\n"
        ? nextNonBlankOffset(text, offset + 1)
        : char === "." || char === "?" || char === "!"
          ? startOfNextSentenceOffset(text, offset + 1)
          : undefined;

    if (next !== undefined) {
      if (next < startOffset) remaining--;
      if (remaining === 0 || offset === 0) return normalCursorPosition(editor, positionOfOffset(editor, next));
    }
    if (wasNewline) startOffset = offset;
    wasNewline = char === "\n";
  }

  return position(0, 0);
}

function nextNonBlankOffset(text: string, start: number): number {
  for (let offset = start; offset < text.length; offset++) {
    const char = text[offset];
    if (char === "\n" || !/\s/.test(char)) return offset;
  }
  return text.length;
}

function startOfNextSentenceOffset(text: string, offset: number): number | undefined {
  let seenSpace = false;
  for (let index = offset; index < text.length; index++) {
    const char = text[index];
    if (!seenSpace && (char === ")" || char === "]" || char === "\"" || char === "'")) continue;
    if (char === "\n" && seenSpace) return index;
    if (/\s/.test(char)) seenSpace = true;
    else if (seenSpace) return index;
    else return undefined;
  }
  return text.length;
}

// Zed: `motion::matching`, reached from `Motion::Matching`. This local version is
// text-based and intentionally limited to bracket pairs; Zed also uses syntax-aware
// bracket ranges, comments, tags, preprocessor directives, and optional quote matching.
function matching(editor: VimEditorCapabilities, start: Position, { searchBackwardOnLine = false }: { searchBackwardOnLine?: boolean } = {}): Position {
  const text = documentText(editor);
  const startOffset = offsetOfPosition(editor, start);
  const lineStart = offsetOfPosition(editor, { row: start.row, column: 0 });
  const lineEnd = lineStart + editor.lineLength(start.row);
  const bracketOffset = bracketOffsetForMatching(text, startOffset, lineStart, lineEnd, { searchBackwardOnLine });
  if (bracketOffset === undefined) return start;
  const matchOffset = matchingBracketOffset(text, bracketOffset);
  return matchOffset === undefined ? start : normalCursorPosition(editor, positionOfOffset(editor, matchOffset));
}

function bracketOffsetForMatching(text: string, startOffset: number, lineStart: number, lineEnd: number, { searchBackwardOnLine }: { searchBackwardOnLine: boolean }): number | undefined {
  for (let offset = startOffset; offset <= lineEnd && offset < text.length; offset++) {
    if (bracketPair(text[offset]) !== undefined) return offset;
  }
  if (searchBackwardOnLine) {
    for (let offset = Math.min(startOffset - 1, lineEnd - 1); offset >= lineStart; offset--) {
      if (bracketPair(text[offset]) !== undefined) return offset;
    }
  }
  return undefined;
}

function matchingBracketOffset(text: string, bracketOffset: number): number | undefined {
  const bracket = bracketPair(text[bracketOffset]);
  if (bracket === undefined) return undefined;
  const { open, close, direction } = bracket;
  let depth = 0;

  if (direction === "forward") {
    for (let offset = bracketOffset; offset < text.length; offset++) {
      const char = text[offset];
      if (char === open) depth++;
      if (char === close) {
        depth--;
        if (depth === 0) return offset;
      }
    }
  } else {
    for (let offset = bracketOffset; offset >= 0; offset--) {
      const char = text[offset];
      if (char === close) depth++;
      if (char === open) {
        depth--;
        if (depth === 0) return offset;
      }
    }
  }

  return undefined;
}

function unmatched(editor: VimEditorCapabilities, start: Position, char: string, direction: "forward" | "backward"): Position {
  const pair = pairForTarget(char);
  if (pair === undefined) return start;
  const text = documentText(editor);
  const startOffset = offsetOfPosition(editor, start);
  const matchOffset = direction === "forward"
    ? unmatchedForwardOffset(text, startOffset, pair)
    : unmatchedBackwardOffset(text, startOffset, pair);
  return matchOffset === undefined ? start : normalCursorPosition(editor, positionOfOffset(editor, matchOffset));
}

function unmatchedForwardOffset(text: string, startOffset: number, { open, close }: { open: string; close: string }): number | undefined {
  let depth = unmatchedDepthBefore(text, startOffset, { open, close });
  for (let offset = startOffset; offset < text.length; offset++) {
    const char = text[offset];
    if (char === open) depth++;
    if (char === close) {
      if (depth <= 1) return offset;
      depth--;
    }
  }
  return undefined;
}

function unmatchedDepthBefore(text: string, startOffset: number, { open, close }: { open: string; close: string }): number {
  let depth = 0;
  for (let offset = 0; offset < startOffset; offset++) {
    const char = text[offset];
    if (char === open) depth++;
    if (char === close && depth > 0) depth--;
  }
  return depth;
}

function unmatchedBackwardOffset(text: string, startOffset: number, { open, close }: { open: string; close: string }): number | undefined {
  let depth = 0;
  for (let offset = startOffset; offset >= 0; offset--) {
    const char = text[offset];
    if (char === close) depth++;
    if (char === open) {
      if (depth === 0) return offset;
      depth--;
    }
  }
  return undefined;
}

function pairForTarget(char: string): { open: string; close: string } | undefined {
  switch (char) {
    case "(":
    case ")":
      return { open: "(", close: ")" };
    case "[":
    case "]":
      return { open: "[", close: "]" };
    case "{":
    case "}":
      return { open: "{", close: "}" };
    case "<":
    case ">":
      return { open: "<", close: ">" };
    default:
      return undefined;
  }
}

function bracketPair(char: string | undefined): { open: string; close: string; direction: "forward" | "backward" } | undefined {
  switch (char) {
    case "(":
      return { open: "(", close: ")", direction: "forward" };
    case ")":
      return { open: "(", close: ")", direction: "backward" };
    case "[":
      return { open: "[", close: "]", direction: "forward" };
    case "]":
      return { open: "[", close: "]", direction: "backward" };
    case "{":
      return { open: "{", close: "}", direction: "forward" };
    case "}":
      return { open: "{", close: "}", direction: "backward" };
    case "<":
      return { open: "<", close: ">", direction: "forward" };
    case ">":
      return { open: "<", close: ">", direction: "backward" };
    default:
      return undefined;
  }
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
  return { row, column: Math.max(0, editor.lineLength(row) - 1) };
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
  // Vim: the cursor column clamps against the line the cursor LANDS on after
  // the delete (the line following the deleted range), not the deleted line.
  const targetLineLengthBeforeDelete = deletingThroughLastLine
    ? editor.lineLength(rowAfterDelete)
    : editor.lineLength(Math.min(row + deletedLineCount, lineCountBeforeDelete - 1));
  return { row: rowAfterDelete, column: Math.min(column, Math.max(0, targetLineLengthBeforeDelete - 1)) };
}

export function isForwardRange(range: TextRange): boolean {
  return comparePositions(range.start, range.end) <= 0;
}
