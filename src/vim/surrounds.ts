// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/surrounds.rs
// - translated concepts: Vim surround pair aliases, add/delete/change surrounds, and
//   spacing rules for opening vs closing bracket keys
// - intentional differences: this first slice works on model ranges and supports the
//   quote/bracket pairs covered by current fixtures. Zed handles anchors, syntax objects,
//   any-bracket matching, multicursor deduplication, and display-map details.

import { VimEditorCapabilities, rangeText } from "./editor.js";
import { enclosingTagBlock } from "./object.js";
import { TextEdit, TextRange, charwiseSelection, comparePositions, selectionHead } from "./state.js";

export type SurroundPair = {
  open: string;
  close: string;
};

export type SurroundSpec = {
  pair: SurroundPair;
  spaced: boolean;
};

const pairs: readonly SurroundPair[] = [
  { open: "(", close: ")" },
  { open: "[", close: "]" },
  { open: "{", close: "}" },
  { open: "<", close: ">" },
  { open: "\"", close: "\"" },
  { open: "'", close: "'" },
  { open: "`", close: "`" },
  { open: "|", close: "|" },
];

export function surroundSpecForKey(key: string): SurroundSpec {
  const char = keyForSurround(key);
  const aliased = surroundAlias(char);
  const pair = pairs.find(pair => pair.open === aliased || pair.close === aliased) ?? { open: aliased, close: aliased };
  return {
    pair,
    spaced: pair.open !== pair.close && aliased === pair.open,
  };
}

export function addSurrounds(
  editor: VimEditorCapabilities,
  ranges: readonly TextRange[],
  key: string,
  { linewise = false }: { linewise?: boolean } = {}
): void {
  const spec = surroundSpecForKey(key);
  const edits: TextEdit[] = [];
  const selectionsAfter = ranges.map(range => charwiseSelection(range.start));

  for (const range of ranges) {
    if (comparePositions(range.start, range.end) === 0) {
      const space = spec.spaced ? " " : "";
      edits.push({ range, text: `${spec.pair.open}${space}${space}${spec.pair.close}` });
    } else if (linewise) {
      edits.push({ range: { start: range.start, end: range.start }, text: `${spec.pair.open}\n` });
      edits.push({ range: { start: range.end, end: range.end }, text: `\n${spec.pair.close}` });
    } else {
      const space = spec.spaced ? " " : "";
      edits.push({ range: { start: range.start, end: range.start }, text: `${spec.pair.open}${space}` });
      edits.push({ range: { start: range.end, end: range.end }, text: `${space}${spec.pair.close}` });
    }
  }

  editor.applyEdits(edits, selectionsAfter);
}

// `ysiwt`/`ySt`-style add with a typed tag body instead of a pair character.
export function addTagSurrounds(
  editor: VimEditorCapabilities,
  ranges: readonly TextRange[],
  tagBody: string,
  { linewise = false }: { linewise?: boolean } = {}
): void {
  const pair = tagPairTexts(tagBody);
  const edits: TextEdit[] = [];
  const selectionsAfter = ranges.map(range => charwiseSelection(range.start));
  for (const range of ranges) {
    if (linewise && comparePositions(range.start, range.end) !== 0) {
      edits.push({ range: { start: range.start, end: range.start }, text: `${pair.open}\n` });
      edits.push({ range: { start: range.end, end: range.end }, text: `\n${pair.close}` });
    } else {
      edits.push({ range: { start: range.start, end: range.start }, text: pair.open });
      edits.push({ range: { start: range.end, end: range.end }, text: pair.close });
    }
  }
  editor.applyEdits(edits, selectionsAfter);
}

// `cs{from}t` with a typed tag body. [preserveAttributes] is vim-surround's
// `<CR>` terminator on a tag-to-tag change (`cst` + name + enter): the old
// opening tag's attributes are kept on the new tag.
export function changeSurroundsToTag(
  editor: VimEditorCapabilities,
  fromKey: string,
  tagBody: string,
  { preserveAttributes = false }: { preserveAttributes?: boolean } = {}
): void {
  const edits: TextEdit[] = [];
  const selectionsAfter = [];

  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const found = fromKey === "t" ? findTagSurround(editor, head) : findSurround(editor, head, surroundSpecForKey(fromKey).pair);
    if (found === undefined) {
      selectionsAfter.push(charwiseSelection(head));
      continue;
    }
    let pair = tagPairTexts(tagBody);
    if (preserveAttributes && fromKey === "t") {
      const oldOpenText = rangeText(editor, found.openRange);
      const oldBody = oldOpenText.slice(1, -1);
      const oldName = oldBody.trim().split(/\s/, 1)[0] ?? "";
      const oldAttributes = oldBody.slice(oldBody.indexOf(oldName) + oldName.length);
      pair = { open: `<${tagBody}${oldAttributes}>`, close: `</${tagBody.trim().split(/\s/, 1)[0]}>` };
    }
    edits.push({ range: found.openRange, text: pair.open });
    edits.push({ range: found.closeRange, text: pair.close });
    selectionsAfter.push(charwiseSelection(found.cursor));
  }

  if (edits.length > 0) editor.applyEdits(edits, selectionsAfter);
}

export function deleteSurrounds(editor: VimEditorCapabilities, key: string): void {
  const spec = surroundSpecForKey(key);
  const edits: TextEdit[] = [];
  const selectionsAfter = [];

  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const found = key === "t" ? findTagSurround(editor, head) : findSurround(editor, head, spec.pair);
    if (found === undefined) {
      selectionsAfter.push(charwiseSelection(head));
      continue;
    }
    edits.push({ range: found.openRange, text: "" });
    edits.push({ range: found.closeRange, text: "" });
    selectionsAfter.push(charwiseSelection(found.cursor));
  }

  if (edits.length > 0) editor.applyEdits(edits, selectionsAfter);
}

export function changeSurrounds(editor: VimEditorCapabilities, fromKey: string, toKey: string): void {
  const fromSpec = surroundSpecForKey(fromKey);
  const toSpec = surroundSpecForKey(toKey);
  const edits: TextEdit[] = [];
  const selectionsAfter = [];

  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const found = fromKey === "t" ? findTagSurround(editor, head) : findSurround(editor, head, fromSpec.pair);
    if (found === undefined) {
      selectionsAfter.push(charwiseSelection(head));
      continue;
    }

    const oldOpenText = rangeText(editor, found.openRange);
    const oldCloseText = rangeText(editor, found.closeRange);
    const preserveSpace = fromSpec.pair.open === fromSpec.pair.close || !toSpec.spaced;
    const openSpace = preserveSpace && oldOpenText.endsWith(" ") ? " " : toSpec.spaced ? " " : "";
    const closeSpace = preserveSpace && oldCloseText.startsWith(" ") ? " " : toSpec.spaced ? " " : "";

    edits.push({ range: found.openRange, text: `${toSpec.pair.open}${openSpace}` });
    edits.push({ range: found.closeRange, text: `${closeSpace}${toSpec.pair.close}` });
    selectionsAfter.push(charwiseSelection(found.cursor));
  }

  if (edits.length > 0) editor.applyEdits(edits, selectionsAfter);
}

type FoundSurround = {
  openRange: TextRange;
  closeRange: TextRange;
  cursor: TextRange["start"];
};

function findSurround(editor: VimEditorCapabilities, head: TextRange["start"], pair: SurroundPair): FoundSurround | undefined {
  if (pair.open === pair.close) return findSymmetricSurround(editor, head, pair.open);
  return findAsymmetricSurround(editor, head, pair);
}

// vim-surround `t` target: the enclosing tag block's full open/close tokens.
function findTagSurround(editor: VimEditorCapabilities, head: TextRange["start"]): FoundSurround | undefined {
  const text = editor.getText();
  const offset = offsetOfPosition(editor, head);
  const block = enclosingTagBlock(text, offset, 1);
  if (block === undefined) return undefined;
  return {
    openRange: { start: positionOfOffset(editor, block.openStart), end: positionOfOffset(editor, block.openEnd) },
    closeRange: { start: positionOfOffset(editor, block.closeStart), end: positionOfOffset(editor, block.closeEnd) },
    cursor: positionOfOffset(editor, block.openStart),
  };
}

// A typed tag body (the text between `<` and the terminating `>`/enter):
// `div class="x"` opens `<div class="x">` and closes `</div>` (attributes only
// on the opening tag, closing by first word, like vim-surround).
export function tagPairTexts(tagBody: string): SurroundPair {
  const name = tagBody.trim().split(/\s/, 1)[0] ?? "";
  return { open: `<${tagBody}>`, close: `</${name}>` };
}

function findSymmetricSurround(editor: VimEditorCapabilities, head: TextRange["start"], char: string): FoundSurround | undefined {
  const line = editor.line(head.row);
  const left = findUnescapedBackward(line, char, Math.min(head.column, line.length - 1));
  if (left === undefined) return undefined;
  const right = findUnescapedForward(line, char, Math.max(head.column, left + 1));
  if (right === undefined) return undefined;
  return {
    openRange: { start: { row: head.row, column: left }, end: { row: head.row, column: left + 1 } },
    closeRange: { start: { row: head.row, column: right }, end: { row: head.row, column: right + 1 } },
    cursor: { row: head.row, column: left },
  };
}

function findAsymmetricSurround(editor: VimEditorCapabilities, head: TextRange["start"], pair: SurroundPair): FoundSurround | undefined {
  const text = editor.getText();
  const offset = offsetOfPosition(editor, head);
  const open = findMatchingOpen(text, offset, pair);
  if (open === undefined) return undefined;
  const close = findMatchingClose(text, open + 1, pair);
  if (close === undefined || close < offset) return undefined;

  const openRange = rangeAroundOpening(text, editor, open, pair.open.length);
  const closeRange = rangeAroundClosing(text, editor, close, pair.close.length);
  return { openRange, closeRange, cursor: positionOfOffset(editor, openRange.startOffset) };
}

function rangeAroundOpening(text: string, editor: VimEditorCapabilities, offset: number, length: number): TextRange & { startOffset: number } {
  let end = offset + length;
  if (text[end] === " ") end++;
  const range = { start: positionOfOffset(editor, offset), end: positionOfOffset(editor, end) };
  return { ...range, startOffset: offset };
}

function rangeAroundClosing(text: string, editor: VimEditorCapabilities, offset: number, length: number): TextRange {
  let start = offset;
  if (start > 0 && text[start - 1] === " ") start--;
  return { start: positionOfOffset(editor, start), end: positionOfOffset(editor, offset + length) };
}

function findMatchingOpen(text: string, offset: number, pair: SurroundPair): number | undefined {
  let depth = 0;
  for (let index = Math.min(offset, text.length - 1); index >= 0; index--) {
    if (text[index] === pair.close) depth++;
    if (text[index] === pair.open) {
      if (depth === 0) return index;
      depth--;
    }
  }
  return undefined;
}

function findMatchingClose(text: string, offset: number, pair: SurroundPair): number | undefined {
  let depth = 0;
  for (let index = offset; index < text.length; index++) {
    if (text[index] === pair.open) depth++;
    if (text[index] === pair.close) {
      if (depth === 0) return index;
      depth--;
    }
  }
  return undefined;
}

function findUnescapedBackward(line: string, char: string, start: number): number | undefined {
  for (let index = Math.min(start, line.length - 1); index >= 0; index--) {
    if (line[index] === char && !isEscaped(line, index)) return index;
  }
  return undefined;
}

function findUnescapedForward(line: string, char: string, start: number): number | undefined {
  for (let index = start; index < line.length; index++) {
    if (line[index] === char && !isEscaped(line, index)) return index;
  }
  return undefined;
}

function isEscaped(line: string, index: number): boolean {
  let backslashes = 0;
  for (let current = index - 1; current >= 0 && line[current] === "\\"; current--) backslashes++;
  return backslashes % 2 === 1;
}

function keyForSurround(key: string): string {
  switch (key) {
    case "space":
      return " ";
    default:
      return key;
  }
}

function surroundAlias(char: string): string {
  switch (char) {
    case "b":
      return ")";
    case "B":
      return "}";
    case "r":
      return "]";
    case "a":
      return ">";
    default:
      return char;
  }
}

function offsetOfPosition(editor: VimEditorCapabilities, position: TextRange["start"]): number {
  let offset = 0;
  for (let row = 0; row < position.row; row++) offset += editor.lineLength(row) + 1;
  return offset + position.column;
}

function positionOfOffset(editor: VimEditorCapabilities, offset: number): TextRange["start"] {
  let remaining = offset;
  for (let row = 0; row < editor.lineCount(); row++) {
    const lineLength = editor.lineLength(row);
    if (remaining <= lineLength) return { row, column: remaining };
    remaining -= lineLength + 1;
  }
  const row = editor.lineCount() - 1;
  return { row, column: editor.lineLength(row) };
}
