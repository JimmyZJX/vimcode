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

export function searchOptionsForQuery(query: string, options: SearchOptions = {}): SearchOptions {
  return {
    ...options,
    regex: options.regex ?? true,
    caseSensitive: options.caseSensitive ?? hasUppercase(query),
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
    return new RegExp(query, `g${options.caseSensitive === false ? "i" : ""}m`);
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
