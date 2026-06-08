// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/search.rs
// - translated concepts: pending `/` / `?` query state, repeated search motions,
//   and native search UI synchronization
// - intentional differences: VSCode owns the concrete find UI/model while the core keeps
//   Vim-specific direction and repeat metadata.

import { VimEditorCapabilities } from "../editor.js";
import { Motion } from "../motion.js";
import { Registers } from "../registers.js";
import { SearchOptions, searchOptionsForQuery } from "../search.js";
import {
  SingleLineEditor,
  SingleLineEditorKey,
} from "../single_line_editor.js";
import { TextRange, selectionHead } from "../state.js";

export type PendingSearch = { type: "search"; backwards: boolean; input: SingleLineEditor };

function singleLineEditorKey(key: string): SingleLineEditorKey | undefined {
  switch (key) {
    case "left":
    case "right":
    case "ctrl-left":
    case "ctrl-right":
    case "home":
    case "end":
    case "space":
    case "backspace":
    case "delete":
    case "ctrl-backspace":
    case "ctrl-delete":
      return key;
    default:
      return undefined;
  }
}

export function isSearchInputKey(key: string): boolean {
  return key.length === 1
    || key === "enter"
    || key === "ctrl-v"
    || key === "ctrl-y"
    || key === "<escape>"
    || key === "escape"
    || key === "ctrl-["
    || singleLineEditorKey(key) !== undefined;
}

export class SearchState {
  private last:
    | { query: string; backwards: boolean; options: SearchOptions }
    | undefined;

  pendingChord(pending: PendingSearch): string {
    const value = pending.input.value();
    const cursor = pending.input.cursorPosition();
    return `${pending.backwards ? "?" : "/"}${value.slice(
      0,
      cursor
    )}|${value.slice(cursor)}`;
  }

  start(backwards: boolean, editor: VimEditorCapabilities): PendingSearch {
    editor.beginSearchPreview();
    const pending = { type: "search" as const, backwards, input: new SingleLineEditor("") };
    this.updatePendingSearchUi(pending, editor);
    return pending;
  }

  clearPending(editor: VimEditorCapabilities | undefined, pending: PendingSearch | undefined, { restoreViewport = false }: { restoreViewport?: boolean } = {}): void {
    if (pending !== undefined) {
      editor?.endSearchPreview({ restoreViewport });
    }
  }

  appendText(pending: PendingSearch, text: string, editor: VimEditorCapabilities): void {
    if (text.length === 0) return;
    pending.input.insert(text);
    this.updatePendingSearchUi(pending, editor);
  }

  handleKey(
    pending: PendingSearch,
    key: string,
    registers: Registers,
    editor: VimEditorCapabilities
  ): Motion | undefined {
    if (key === "ctrl-v" || key === "ctrl-y") {
      this.appendText(pending, registers.read("+"), editor);
      return undefined;
    }

    if (key === "enter") {
      const pendingQuery = pending.input.value();
      const query = pendingQuery.length > 0 ? pendingQuery : this.last?.query;
      const backwards =
        pendingQuery.length > 0
          ? pending.backwards
          : this.last?.backwards ?? pending.backwards;
      const options =
        pendingQuery.length > 0
          ? searchOptionsForQuery(query ?? "")
          : this.last?.options ?? searchOptionsForQuery(query ?? "");
      editor.endSearchPreview({ restoreViewport: false });
      if (query !== undefined && query.length > 0) {
        return this.setLast(query, backwards, registers, editor, options);
      }
      return undefined;
    }

    const editorKey = singleLineEditorKey(key);
    if (editorKey !== undefined) {
      pending.input.tryKey(editorKey);
    } else if (key.length === 1) {
      pending.input.insert(key);
    }
    this.updatePendingSearchUi(pending, editor);
    return undefined;
  }

  private updatePendingSearchUi(pending: PendingSearch, editor: VimEditorCapabilities): void {
    const pendingQuery = pending.input.value();
    const query =
      pendingQuery.length === 0 ? this.last?.query ?? "" : pendingQuery;
    const options =
      pendingQuery.length === 0
        ? this.last?.options ?? searchOptionsForQuery(query)
        : searchOptionsForQuery(query);
    const direction = pending.backwards ? "backward" : "forward";
    editor.updateSearch(query, direction, { ...options, reveal: true });
    const match = editor.findSearchMatch(
      query,
      selectionHead(editor.getSelections()[0]),
      direction,
      options
    );
    if (match !== undefined) editor.revealRange(match);
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
    editor.updateSearch(query, backwards ? "backward" : "forward", {
      ...normalizedOptions,
      reveal: true,
    });
    return {
      type: backwards ? "searchBackward" : "searchForward",
      query,
      options: normalizedOptions,
    };
  }

  repeat({ reversed }: { reversed: boolean }): Motion | undefined {
    if (this.last === undefined) return undefined;
    const backwards = reversed ? !this.last.backwards : this.last.backwards;
    return {
      type: backwards ? "searchBackward" : "searchForward",
      query: this.last.query,
      options: this.last.options,
    };
  }

  matchRangeForSelection(
    editor: VimEditorCapabilities,
    {
      reversed,
      count,
      includeStart,
    }: { reversed: boolean; count: number; includeStart: boolean }
  ): TextRange | undefined {
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
  return searchState.setLast(query, backwards, registers, editor, {
    wholeWord: true,
  });
}

function wordUnderCursor(editor: VimEditorCapabilities): string | undefined {
  const head = selectionHead(editor.getSelections()[0]);
  const line = editor.line(head.row);
  if (line.length === 0) return undefined;
  let column = Math.min(head.column, line.length - 1);
  if (!isWordChar(line[column]) && column > 0 && isWordChar(line[column - 1]))
    column--;
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
