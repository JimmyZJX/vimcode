// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/increment.rs
// - translated concepts: increment/decrement of decimal, hex, binary, and boolean
//   targets under the cursor or inside visual selections, including wrapping and
//   visual step mode (`g<C-a>` / `g<C-x>`).

import { VimEditorCapabilities } from "../editor.js";
import { TextEdit, TextRange, VimSelection, charwiseSelection, comparePositions, rangeOfSelection, selectionHead } from "../state.js";

const U64_MAX = (1n << 64n) - 1n;
const U64_MOD = 1n << 64n;
const BOOLEAN_PAIRS: readonly [string, string][] = [["true", "false"], ["yes", "no"], ["on", "off"]];

export function incrementNumbers(editor: VimEditorCapabilities, delta: number, step = 0): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  let currentDelta = delta;

  for (const selection of editor.getSelections()) {
    const selectionRange = rangeOfSelection(selection);
    const selectionIsEmpty = rangeIsEmpty(selectionRange);
    if (!selectionIsEmpty && selectionsAfter.length === 0) {
      selectionsAfter.push(charwiseSelection(selectionRange.start));
    }

    for (let row = selectionRange.start.row; row <= selectionRange.end.row; row++) {
      const startColumn = row === selectionRange.start.row ? selectionRange.start.column : 0;
      const endColumn = row === selectionRange.end.row ? selectionRange.end.column : editor.lineLength(row);
      const target = findTarget(editor.line(row), startColumn, endColumn, { needRange: !selectionIsEmpty });
      if (target === undefined) continue;

      const replacement = incrementTarget(target, currentDelta);
      currentDelta += step;
      edits.push({
        range: { start: { row, column: target.start }, end: { row, column: target.end } },
        text: replacement,
      });
      if (selectionIsEmpty) {
        selectionsAfter.push(charwiseSelection({ row, column: target.start + Math.max(0, replacement.length - 1) }));
      }
    }

    if (selectionIsEmpty && selectionsAfter.length === 0) {
      selectionsAfter.push(charwiseSelection(selectionHead(selection)));
    }
  }

  if (edits.length === 0) {
    if (selectionsAfter.length > 0) editor.setSelections(selectionsAfter);
  } else {
    editor.applyEdits(edits, selectionsAfter.length === 0 ? editor.getSelections() : selectionsAfter);
  }
}

type Target = {
  start: number;
  end: number;
  text: string;
  radix: 10 | 16 | 2 | 0;
};

function incrementTarget(target: Target, delta: number): string {
  switch (target.radix) {
    case 10:
      return incrementDecimalString(target.text, delta);
    case 16:
      return incrementHexString(target.text, delta);
    case 2:
      return incrementBinaryString(target.text, delta);
    case 0:
      return incrementToggleString(target.text);
  }
}

function incrementDecimalString(num: string, deltaNumber: number): string {
  const stripped = num.startsWith("-") ? num.slice(1) : num;
  const negative = num.startsWith("-");
  const delta = BigInt(negative ? -deltaNumber : deltaNumber);
  const numLength = stripped.length;
  const leadingZero = stripped.startsWith("0");
  const parsed = parseU64(stripped, 10);

  let result: bigint;
  let newNegative: boolean;
  if (parsed === undefined) {
    result = U64_MAX;
    newNegative = negative;
  } else {
    const wrapped = wrappingAddSigned(parsed, delta);
    if (delta < 0n && wrapped > parsed) {
      result = (U64_MAX - wrapped + 1n) & U64_MAX;
      newNegative = !negative;
    } else if (delta > 0n && wrapped < parsed) {
      result = U64_MAX - wrapped;
      newNegative = !negative;
    } else {
      result = wrapped;
      newNegative = negative;
    }
  }

  const formatted = result.toString(10);
  const padding = leadingZero ? Math.max(0, numLength - formatted.length) : 0;
  const digits = `${"0".repeat(padding)}${formatted}`;
  return newNegative && result !== 0n ? `-${digits}` : digits;
}

function incrementHexString(num: string, delta: number): string {
  const parsed = parseU64(num, 16);
  const result = parsed === undefined ? U64_MAX : wrappingAddSigned(parsed, BigInt(delta));
  const formatted = result.toString(16).padStart(num.length, "0");
  return shouldUseLowercase(num) ? formatted : formatted.toUpperCase();
}

function incrementBinaryString(num: string, delta: number): string {
  const parsed = parseU64(num, 2);
  const result = parsed === undefined ? U64_MAX : wrappingAddSigned(parsed, BigInt(delta));
  return result.toString(2).padStart(num.length, "0");
}

function incrementToggleString(word: string): string {
  const lower = word.toLowerCase();
  const target = BOOLEAN_PAIRS.find(([a, b]) => lower === a || lower === b);
  if (target === undefined) return word;
  const [a, b] = target;
  const replacement = lower === a ? b : a;
  if ([...word].every(char => char === char.toUpperCase())) return replacement.toUpperCase();
  if (word[0] === word[0]?.toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

function parseU64(text: string, radix: number): bigint | undefined {
  try {
    const value = BigInt(radix === 10 ? text : `0${radix === 16 ? "x" : "b"}${text}`);
    return value <= U64_MAX ? value : undefined;
  } catch (_error) {
    return undefined;
  }
}

function wrappingAddSigned(value: bigint, delta: bigint): bigint {
  return ((value + delta) % U64_MOD + U64_MOD) % U64_MOD;
}

function shouldUseLowercase(num: string): boolean {
  let useUppercase = false;
  for (const char of num) {
    if (/[a-z]/.test(char)) return true;
    if (/[A-Z]/.test(char)) useUppercase = true;
  }
  return !useUppercase;
}

function findTarget(line: string, startColumn: number, endColumn: number, { needRange }: { needRange: boolean }): Target | undefined {
  const start = Math.max(0, Math.min(startColumn, line.length));
  const end = Math.max(start, Math.min(endColumn, line.length));
  const searchStart = scanStart(line, start, { needRange });
  let best: Target | undefined;

  for (const target of targetsInLine(line, searchStart)) {
    if (needRange && target.start >= end) break;
    if (target.end <= start) continue;
    if (needRange && target.start < end && target.end > start) return clipTarget(target, start, end);
    if (!needRange && target.end > start) {
      best = target;
      break;
    }
  }

  return best;
}

function clipTarget(target: Target, start: number, end: number): Target {
  if (target.radix !== 10 || target.start >= start && target.end <= end) return target;
  const clippedStart = Math.max(target.start, start);
  const clippedEnd = Math.min(target.end, end);
  const text = target.text.slice(clippedStart - target.start, clippedEnd - target.start);
  return text.length === 0 ? target : { ...target, start: clippedStart, end: clippedEnd, text };
}

function scanStart(line: string, start: number, { needRange }: { needRange: boolean }): number {
  if (needRange) return start;
  let index = Math.min(start, line.length);
  while (index > 0 && !/\s/.test(line[index - 1])) index--;
  return index;
}

function targetsInLine(line: string, start: number): Target[] {
  const targets: Target[] = [];
  let index = start;
  while (index < line.length) {
    const target = targetAt(line, index);
    if (target !== undefined) {
      targets.push(target);
      index = Math.max(index + 1, target.end);
    } else {
      index++;
    }
  }
  return targets;
}

function targetAt(line: string, index: number): Target | undefined {
  const rest = line.slice(index);
  const prefixed = /^-?0([xX])([0-9a-fA-F]+)/.exec(rest);
  if (prefixed !== null) {
    const prefixLength = prefixed[0].length - prefixed[2].length;
    return { start: index + prefixLength, end: index + prefixed[0].length, text: prefixed[2], radix: 16 };
  }

  const binary = /^-?0([bB])([01]+)/.exec(rest);
  if (binary !== null) {
    const prefixLength = binary[0].length - binary[2].length;
    return { start: index + prefixLength, end: index + binary[0].length, text: binary[2], radix: 2 };
  }

  const decimal = /^-?\d+/.exec(rest);
  if (decimal !== null) {
    return { start: index, end: index + decimal[0].length, text: decimal[0], radix: 10 };
  }

  const word = /^[A-Za-z]+/.exec(rest);
  if (word !== null && isToggleWord(word[0])) {
    return { start: index, end: index + word[0].length, text: word[0], radix: 0 };
  }

  return undefined;
}

function isToggleWord(word: string): boolean {
  const lower = word.toLowerCase();
  return BOOLEAN_PAIRS.some(([a, b]) => lower === a || lower === b);
}

function rangeIsEmpty(range: TextRange): boolean {
  return comparePositions(range.start, range.end) === 0;
}
