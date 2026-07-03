// Zed reference:
// - source: no direct Zed counterpart (Zed's `gq` rewraps via its
//   language-aware soft-wrap machinery); this is a local model-buffer
//   implementation of Vim's `gq`/`gw` format operators pinned against recorded
//   Neovim behavior (test_format_operator fixtures).
// - semantics covered: greedy reflow to 'textwidth', paragraph chunks split on
//   blank lines and comment-leader changes, leader/indent repetition on
//   continuation lines, preserved intra-line whitespace runs, tab-aware width,
//   `gq` cursor on the first non-blank of the last formatted line, `gw` keeping
//   the cursor.

import { VimEditorCapabilities } from "../editor.js";
import { firstNonWhitespaceColumn } from "../motion.js";
import type { ResolvedTarget } from "../operator_target.js";
import { TextEdit, charwiseSelection } from "../state.js";
import { selectionHead } from "../state.js";

export type FormatOptions = {
  // 'textwidth'; 0 or negative falls back to 79 (Vim formats to the screen
  // width capped at 79 when 'textwidth' is 0).
  textwidth: number;
  // `gw`: keep the cursor where it was instead of moving to the last
  // formatted line.
  keepCursor: boolean;
};

const FALLBACK_TEXTWIDTH = 79;

// One application for every format target source (motion, line, object,
// visual), like [applyIndent].
export function applyFormat(
  editor: VimEditorCapabilities,
  target: ResolvedTarget,
  { textwidth, keepCursor }: FormatOptions
): void {
  const width = textwidth > 0 ? textwidth : FALLBACK_TEXTWIDTH;
  const spans = formatRowSpans(editor, target);
  if (spans.length === 0) return;

  const savedHeads = editor.getSelections().map(selectionHead);
  const edits: TextEdit[] = [];
  const cursors: { row: number; column: number }[] = [];
  // Rows inserted/removed by the spans formatted so far; spans are disjoint
  // and sorted, so this is the row shift for everything below them.
  let delta = 0;
  const spanShifts: { startRow: number; endRow: number; original: readonly string[]; replacement: readonly string[]; delta: number }[] = [];
  for (const span of spans) {
    const original: string[] = [];
    for (let row = span.startRow; row <= span.endRow; row++) original.push(editor.line(row));
    const replacement = reflowLines(original, width);
    edits.push({
      range: {
        start: { row: span.startRow, column: 0 },
        end: { row: span.endRow, column: editor.lineLength(span.endRow) },
      },
      text: replacement.join("\n"),
    });
    // Vim: the cursor lands on the first non-blank of the last formatted line.
    const lastLine = replacement[replacement.length - 1];
    cursors.push({
      row: span.startRow + delta + replacement.length - 1,
      column: firstNonWhitespaceColumn(lastLine),
    });
    spanShifts.push({ ...span, original, replacement, delta: replacement.length - original.length });
    delta += replacement.length - original.length;
  }

  const selectionsAfter = keepCursor
    ? savedHeads.map(head => charwiseSelection(restoredHead(head, spanShifts, width)))
    : cursors.map(cursor => charwiseSelection(cursor));
  editor.applyEdits(edits, selectionsAfter);
}

// `gw`: keep the cursor "at the same position in the text" — a head inside a
// formatted span follows the character it was on through the reflow; a head
// outside the spans only shifts by the row delta of the spans above it.
function restoredHead(
  head: { row: number; column: number },
  spanShifts: readonly { startRow: number; endRow: number; original: readonly string[]; replacement: readonly string[]; delta: number }[],
  textwidth: number
): { row: number; column: number } {
  let rowShift = 0;
  for (const span of spanShifts) {
    if (span.endRow < head.row) {
      rowShift += span.delta;
      continue;
    }
    if (span.startRow <= head.row) {
      const relative = { row: head.row - span.startRow, column: head.column };
      const mapped = reflowLinesWithCursor(span.original, textwidth, relative).cursor;
      if (mapped === undefined) {
        // No word to follow (e.g. the head sat on a line the reflow dropped):
        // clamp the coordinates into the replacement.
        const rowWithin = Math.min(relative.row, span.replacement.length - 1);
        const line = span.replacement[rowWithin];
        return {
          row: span.startRow + rowShift + rowWithin,
          column: Math.min(head.column, Math.max(0, line.length - 1)),
        };
      }
      return { row: span.startRow + rowShift + mapped.row, column: mapped.column };
    }
    break;
  }
  return { row: head.row + rowShift, column: head.column };
}

type RowSpan = { startRow: number; endRow: number };

// Row spans covered by a resolved target: sorted, clamped, overlaps merged
// (multi-cursor targets on adjacent rows format once).
function formatRowSpans(editor: VimEditorCapabilities, target: ResolvedTarget): RowSpan[] {
  const lastRow = editor.lineCount() - 1;
  const raw: RowSpan[] = [];
  switch (target.kind) {
    case "charwise":
      for (const { range, cancelled } of target.targets) {
        if (cancelled === true) continue;
        // An exclusive range ending in column zero does not include that row.
        const endRow = range.end.column === 0 && range.end.row > range.start.row ? range.end.row - 1 : range.end.row;
        raw.push({
          startRow: Math.max(0, Math.min(range.start.row, lastRow)),
          endRow: Math.max(0, Math.min(endRow, lastRow)),
        });
      }
      break;
    case "linewise":
      for (const { startRow, endRow } of target.rows) {
        raw.push({
          startRow: Math.max(0, Math.min(Math.min(startRow, endRow), lastRow)),
          endRow: Math.max(0, Math.min(Math.max(startRow, endRow), lastRow)),
        });
      }
      break;
  }
  raw.sort((a, b) => a.startRow - b.startRow || a.endRow - b.endRow);
  const merged: RowSpan[] = [];
  for (const span of raw) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && span.startRow <= previous.endRow + 1) {
      previous.endRow = Math.max(previous.endRow, span.endRow);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Reflow
// ---------------------------------------------------------------------------

// Single-line comment leaders recognized for formatting, mirroring the parts
// of Neovim's no-filetype 'comments' default this implementation supports
// (`://`, `b:#`, `:%`, `n:>`). [blankRequired] is the 'b' flag: the leader only
// counts when followed by whitespace or end-of-line. Three-piece (`/* */`) and
// first-line-only (`fb:-`) leaders are not handled.
const COMMENT_LEADERS: readonly { token: string; blankRequired: boolean }[] = [
  { token: "//", blankRequired: false },
  { token: "#", blankRequired: true },
  { token: "%", blankRequired: false },
  { token: ">", blankRequired: false },
];

type ParsedLine = {
  // Indent + leader + the whitespace following it; repeated on every
  // continuation line of the chunk (taken from the chunk's first line).
  prefix: string;
  // The leader token (`//`, `#`, ...) or undefined for plain text; a change of
  // leader starts a new paragraph chunk.
  leader: string | undefined;
  // The line's content after [prefix].
  text: string;
};

function parseLine(line: string): ParsedLine {
  const indent = /^[ \t]*/.exec(line)![0];
  const rest = line.slice(indent.length);
  for (const { token, blankRequired } of COMMENT_LEADERS) {
    if (!rest.startsWith(token)) continue;
    const after = rest.slice(token.length);
    if (blankRequired && after.length > 0 && !/^[ \t]/.test(after)) continue;
    const gap = /^[ \t]*/.exec(after)![0];
    return { prefix: indent + token + gap, leader: token, text: after.slice(gap.length) };
  }
  return { prefix: indent, leader: undefined, text: rest };
}

// A word plus the whitespace run that preceded it. Gaps inside an original
// line are preserved verbatim (Neovim keeps `aaa  bbb` double-spaced);
// line joins contribute a single space ('joinspaces' off). [sourceRow] and
// [sourceStart] locate the word in the input, for cursor tracking (`gw`).
type Token = { gap: string; word: string; sourceRow: number; sourceStart: number };

type Chunk = {
  prefix: string;
  tokens: Token[];
  // Original lines, kept for the no-token edge (leader-only lines) so they
  // round-trip unchanged.
  original: string[];
  firstSourceRow: number;
};

// Reflow [lines] to [textwidth]. Blank lines separate paragraphs and are
// preserved verbatim; a change of comment leader also starts a new paragraph
// (a comment does not join with the plain-text line after it).
export function reflowLines(lines: readonly string[], textwidth: number): string[] {
  return reflowLinesWithCursor(lines, textwidth, undefined).lines;
}

// Like [reflowLines], additionally mapping [cursor] (a position in the input
// lines) through the reflow: the cursor stays on the character it was on
// (Neovim `gw` keeps the cursor "at the same position in the text", so a word
// that moves takes the cursor with it). Returns an undefined cursor when no
// input cursor was given.
export function reflowLinesWithCursor(
  lines: readonly string[],
  textwidth: number,
  cursor: { row: number; column: number } | undefined
): { lines: string[]; cursor: { row: number; column: number } | undefined } {
  const out: string[] = [];
  let outCursor: { row: number; column: number } | undefined;
  let chunk: Chunk | undefined;
  let chunkLeader: string | undefined;

  const flush = () => {
    if (chunk === undefined) return;
    const filled = fillChunk(chunk, textwidth, cursor);
    if (filled.cursor !== undefined) {
      outCursor = { row: out.length + filled.cursor.row, column: filled.cursor.column };
    }
    out.push(...filled.lines);
    chunk = undefined;
  };

  for (const [row, line] of lines.entries()) {
    if (/^[ \t]*$/.test(line)) {
      flush();
      if (cursor?.row === row) {
        outCursor = { row: out.length, column: Math.min(cursor.column, Math.max(0, line.length - 1)) };
      }
      out.push(line);
      continue;
    }
    const parsed = parseLine(line);
    if (chunk !== undefined && parsed.leader !== chunkLeader) flush();
    if (chunk === undefined) {
      chunk = { prefix: parsed.prefix, tokens: [], original: [], firstSourceRow: row };
      chunkLeader = parsed.leader;
    }
    chunk.original.push(line);
    const textStart = line.length - parsed.text.length;
    let firstOnLine = true;
    const matcher = /([ \t]*)([^ \t]+)/g;
    for (let match = matcher.exec(parsed.text); match !== null; match = matcher.exec(parsed.text)) {
      const gap = firstOnLine ? (chunk.tokens.length === 0 ? "" : " ") : match[1];
      chunk.tokens.push({
        gap,
        word: match[2],
        sourceRow: row,
        sourceStart: textStart + match.index + match[1].length,
      });
      firstOnLine = false;
    }
  }
  flush();
  return { lines: out, cursor: outCursor };
}

// The token the cursor sits on (or the nearest token on its row), plus the
// offset within its word, clamped onto a character of the word.
function cursorToken(
  tokens: readonly Token[],
  cursor: { row: number; column: number }
): { index: number; offset: number } | undefined {
  let candidate: { index: number; offset: number } | undefined;
  for (const [index, token] of tokens.entries()) {
    if (token.sourceRow !== cursor.row) continue;
    if (cursor.column < token.sourceStart) {
      // Before the row's first word (on the indent/leader): snap to that word.
      return candidate ?? { index, offset: 0 };
    }
    candidate = {
      index,
      offset: Math.min(cursor.column - token.sourceStart, token.word.length - 1),
    };
    if (cursor.column < token.sourceStart + token.word.length) return candidate;
  }
  return candidate;
}

// Greedy fill: append each word (with its preserved gap) while the line stays
// within [textwidth]; break before a word that would cross it. A word that is
// alone on a line may exceed the width (Vim does not split words).
function fillChunk(
  chunk: Chunk,
  textwidth: number,
  cursor: { row: number; column: number } | undefined
): { lines: string[]; cursor: { row: number; column: number } | undefined } {
  if (chunk.tokens.length === 0) {
    // Leader-only lines round-trip verbatim; the cursor keeps its coordinates
    // within them.
    const rowWithin = cursor === undefined ? undefined : cursor.row - chunk.firstSourceRow;
    const inChunk = rowWithin !== undefined && rowWithin >= 0 && rowWithin < chunk.original.length;
    return {
      lines: chunk.original,
      cursor: inChunk ? { row: rowWithin, column: cursor!.column } : undefined,
    };
  }
  const target = cursor === undefined ? undefined : cursorToken(chunk.tokens, cursor);
  let outCursor: { row: number; column: number } | undefined;
  const out: string[] = [];
  let current: string | undefined;
  const placeCursor = (index: number, wordStart: number) => {
    if (target?.index === index) outCursor = { row: out.length, column: wordStart + target.offset };
  };
  for (const [index, token] of chunk.tokens.entries()) {
    if (current === undefined) {
      placeCursor(index, chunk.prefix.length);
      current = chunk.prefix + token.word;
      continue;
    }
    const candidate = current + token.gap + token.word;
    if (displayWidth(candidate) > textwidth) {
      out.push(current);
      placeCursor(index, chunk.prefix.length);
      current = chunk.prefix + token.word;
    } else {
      placeCursor(index, current.length + token.gap.length);
      current = candidate;
    }
  }
  if (current !== undefined) out.push(current);
  return { lines: out, cursor: outCursor };
}

// Display width with tab stops every 8 columns, like the width Vim's
// formatting compares against 'textwidth'.
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width = char === "\t" ? (Math.floor(width / 8) + 1) * 8 : width + 1;
  }
  return width;
}
