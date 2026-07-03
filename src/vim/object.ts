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
  | { type: "surround"; open: string; close: string }
  // `it`/`at` tag blocks (`:h tag-blocks`): text-based HTML/XML tag pairs,
  // filetype-independent like Vim's.
  | { type: "tag" }
  // vim-indent-object (VSCodeVim compat): `ii` the current indentation block,
  // `ai` plus the line above, `aI` ([big]) plus the lines above and below.
  // Linewise, like the plugin.
  | { type: "indent"; big: boolean }
  // targets.vim-style argument object (VSCodeVim compat): `ia` the argument,
  // `aa` including one separator.
  | { type: "argument" }
  // vim-textobj-entire (VSCodeVim compat): `ae` the whole buffer, `ie` without
  // leading/trailing blank lines. Linewise.
  | { type: "entire" };

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
    case "t":
      return { type: "tag" };
    case "i":
      return { type: "indent", big: false };
    case "I":
      return { type: "indent", big: true };
    case "a":
      return { type: "argument" };
    case "e":
      return { type: "entire" };
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
    case "tag":
      return tagRange(editor, head, { around, count });
    case "indent":
      return indentRange(editor, head, { around, big: object.big });
    case "argument":
      return argumentRange(editor, head, { around }) ?? { start: head, end: head };
    case "entire":
      return entireRange(editor, { around });
  }
}

// ---------------------------------------------------------------------------
// vim-indent-object (`ii`/`ai`/`aI`)
// ---------------------------------------------------------------------------

function lineIsBlank(editor: VimEditorCapabilities, row: number): boolean {
  return /^[ \t]*$/.test(editor.line(row));
}

function lineIndentWidth(editor: VimEditorCapabilities, row: number): number {
  const match = /^[ \t]*/.exec(editor.line(row));
  return match === null ? 0 : match[0].length;
}

// The indentation block around the cursor: contiguous lines whose indent is at
// least the reference line's, with blank lines bridging same-level runs but
// trimmed from the block's edges. `around` includes the first non-blank line
// above (`ai` — a Python `if:` header); [big] (`aI`) also the one below.
function indentRange(
  editor: VimEditorCapabilities,
  head: Position,
  { around, big }: { around: boolean; big: boolean }
): TextRange {
  const lastRow = editor.lineCount() - 1;
  // Reference line: the cursor line, or the nearest non-blank below then above.
  let referenceRow = head.row;
  if (lineIsBlank(editor, referenceRow)) {
    let below = referenceRow;
    while (below <= lastRow && lineIsBlank(editor, below)) below++;
    let above = referenceRow;
    while (above >= 0 && lineIsBlank(editor, above)) above--;
    referenceRow = below <= lastRow ? below : above;
    if (referenceRow < 0) return fullLineRange(editor, head.row, head.row);
  }
  const referenceIndent = lineIndentWidth(editor, referenceRow);

  let startRow = referenceRow;
  while (startRow > 0 && (lineIsBlank(editor, startRow - 1) || lineIndentWidth(editor, startRow - 1) >= referenceIndent)) {
    startRow--;
  }
  let endRow = referenceRow;
  while (endRow < lastRow && (lineIsBlank(editor, endRow + 1) || lineIndentWidth(editor, endRow + 1) >= referenceIndent)) {
    endRow++;
  }
  // Blank lines bridge the block but are not part of its edges.
  while (startRow < referenceRow && lineIsBlank(editor, startRow)) startRow++;
  while (endRow > referenceRow && lineIsBlank(editor, endRow)) endRow--;

  if (around) {
    let above = startRow - 1;
    while (above >= 0 && lineIsBlank(editor, above)) above--;
    if (above >= 0) startRow = above;
    if (big) {
      let below = endRow + 1;
      while (below <= lastRow && lineIsBlank(editor, below)) below++;
      if (below <= lastRow) endRow = below;
    }
  }
  return fullLineRange(editor, startRow, endRow);
}

function fullLineRange(editor: VimEditorCapabilities, startRow: number, endRow: number): TextRange {
  return {
    start: { row: startRow, column: 0 },
    end: { row: endRow, column: editor.lineLength(endRow) },
  };
}

// ---------------------------------------------------------------------------
// Argument object (`ia`/`aa`, targets.vim-style)
// ---------------------------------------------------------------------------

const ARGUMENT_OPEN = "([";
const ARGUMENT_CLOSE = ")]";
const ARGUMENT_SEPARATOR = ",";

// The innermost `(`/`[` pair enclosing [offset], skipping quoted strings and
// nested brackets.
function enclosingArgumentList(text: string, offset: number): { open: number; close: number } | undefined {
  const stack: number[] = [];
  let enclosing: { open: number; close: number } | undefined;
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === "\\") index++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (ARGUMENT_OPEN.includes(char)) {
      stack.push(index);
      continue;
    }
    if (ARGUMENT_CLOSE.includes(char)) {
      const open = stack.pop();
      if (open === undefined) continue;
      if (open <= offset && offset < index + 1 && enclosing === undefined) {
        enclosing = { open, close: index };
      }
      // Keep scanning: an outer pair may also enclose, but the first found
      // closing after the cursor with an open before it is the innermost.
    }
  }
  return enclosing;
}

export function argumentRange(
  editor: VimEditorCapabilities,
  head: Position,
  { around }: { around: boolean }
): TextRange | undefined {
  const text = editor.getText();
  const offset = offsetOfPosition(editor, head);
  const list = enclosingArgumentList(text, offset);
  if (list === undefined) return undefined;

  // Separator offsets at depth 0 within the list, quotes respected.
  const separators: number[] = [];
  let depth = 0;
  let quote: string | undefined;
  for (let index = list.open + 1; index < list.close; index++) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === "\\") index++;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (ARGUMENT_OPEN.includes(char)) depth++;
    else if (ARGUMENT_CLOSE.includes(char)) depth--;
    else if (char === ARGUMENT_SEPARATOR && depth === 0) separators.push(index);
  }

  const boundaries = [list.open, ...separators, list.close];
  let argumentIndex = boundaries.length - 2;
  for (let index = 0; index + 1 < boundaries.length; index++) {
    if (offset <= boundaries[index + 1]) {
      argumentIndex = index;
      break;
    }
  }
  const previousBoundary = boundaries[argumentIndex];
  const nextBoundary = boundaries[argumentIndex + 1];

  // Inner argument: trimmed of surrounding whitespace.
  let innerStart = previousBoundary + 1;
  while (innerStart < nextBoundary && /\s/.test(text[innerStart])) innerStart++;
  let innerEnd = nextBoundary;
  while (innerEnd > innerStart && /\s/.test(text[innerEnd - 1])) innerEnd--;

  if (!around) {
    return { start: positionOfOffset(editor, innerStart), end: positionOfOffset(editor, innerEnd) };
  }
  // `aa`: include the following separator (and the whitespace after it) when
  // one exists; for the last argument, the leading separator instead.
  const hasNextSeparator = argumentIndex + 1 < boundaries.length - 1;
  if (hasNextSeparator) {
    let end = nextBoundary + 1;
    while (end < list.close && /\s/.test(text[end])) end++;
    return { start: positionOfOffset(editor, innerStart), end: positionOfOffset(editor, end) };
  }
  const hasPreviousSeparator = argumentIndex > 0;
  const start = hasPreviousSeparator ? previousBoundary : innerStart;
  return { start: positionOfOffset(editor, start), end: positionOfOffset(editor, innerEnd) };
}

/** Whether an argument object exists at the cursor (an enclosing `(`/`[`
    list); a missing list fails the operator, like surround objects. */
export function argumentObjectFound(editor: VimEditorCapabilities, head: Position): boolean {
  return enclosingArgumentList(editor.getText(), offsetOfPosition(editor, head)) !== undefined;
}

// ---------------------------------------------------------------------------
// Entire buffer (`ae`/`ie`)
// ---------------------------------------------------------------------------

function entireRange(editor: VimEditorCapabilities, { around }: { around: boolean }): TextRange {
  const lastRow = editor.lineCount() - 1;
  if (around) return fullLineRange(editor, 0, lastRow);
  let startRow = 0;
  while (startRow < lastRow && lineIsBlank(editor, startRow)) startRow++;
  let endRow = lastRow;
  while (endRow > startRow && lineIsBlank(editor, endRow)) endRow--;
  return fullLineRange(editor, startRow, endRow);
}

function wordRange(
  editor: VimEditorCapabilities,
  head: Position,
  { around, bigWord, count }: { around: boolean; bigWord: boolean; count: number }
): TextRange {
  const text = editor.getText();
  if (text.length === 0) return { start: head, end: head };

  const headOffset = Math.min(offsetOfPosition(editor, head), Math.max(0, text.length - 1));
  if (around && isWhitespace(text[headOffset])) {
    return aroundWordFromWhitespace(editor, text, headOffset, bigWord, count);
  }
  if (!around && count === 1 && isWhitespace(text[headOffset])) {
    // Vim: an empty line is a word of its own (`:h iw`); `iw` on one selects
    // nothing, so `diw`/`ciw` leave the line in place.
    if (text[headOffset] === "\n") return { start: head, end: head };
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

// Zed: `object::sentence`.
function sentenceRange(
  editor: VimEditorCapabilities,
  head: Position,
  { around }: { around: boolean }
): TextRange {
  const text = editor.getText();
  const relativeOffset = offsetOfPosition(editor, head);
  let start: number | undefined;
  let previousEnd = relativeOffset;

  // Search backwards for the previous sentence end or current sentence start.
  // Include the character under the cursor.
  for (
    let offset = relativeOffset < text.length ? relativeOffset : relativeOffset - 1;
    offset >= 0;
    offset--
  ) {
    if (isSentenceEnd(text, offset)) break;
    if (isPossibleSentenceStart(text[offset])) start = offset;
    previousEnd = offset;
  }

  // Search forward for the end of the current sentence or, if we are between
  // sentences, the start of the next one.
  let end = relativeOffset;
  for (let offset = relativeOffset; offset < text.length; offset++) {
    const char = text[offset];
    if (start === undefined && isPossibleSentenceStart(char)) {
      if (around) {
        start = offset;
        continue;
      }
      end = offset;
      break;
    }

    if (char !== "\n") end = offset + 1;
    if (isSentenceEnd(text, end)) break;
  }

  let range = { start: start ?? previousEnd, end };
  // Intentional difference from Zed (which passes stop_at_newline=false and
  // exempted the affected cases): Vim's `as` only takes whitespace on the
  // sentence's own line, falling back to the leading whitespace when the
  // sentence ends the line (`:h sentence`); the recorded Neovim fixtures
  // require stopping at newlines.
  if (around) range = expandOffsetsToIncludeWhitespace(text, range, { stopAtNewline: true });

  return { start: positionOfOffset(editor, range.start), end: positionOfOffset(editor, range.end) };
}

// Zed: `object::is_possible_sentence_start`.
function isPossibleSentenceStart(character: string): boolean {
  return !/\s/.test(character) && character !== ".";
}

const SENTENCE_END_PUNCTUATION = [".", "!", "?"];
const SENTENCE_END_FILLERS = [")", "]", "\"", "'"];
const SENTENCE_END_WHITESPACE = [" ", "\t", "\n"];

// Zed: `object::is_sentence_end`.
function isSentenceEnd(text: string, offset: number): boolean {
  const next = text[offset];
  if (next !== undefined) {
    // We are at a double newline. This position is a sentence end.
    if (next === "\n" && text[offset + 1] === "\n") return true;
    // The next text is not a valid whitespace. This is not a sentence end.
    if (!SENTENCE_END_WHITESPACE.includes(next)) return false;
  }

  for (let index = offset - 1; index >= 0; index--) {
    const char = text[index];
    if (SENTENCE_END_PUNCTUATION.includes(char)) return true;
    if (!SENTENCE_END_FILLERS.includes(char)) return false;
  }

  return false;
}

// Zed: `object::expand_to_include_whitespace`. Expands the range to include
// whitespace at the end first, falling back to the start if there was none.
function expandOffsetsToIncludeWhitespace(
  text: string,
  range: { start: number; end: number },
  { stopAtNewline }: { stopAtNewline: boolean }
): { start: number; end: number } {
  let { start, end } = range;
  let whitespaceIncluded = false;

  for (let offset = end; offset < text.length; offset++) {
    const char = text[offset];
    if (char === "\n" && stopAtNewline) break;
    if (!/\s/.test(char)) break;
    if (char !== "\n" || !stopAtNewline) {
      end = offset + 1;
      whitespaceIncluded = true;
    }
  }

  if (!whitespaceIncluded) {
    for (let offset = start - 1; offset >= 0; offset--) {
      const char = text[offset];
      if (char === "\n" && stopAtNewline) break;
      if (!/\s/.test(char)) break;
      start = offset;
    }
  }

  return { start, end };
}

// ---------------------------------------------------------------------------
// Tag blocks (`it`/`at`, and the vim-surround `t` target)
// ---------------------------------------------------------------------------

// A parsed tag token: `<name ...>` (open), `</name>` (close); self-closing
// tags (`<br/>`) are skipped when pairing, like Vim. Offsets are document
// text offsets; [end] is exclusive.
type TagToken = { name: string; kind: "open" | "close" | "selfClose"; start: number; end: number };

export type TagBlock = {
  // `<name ...>` token, exclusive end.
  openStart: number;
  openEnd: number;
  // `</name>` token, exclusive end.
  closeStart: number;
  closeEnd: number;
};

// Tag tokens: a name starting with a letter, attributes allowing quoted
// strings (so `>` inside an attribute value does not terminate the token).
const TAG_TOKEN = /<(\/?)([A-Za-z][^\s>/]*)((?:"[^"]*"|'[^']*'|[^<>"'])*?)(\/?)>/g;

function parseTagTokens(text: string): TagToken[] {
  const tokens: TagToken[] = [];
  TAG_TOKEN.lastIndex = 0;
  for (let match = TAG_TOKEN.exec(text); match !== null; match = TAG_TOKEN.exec(text)) {
    const kind = match[1] === "/" ? "close" : match[4] === "/" ? "selfClose" : "open";
    tokens.push({ name: match[2], kind, start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

// All well-formed tag pairs in the document, paired browser-style: a closing
// tag matches the nearest open tag of the same name on the stack, discarding
// unmatched opens between them.
function tagBlocks(text: string): TagBlock[] {
  const blocks: TagBlock[] = [];
  const stack: TagToken[] = [];
  for (const token of parseTagTokens(text)) {
    if (token.kind === "selfClose") continue;
    if (token.kind === "open") {
      stack.push(token);
      continue;
    }
    for (let index = stack.length - 1; index >= 0; index--) {
      if (stack[index].name === token.name) {
        blocks.push({
          openStart: stack[index].start,
          openEnd: stack[index].end,
          closeStart: token.start,
          closeEnd: token.end,
        });
        stack.length = index;
        break;
      }
    }
  }
  return blocks;
}

// The tag block enclosing [offset] (a cursor anywhere from the opening `<`
// through the closing `>` counts as inside); [count] walks outward through
// the enclosing levels (`2it`). Undefined when there are fewer than [count]
// enclosing blocks (the operator fails, like Vim).
export function enclosingTagBlock(text: string, offset: number, count: number): TagBlock | undefined {
  const enclosing = tagBlocks(text)
    .filter(block => block.openStart <= offset && offset < block.closeEnd)
    // Innermost last: sort outer-to-inner by opening position.
    .sort((a, b) => a.openStart - b.openStart);
  return enclosing[enclosing.length - Math.max(1, count)];
}

function tagRange(
  editor: VimEditorCapabilities,
  head: Position,
  { around, count }: { around: boolean; count: number }
): TextRange {
  const block = enclosingTagBlock(editor.getText(), offsetOfPosition(editor, head), count);
  if (block === undefined) return { start: head, end: head };
  return around
    ? { start: positionOfOffset(editor, block.openStart), end: positionOfOffset(editor, block.closeEnd) }
    : { start: positionOfOffset(editor, block.openEnd), end: positionOfOffset(editor, block.closeStart) };
}

/** Whether a tag block encloses the cursor. An enclosing-but-empty block
    (`cit` on `<a></a>`) still edits; no block fails the operator. */
export function tagObjectFound(editor: VimEditorCapabilities, head: Position, count: number): boolean {
  return enclosingTagBlock(editor.getText(), offsetOfPosition(editor, head), count) !== undefined;
}

function surroundRange(
  editor: VimEditorCapabilities,
  head: Position,
  object: Extract<TextObject, { type: "surround" }>,
  { around }: { around: boolean }
): TextRange {
  return surroundingMarkers(editor, head, around, object.open, object.close) ?? { start: head, end: head };
}

/** Whether a surround object has an actual pair at the cursor. An object that
    exists but is empty (`ci(` on `()`) still edits; a missing pair fails the
    operator (`ci"` with no quotes ahead stays in normal mode). */
export function surroundObjectFound(
  editor: VimEditorCapabilities,
  head: Position,
  object: Extract<TextObject, { type: "surround" }>
): boolean {
  return surroundingMarkers(editor, head, false, object.open, object.close) !== undefined;
}

/** Bracket pairs are multiline objects; quote-like pairs (identical markers)
    are line-local, matching Zed `Object::is_multiline`. */
function surroundSearchesAcrossLines(openMarker: string, closeMarker: string): boolean {
  return openMarker !== closeMarker;
}

// Zed: `object::surrounding_markers`. Finds the marker pair enclosing the
// cursor: an opening marker at/behind the cursor first, then the next opening
// marker on the line. Bracket pairs search across lines; quote pairs stay on
// the cursor line and (Vim `:h aquote`) take trailing — else leading — white
// space for `around`.
function surroundingMarkers(
  editor: VimEditorCapabilities,
  head: Position,
  around: boolean,
  openMarker: string,
  closeMarker: string
): TextRange | undefined {
  const text = editor.getText();
  const searchAcrossLines = surroundSearchesAcrossLines(openMarker, closeMarker);
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
    for (let index = point - 1; index >= 0; index--) {
      if (text[index] === "\n" && !searchAcrossLines) break;
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
  for (let index = opening + 1; index < text.length; index++) {
    if (text[index] === "\n" && !searchAcrossLines) break;
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

  if (around && !searchAcrossLines) {
    let foundTrailingWhitespace = false;
    while (end < lineEnd && /\s/.test(text[end]) && text[end] !== "\n") {
      foundTrailingWhitespace = true;
      end++;
    }
    if (!foundTrailingWhitespace) {
      while (start > lineStart && /\s/.test(text[start - 1]) && text[start - 1] !== "\n") start--;
    }
  }

  // Zed: multiline inner brackets trim the surrounding blank space when the
  // body has any non-white-space content (`vi{` selects the body lines, not
  // the newline after `{` or the closing line's indentation).
  if (!around && openMarker !== closeMarker) {
    const innerStart = opening + 1;
    const innerEnd = closing;
    const spansRows = text.slice(innerStart, innerEnd).includes("\n");
    if (spansRows && /\S/.test(text.slice(innerStart, innerEnd))) {
      let first = innerStart;
      while (first < innerEnd && /\s/.test(text[first])) first++;
      let last = innerEnd;
      while (last > first && /\s/.test(text[last - 1])) last--;
      start = first;
      end = last;
    }
  }

  return { start: positionOfOffset(editor, start), end: positionOfOffset(editor, end) };
}


type WordUnit = { start: number; end: number };

// Vim `aw` on an empty line is a whole-line operation when it cannot reach a
// word (verified against Neovim):
// - another empty line follows: the cursor's line and the next one are
//   consumed as lines (cursor ends on the following content at column zero);
// - the cursor is on the last line: the object fails (no edit);
// - content follows: not line-based — the charwise newline+word range applies
//   (see [aroundWordFromWhitespace]).
export function blankLineAroundWordRows(
  editor: VimEditorCapabilities,
  head: Position
): { startRow: number; endRow: number } | "cancelled" | undefined {
  if (editor.lineLength(head.row) !== 0) return undefined;
  if (head.row + 1 >= editor.lineCount()) return "cancelled";
  if (editor.lineLength(head.row + 1) === 0) return { startRow: head.row, endRow: head.row + 1 };
  return undefined;
}

// Zed: `object::around_next_word` — `aw` with the cursor on white space or an
// empty line followed by content. Rules verified against Neovim:
// - on an empty line followed by content, the newline, any leading white
//   space, and the following word are consumed;
// - on spaces/tabs, the range starts at the white-space run's beginning on the
//   line and runs through the following word; if the run reaches a blank line
//   instead of a word, it stops just after the current line's newline;
// - [count] repeats the forward walk from the previous range's end.
function aroundWordFromWhitespace(
  editor: VimEditorCapabilities,
  text: string,
  headOffset: number,
  bigWord: boolean,
  count: number
): TextRange {
  let start = headOffset;
  if (text[start] !== "\n") {
    while (start > 0 && isWhitespace(text[start - 1]) && text[start - 1] !== "\n") start--;
  }
  let end = headOffset;
  for (let index = 0; index < count; index++) {
    const next = aroundWordWalk(text, end, bigWord);
    if (next === end) break;
    end = next;
  }
  return { start: positionOfOffset(editor, start), end: positionOfOffset(editor, end) };
}

function aroundWordWalk(text: string, from: number, bigWord: boolean): number {
  // An empty line followed by another empty line: take the two newlines.
  if (text[from] === "\n" && text[from + 1] === "\n") return from + 2;
  let offset = from;
  while (offset < text.length && isWhitespace(text[offset])) {
    // The white-space run reaches a blank line: stop after this newline.
    if (text[offset] === "\n" && text[offset + 1] === "\n") return offset + 1;
    offset++;
  }
  if (offset >= text.length) return offset;
  const unit = wordUnitAt(text, offset, bigWord);
  return unit === undefined ? offset : unit.end;
}

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
