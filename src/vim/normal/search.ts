// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/search.rs
// - translated concepts: pending `/` / `?` query state, repeated search motions,
//   and native search UI synchronization
// - intentional differences: VSCode owns the concrete find UI/model while the core keeps
//   Vim-specific direction and repeat metadata.

import { VimEditorCapabilities } from "../editor.js";
import { SearchOptions, searchOptionsForQuery } from "../search.js";
import { Motion } from "../motion.js";
import { Registers } from "../registers.js";
import { TextRange, selectionHead } from "../state.js";

export type PendingSearch = { backwards: boolean; query: string };

export class SearchState {
  private pending: PendingSearch | undefined;
  private last: { query: string; backwards: boolean; options: SearchOptions } | undefined;

  isPending(): boolean {
    return this.pending !== undefined;
  }

  pendingChord(): string {
    return this.pending === undefined ? "" : `${this.pending.backwards ? "?" : "/"}${this.pending.query}`;
  }

  start(backwards: boolean, editor: VimEditorCapabilities): void {
    this.pending = { backwards, query: "" };
    this.updatePendingSearchUi(editor);
  }

  clearPending(): void {
    this.pending = undefined;
  }

  handleKey(key: string, registers: Registers, editor: VimEditorCapabilities): Motion | undefined {
    const pending = this.pending;
    if (pending === undefined) return undefined;
    if (key === "enter") {
      const query = pending.query.length > 0 ? pending.query : this.last?.query;
      const backwards = pending.query.length > 0 ? pending.backwards : this.last?.backwards ?? pending.backwards;
      const options = pending.query.length > 0 ? searchOptionsForQuery(query ?? "") : this.last?.options ?? searchOptionsForQuery(query ?? "");
      this.pending = undefined;
      if (query !== undefined && query.length > 0) {
        return this.setLast(query, backwards, registers, editor, options);
      }
      return undefined;
    }
    if (key === "backspace") {
      this.pending = { ...pending, query: pending.query.slice(0, -1) };
    } else {
      this.pending = { ...pending, query: pending.query + (key === "space" ? " " : key) };
    }
    this.updatePendingSearchUi(editor);
    return undefined;
  }

  private updatePendingSearchUi(editor: VimEditorCapabilities): void {
    if (this.pending === undefined) return;
    const query = this.pending.query.length === 0 ? this.last?.query ?? "" : this.pending.query;
    const options = this.pending.query.length === 0 ? this.last?.options ?? searchOptionsForQuery(query) : searchOptionsForQuery(query);
    editor.updateSearch(query, this.pending.backwards ? "backward" : "forward", { ...options, reveal: true });
  }

  setLast(
    query: string,
    backwards: boolean,
    registers: Registers,
    editor: VimEditorCapabilities,
    options: SearchOptions = searchOptionsForQuery(query)
  ): Motion {
    const normalizedOptions = searchOptionsForQuery(query, options);
    this.last = { query, backwards, options: normalizedOptions };
    registers.writeSearch(query);
    editor.updateSearch(query, backwards ? "backward" : "forward", { ...normalizedOptions, reveal: true });
    return { type: backwards ? "searchBackward" : "searchForward", query, options: normalizedOptions };
  }

  repeat({ reversed }: { reversed: boolean }): Motion | undefined {
    if (this.last === undefined) return undefined;
    const backwards = reversed ? !this.last.backwards : this.last.backwards;
    return { type: backwards ? "searchBackward" : "searchForward", query: this.last.query, options: this.last.options };
  }

  matchRangeForSelection(editor: VimEditorCapabilities, { reversed, count, includeStart }: { reversed: boolean; count: number; includeStart: boolean }): TextRange | undefined {
    if (this.last === undefined) return undefined;
    const backwards = reversed ? !this.last.backwards : this.last.backwards;
    let start = selectionHead(editor.getSelections()[0]);
    let match: TextRange | undefined;
    for (let index = 0; index < count; index++) {
      match = editor.findSearchMatch(
        this.last.query,
        start,
        backwards ? "backward" : "forward",
        { ...this.last.options, includeStart: includeStart && index === 0 }
      );
      if (match === undefined) return undefined;
      start = match.start;
    }
    return match;
  }
}

export function searchUnderCursorMotion(
  editor: VimEditorCapabilities,
  searchState: SearchState,
  registers: Registers,
  { backwards }: { backwards: boolean }
): Motion | undefined {
  const query = wordUnderCursor(editor);
  if (query === undefined) return undefined;
  return searchState.setLast(query, backwards, registers, editor, { wholeWord: true });
}

function wordUnderCursor(editor: VimEditorCapabilities): string | undefined {
  const head = selectionHead(editor.getSelections()[0]);
  const line = editor.line(head.row);
  if (line.length === 0) return undefined;
  let column = Math.min(head.column, line.length - 1);
  if (!isWordChar(line[column]) && column > 0 && isWordChar(line[column - 1])) column--;
  if (!isWordChar(line[column])) return undefined;

  let start = column;
  while (start > 0 && isWordChar(line[start - 1])) start--;
  let end = column + 1;
  while (end < line.length && isWordChar(line[end])) end++;
  return line.slice(start, end);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /\w/.test(char);
}

