// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/normal/search.rs and search::BufferSearchBar
// - translated concepts: search options and adapter-independent model-buffer matching
// - intentional differences: production search is delegated to VSCode's native find
//   controller; this module provides the small synchronous search model used by tests.

import { Position, TextRange } from "./state.js";

export type SearchDirection = "forward" | "backward";
export type SearchOptions = {
  caseSensitive?: boolean;
  includeStart?: boolean;
  regex?: boolean;
  reveal?: boolean;
  wholeWord?: boolean;
};
export type SearchMatch = TextRange;

// Vim `search-offset`: an offset typed after the closing separator of a search
// (`/pat/e`, `?pat?s-1`) moves the cursor relative to the match rather than to
// its start. `end` targets the last character of the match, `start` (Vim `s` or
// `b`) its first, each shifted by an optional `+N`/`-N` character delta. Line
// offsets (`/pat/2`) are not yet supported.
export type SearchOffset =
  | { type: "end"; delta: number }
  | { type: "start"; delta: number };

const searchOffsetPattern = /^([esb])([+-]\d+)?$/;

// Parse the offset token that follows a search separator (the part after the
// `/` in `/pat/e+2`). Returns undefined when the text is not a recognized
// character offset, so callers can treat an unrecognized trailing segment as
// part of the pattern instead (e.g. a literal `a/b` search).
export function parseSearchOffset(text: string): SearchOffset | undefined {
  const match = searchOffsetPattern.exec(text);
  if (match === null) return undefined;
  const delta = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  return match[1] === "e" ? { type: "end", delta } : { type: "start", delta };
}

// Minimal Vim-pattern conveniences layered over JS regex syntax (the pattern
// language is otherwise JavaScript's, like VSCodeVim): `\<` and `\>` become
// word boundaries (`\b`), and `\c`/`\C` anywhere in the pattern force
// case-insensitive/-sensitive matching, overriding the smartcase heuristic
// (`:h /\c`). Other escapes pass through untouched.
export function translateVimRegex(pattern: string): { source: string; forceCase: "ignore" | "match" | undefined } {
  let source = "";
  let forceCase: "ignore" | "match" | undefined;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char !== "\\") {
      source += char;
      continue;
    }
    const next = pattern[index + 1];
    index++;
    if (next === undefined) {
      source += "\\";
    } else if (next === "<" || next === ">") {
      source += "\\b";
    } else if (next === "c") {
      forceCase = "ignore";
    } else if (next === "C") {
      forceCase = "match";
    } else {
      source += `\\${next}`;
    }
  }
  return { source, forceCase };
}

export function searchOptionsForQuery(query: string, options: SearchOptions = {}): SearchOptions {
  const forceCase = options.regex === false ? undefined : translateVimRegex(query).forceCase;
  return {
    ...options,
    regex: options.regex ?? true,
    caseSensitive:
      forceCase !== undefined ? forceCase === "match" : options.caseSensitive ?? hasUppercase(query),
  };
}

export function findSearchMatchInText(
  text: string,
  query: string,
  startOffset: number,
  direction: SearchDirection,
  options: SearchOptions
): { range: SearchMatch; offset: number } | undefined {
  if (query.length === 0) return undefined;
  if (options.regex === true) {
    return findRegexSearchMatchInText(text, query, startOffset, direction, options);
  }
  return findLiteralSearchMatchInText(text, query, startOffset, direction, options);
}

function findLiteralSearchMatchInText(
  text: string,
  query: string,
  startOffset: number,
  direction: SearchDirection,
  options: SearchOptions
): { range: SearchMatch; offset: number } | undefined {
  const searchText = options.caseSensitive === false ? text.toLocaleLowerCase() : text;
  const searchQuery = options.caseSensitive === false ? query.toLocaleLowerCase() : query;
  const matches: { range: SearchMatch; offset: number; length: number }[] = [];
  let offset = searchText.indexOf(searchQuery, 0);
  while (offset >= 0) {
    if (options.wholeWord !== true || isWholeWordMatch(text, offset, query.length)) {
      matches.push({ ...searchMatchAtOffset(text, offset, query.length), length: query.length });
    }
    offset = searchText.indexOf(searchQuery, offset + Math.max(1, searchQuery.length));
  }
  return findMatchFromMatches(matches, startOffset, direction, options);
}

function findRegexSearchMatchInText(
  text: string,
  query: string,
  startOffset: number,
  direction: SearchDirection,
  options: SearchOptions
): { range: SearchMatch; offset: number } | undefined {
  const regex = regexForQuery(query, options);
  if (regex === undefined) return undefined;
  const matches = regexMatches(text, regex)
    .filter(match => options.wholeWord !== true || isWholeWordMatch(text, match.offset, match.length));
  return findMatchFromMatches(matches, startOffset, direction, options);
}

function findMatchFromMatches(
  matches: { range: SearchMatch; offset: number; length: number }[],
  startOffset: number,
  direction: SearchDirection,
  options: SearchOptions
): { range: SearchMatch; offset: number } | undefined {
  if (matches.length === 0) return undefined;
  if (options.includeStart === true) {
    const containing = matches.find(match => match.offset <= startOffset && startOffset < match.offset + Math.max(1, match.length));
    if (containing !== undefined) return containing;
  }
  const start = startOffset + (options.includeStart === true ? 0 : direction === "forward" ? 1 : -1);
  if (direction === "forward") {
    return matches.find(match => match.offset >= start) ?? matches[0];
  }
  return [...matches].reverse().find(match => match.offset <= start) ?? matches[matches.length - 1];
}

function regexForQuery(query: string, options: SearchOptions): RegExp | undefined {
  try {
    return new RegExp(translateVimRegex(query).source, `g${options.caseSensitive === false ? "i" : ""}m`);
  } catch (_error) {
    return undefined;
  }
}

function regexMatches(text: string, regex: RegExp): { range: SearchMatch; offset: number; length: number }[] {
  const matches: { range: SearchMatch; offset: number; length: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const length = match[0].length;
    matches.push({ ...searchMatchAtOffset(text, match.index, length), length });
    if (length === 0) regex.lastIndex++;
  }
  return matches;
}

function searchMatchAtOffset(text: string, offset: number, length: number): { range: SearchMatch; offset: number } {
  return {
    offset,
    range: {
      start: positionOfOffsetInText(text, offset),
      end: positionOfOffsetInText(text, offset + length),
    },
  };
}

function isWholeWordMatch(text: string, offset: number, length: number): boolean {
  return !isWordChar(text[offset - 1]) && !isWordChar(text[offset + length]);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /\w/.test(char);
}

function positionOfOffsetInText(text: string, offset: number): Position {
  let row = 0;
  let column = 0;
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text[index] === "\n") {
      row++;
      column = 0;
    } else {
      column++;
    }
  }
  return { row, column };
}

function hasUppercase(query: string): boolean {
  return /[A-Z]/.test(query);
}
