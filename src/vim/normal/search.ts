// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/search.rs
// - translated concepts: pending `/` / `?` query state, repeated search motions,
//   and native search UI synchronization
// - intentional differences: VSCode owns the concrete find UI/model while the core keeps
//   Vim-specific direction and repeat metadata.

import { VimEditorCapabilities } from "../editor.js";
import { Motion } from "../motion.js";
import { HistoryNavigation, PromptHistory, historyNavigationKey } from "../prompt_history.js";
import { Registers } from "../registers.js";
import { SearchOffset, SearchOptions, parseSearchOffset, searchOptionsForQuery } from "../search.js";
import {
  SingleLineEditor,
  SingleLineEditorKey,
} from "../single_line_editor.js";
import { TextRange, selectionHead } from "../state.js";

// [nav] is the in-flight history-navigation session (`<Up>`/`<C-p>`), created
// on the first history key and dropped when the query is edited.
export type PendingSearch = { type: "search"; backwards: boolean; input: SingleLineEditor; nav?: HistoryNavigation };

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
    || singleLineEditorKey(key) !== undefined
    || historyNavigationKey(key) !== undefined;
}

// Split a typed search input into its pattern and (optional) offset. The offset
// follows the first unescaped separator (`/` for a forward search, `?` for a
// backward one) and is only recognized when the trailing text parses as a
// character offset — so a literal `a/b` search (offset `b` = begin) matches Vim,
// while `path/to/file` (no valid offset) stays a plain pattern. `\<sep>` in the
// pattern is not treated as a separator.
function splitSearchOffset(
  input: string,
  separator: string
): { pattern: string; offset: SearchOffset | undefined } {
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === separator) {
      const offset = parseSearchOffset(input.slice(index + 1));
      if (offset !== undefined) return { pattern: input.slice(0, index), offset };
      return { pattern: input, offset: undefined };
    }
  }
  return { pattern: input, offset: undefined };
}

function searchMotion(
  backwards: boolean,
  query: string,
  options: SearchOptions,
  offset: SearchOffset | undefined
): Motion {
  return { type: backwards ? "searchBackward" : "searchForward", query, options, offset };
}

export class SearchState {
  private last:
    | { query: string; backwards: boolean; options: SearchOptions; offset: SearchOffset | undefined }
    | undefined;
  // Vim search history (`:h cmdline-history`), shared by `/` and `?` (and fed
  // by `*`/`#`); global, like [last].
  readonly history = new PromptHistory();

  pendingChord(pending: PendingSearch): string {
    const value = pending.input.value();
    const cursor = pending.input.cursorPosition();
    return `${pending.backwards ? "?" : "/"}${value.slice(
      0,
      cursor
    )}|${value.slice(cursor)}`;
  }

  // Create an empty pending prompt with no side effects, so a handler can build
  // its continuation purely and defer the preview (via [beginPreview]) to an
  // effect. [start] is [createPending] + [beginPreview] for callers that open
  // the prompt eagerly.
  createPending(backwards: boolean): PendingSearch {
    return { type: "search" as const, backwards, input: new SingleLineEditor("") };
  }

  beginPreview(pending: PendingSearch, editor: VimEditorCapabilities): void {
    editor.beginSearchPreview();
    this.updatePendingSearchUi(pending, editor);
  }

  start(backwards: boolean, editor: VimEditorCapabilities): PendingSearch {
    const pending = this.createPending(backwards);
    this.beginPreview(pending, editor);
    return pending;
  }

  // Pure: the search [Motion] the pending input resolves to (an empty input
  // reuses the last pattern in this prompt's direction), or [undefined] when
  // there is no pattern to search. Unlike [handleKey]'s `enter` branch this
  // performs no side effects — the caller commits the preview teardown, [last],
  // and register/highlight update in a deferred effect via [commitMotion].
  resolveMotion(pending: PendingSearch): Motion | undefined {
    const rawInput = pending.input.value();
    const backwards = pending.backwards;
    if (rawInput.length === 0) {
      if (this.last === undefined) return undefined;
      return searchMotion(backwards, this.last.query, this.last.options, this.last.offset);
    }
    const { pattern, offset } = splitSearchOffset(rawInput, backwards ? "?" : "/");
    const query = pattern.length > 0 ? pattern : this.last?.query;
    if (query === undefined || query.length === 0) return undefined;
    const options =
      pattern.length > 0
        ? searchOptionsForQuery(query)
        : this.last?.options ?? searchOptionsForQuery(query);
    return searchMotion(backwards, query, searchOptionsForQuery(query, options), offset);
  }

  // The side effects of completing a search resolved by [resolveMotion]: end the
  // incsearch preview, then record it as the last search + write the register +
  // set the persistent highlight (via [setLast]). Deferred by callers into an
  // effect so the resolving handler body stays pure.
  commitMotion(motion: Motion, registers: Registers, editor: VimEditorCapabilities): void {
    if (motion.type !== "searchForward" && motion.type !== "searchBackward") return;
    editor.endSearchPreview({ restoreViewport: false });
    this.setLast(motion.query, motion.type === "searchBackward", registers, editor, motion.options, motion.offset);
  }

  clearPending(editor: VimEditorCapabilities | undefined, pending: PendingSearch | undefined, { restoreViewport = false }: { restoreViewport?: boolean } = {}): void {
    if (pending !== undefined) {
      editor?.endSearchPreview({ restoreViewport });
    }
  }

  appendText(pending: PendingSearch, text: string, editor: VimEditorCapabilities): void {
    if (text.length === 0) return;
    pending.input.insert(text);
    pending.nav = undefined;
    this.updatePendingSearchUi(pending, editor);
  }

  // A history recall replaces the query (cursor at the end) and refreshes the
  // incsearch preview like typing. Vim: aborted prompts also enter the history
  // (see the cancel paths' [recordHistory] calls).
  recordHistory(pending: PendingSearch): void {
    this.history.add(pending.input.value());
  }

  private navigateHistory(pending: PendingSearch, key: string): boolean {
    const step = historyNavigationKey(key);
    if (step === undefined) return false;
    if (pending.nav === undefined) {
      pending.nav = { prefix: pending.input.value(), index: undefined };
    }
    const recalled = this.history.navigate(pending.nav, step);
    if (recalled !== undefined) pending.input.reset(recalled);
    return true;
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

    if (this.navigateHistory(pending, key)) {
      this.updatePendingSearchUi(pending, editor);
      return undefined;
    }

    if (key === "enter") {
      const rawInput = pending.input.value();
      this.recordHistory(pending);
      // Vim: an empty query repeats the last pattern (and its offset) in the
      // direction of THIS prompt (`?<CR>` searches backward even after a forward
      // search).
      const backwards = pending.backwards;
      editor.endSearchPreview({ restoreViewport: false });
      if (rawInput.length === 0) {
        if (this.last === undefined) return undefined;
        return this.setLast(this.last.query, backwards, registers, editor, this.last.options, this.last.offset);
      }
      // Split off a trailing `search-offset` (`/pat/e`, `?pat?s-1`). An
      // offset-only input (`/e`, i.e. empty pattern) reuses the last pattern.
      const { pattern, offset } = splitSearchOffset(rawInput, backwards ? "?" : "/");
      const query = pattern.length > 0 ? pattern : this.last?.query;
      if (query === undefined || query.length === 0) return undefined;
      const options =
        pattern.length > 0
          ? searchOptionsForQuery(query)
          : this.last?.options ?? searchOptionsForQuery(query);
      return this.setLast(query, backwards, registers, editor, options, offset);
    }

    const editorKey = singleLineEditorKey(key);
    if (editorKey !== undefined) {
      pending.input.tryKey(editorKey);
    } else if (key.length === 1) {
      pending.input.insert(key);
    }
    // An edit ends the history-navigation session: the next `<Up>` matches
    // against the edited text.
    pending.nav = undefined;
    this.updatePendingSearchUi(pending, editor);
    return undefined;
  }

  private updatePendingSearchUi(pending: PendingSearch, editor: VimEditorCapabilities): void {
    // Preview the pattern only: a trailing `search-offset` (`/pat/e`) is not part
    // of the highlighted/searched text.
    const pendingQuery = splitSearchOffset(pending.input.value(), pending.backwards ? "?" : "/").pattern;
    const typed = pendingQuery.length > 0;
    const query = typed ? pendingQuery : this.last?.query ?? "";
    const options = typed
      ? searchOptionsForQuery(query)
      : this.last?.options ?? searchOptionsForQuery(query);
    const direction = pending.backwards ? "backward" : "forward";
    editor.updateSearch(query, direction, { ...options, reveal: typed });
    // Vim `incsearch`: the viewport follows the next match only while the
    // user is typing a query. An empty input merely seeds the last search so
    // its matches stay highlighted; the viewport must not move.
    if (!typed) return;
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
    options: SearchOptions = searchOptionsForQuery(query),
    offset?: SearchOffset
  ): Motion {
    const normalizedOptions = searchOptionsForQuery(query, options);
    this.last = { query, backwards, options: normalizedOptions, offset };
    registers.writeSearch(query);
    editor.updateSearch(query, backwards ? "backward" : "forward", {
      ...normalizedOptions,
      reveal: true,
    });
    return {
      type: backwards ? "searchBackward" : "searchForward",
      query,
      options: normalizedOptions,
      offset,
    };
  }

  repeat({ reversed }: { reversed: boolean }): Motion | undefined {
    if (this.last === undefined) return undefined;
    const backwards = reversed ? !this.last.backwards : this.last.backwards;
    return {
      type: backwards ? "searchBackward" : "searchForward",
      query: this.last.query,
      options: this.last.options,
      offset: this.last.offset,
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
  // Vim: `*`/`#` add the pattern to the search history (Neovim stores it in
  // `\<word\>` syntax; locally the plain word + whole-word option is the same
  // search, so that is what a `/<Up>` recall re-runs).
  searchState.history.add(query);
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
