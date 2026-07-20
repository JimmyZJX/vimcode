// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/vim.rs, crates/vim/src/test/vim_test_context.rs
// - translated concepts: editor operations are mediated through a testable host interface
// - intentional differences: VSCode and fake editors implement this capability interface directly

import type { SubstitutePreview } from "./command.js";
import { graphemeStart } from "./grapheme.js";
import { LineTracker, TrackedLines } from "./line_tracker.js";
import {
  SearchDirection,
  SearchMatch,
  SearchMatchCount,
  SearchOptions,
  allSearchMatchesInText,
  findSearchMatchInText,
} from "./search.js";
import {
  CursorStyle,
  Position,
  TextEdit,
  TextRange,
  VimSelection,
  VimSelectionGoal,
  charwiseSelection,
  comparePositions,
  orderedRange,
  position,
  selectionHead,
} from "./state.js";

export type EasyMotionMarker = {
  label: string;
  position: Position;
};

export type HostCommand = "navigateBack" | "navigateForward" | "undo" | "redo";
export type HostDirection = "up" | "down";
export type HostRevealTarget = "top" | "center" | "bottom";
export type HostFoldCommand =
  | "toggle"
  | "open"
  | "close"
  | "openRecursive"
  | "closeRecursive"
  | "openAll"
  | "closeAll";
export type ApplyEditsOptions = {
  undoStopBefore?: boolean;
  undoStopAfter?: boolean;
};

export type NativeCommandOptions = {
  preserveVisualSelection?: boolean;
  syncSelectionAfter?: boolean;
  /** Selections to apply once the (asynchronous) native command completes —
      e.g. the restored cursor after `gcc` runs the native comment toggle over
      a temporary selection. */
  selectionsAfter?: readonly VimSelection[];
  /** Reconcile Vim state from the editor once the command completes, but
      *without* holding the key pipeline. [syncSelectionAfter] makes the key's
      job — and therefore every later keystroke — wait for the command; that
      is right for undo/redo (the next key depends on the restored state) but
      froze typing for the duration of `:w` under slow save participants
      (format-on-save, remote filesystems). Background sync lets keys flow and
      runs one external-state reconcile when the command resolves (selection
      events are suppressed while a native command is in flight, so the
      reconcile cannot be event-driven). */
  backgroundSync?: boolean;
  /** Runs once the command has *completed successfully* — and not at all when
      it fails. Native commands are asynchronous, so two back-to-back
      [executeNativeCommand] calls race: `:wq` firing close while the save is
      still in flight makes VSCode see a dirty editor and ask for
      confirmation. Chaining the follow-up in the callback orders them (and a
      failed save never closes the editor). A returned promise is awaited: the
      command counts as in progress — and [syncSelectionAfter] waits — until
      the callback's own work is done too. (The in-memory test host runs
      everything synchronously and does not await.) */
  onResolved?: () => void | Promise<void>;
};

export type VimUndoTransaction = {
  finish(selectionsAfter?: readonly VimSelection[]): void;
};

// Most Vim edits are complete commands and should become one native undo unit.
// Change-like commands ([c], [s], visual [c], etc.) first delete text and then
// enter insert/replace mode; use [keepUndoTransactionOpen] for the deletion half
// and call [finishUndoTransaction] when Escape leaves insert/replace mode.
export function keepUndoTransactionOpen(
  options: ApplyEditsOptions = {}
): ApplyEditsOptions {
  return { ...options, undoStopAfter: false };
}

// The text a printable insert-mode key inserts, or [undefined] for a key that
// is not plain typed input (a bare `backspace`, a ctrl-chord, …). Shared by the
// Vim core (dispatch/ownership) and the in-memory editor's [replayInsertKey].
export function normalViewLineColumnForGoal(
  goal: VimSelectionGoal,
  { minColumn, maxColumn }: { minColumn: number; maxColumn: number }
): number {
  // Host view positions are 1-based and [maxColumn] is one past the final
  // character. Normal-mode display-line movement must not return that boundary:
  // at a soft wrap it converts to the first character of the next view line.
  const maxCursorColumn = Math.max(minColumn, maxColumn - 1);
  if (goal.type === "endOfLine") return maxCursorColumn;
  const requestedColumn =
    goal.type === "viewColumn" ? goal.column : goal.column + 1;
  return Math.max(minColumn, Math.min(requestedColumn, maxCursorColumn));
}

export function insertTextForKey(key: string): string | undefined {
  if (key === "space") return " ";
  if (key === "enter") return "\n";
  if (key === "\n") return "\n";
  if (key.length === 1) return key;
  // A single astral character (e.g. an emoji from a remap replacement) is one
  // key even though it spans two UTF-16 units.
  if (
    key.length === 2 &&
    key.charCodeAt(0) >= 0xd800 &&
    key.charCodeAt(0) <= 0xdbff
  )
    return key;
  return undefined;
}

// Zed: `vim::Vim::update_editor` is the closest
// equivalent boundary, but it closes over Zed's concrete `Editor`. This interface
// is intentionally local: production VSCode and fake tests both implement it.
export interface VimEditorCapabilities {
  lineCount(): number;
  line(row: number): string;
  lineLength(row: number): number;
  getText(range?: TextRange): string;
  /** A cheap content stamp: equal values guarantee the document text is
      unchanged (the converse need not hold). Per-key hot paths use this
      instead of materializing and comparing the whole document text, which is
      O(document) per keypress on large files. VSCode backs this with
      `ITextModel.getAlternativeVersionId`. */
  documentVersion(): number;

  getSelections(): readonly VimSelection[];
  setSelections(selections: readonly VimSelection[]): void;
  isReadonly(): boolean;
  setCursorStyle(style: CursorStyle): void;
  setInsertPendingText(text: string | undefined): void;
  showEasyMotionMarkers(markers: readonly EasyMotionMarker[]): void;
  clearEasyMotionMarkers(): void;
  /** Every yank reports the yanked ranges here; the host renders a transient
      highlight when the user opted in (VSCodeVim `vim.highlightedyank.*` —
      `BaseOperator.highlightYankedRanges`). Rendering (color, text color,
      duration, enablement) is entirely a host concern. */
  highlightYankedRanges(ranges: readonly TextRange[]): void;

  applyEdits(
    edits: readonly TextEdit[],
    selectionsAfter: readonly VimSelection[],
    options?: ApplyEditsOptions
  ): void;
  /** Track line identities across buffer edits (Vim `:h :global` pass 2: the
      marked lines shift as earlier iterations add/remove lines, and a deleted
      line's mark dies). See [LineTracker] for the transform semantics. */
  trackLines(rows: readonly number[]): TrackedLines;
  beginUndoTransaction(
    selectionsBefore: readonly VimSelection[]
  ): VimUndoTransaction;
  finishUndoTransaction(selectionsAfter?: readonly VimSelection[]): void;
  flushUndoTransaction(): void;

  // Reproduce the host's default handling of an insert/replace-mode [key] that
  // Vim let pass through (see [RecordedKey] "typed"). It is called on the
  // replay path (dot-repeat / macros) — where there is no real keydown — and in
  // tests; live typing is handled natively by the host (the controller does not
  // preventDefault). VSCode routes the key through its real keybinding resolution
  // (a printable char → the `type` command, `backspace` → `deleteLeft`, honoring
  // user overrides); the in-memory editor applies the equivalent buffer edit so
  // tests can assert contents. Edits keep the insert undo transaction open (they
  // coalesce into one undo unit finished on Escape).
  replayInsertKey(key: string): void;

  executeHostCommand(command: HostCommand): void;
  executeNativeCommand(
    command: string,
    args?: readonly unknown[],
    options?: NativeCommandOptions
  ): void | Promise<void>;
  isExecutingNativeCommand?(): boolean;
  revealPrimaryCursorIfOutsideViewport(): void;
  revealRange(range: TextRange): void;
  revealCurrentLine(target: HostRevealTarget): void;
  executeFoldCommand(command: HostFoldCommand): void;
  moveByViewLines(
    direction: HostDirection,
    count: number,
    options: { displayLine: boolean; extend: boolean }
  ): readonly VimSelection[] | undefined;
  moveByPages(
    direction: HostDirection,
    count: number,
    options: { halfPage: boolean; extend: boolean }
  ): readonly VimSelection[] | undefined;
  scrollByLines(
    direction: HostDirection,
    count: number,
    options?: { extend: boolean }
  ): void;
  /** Model rows currently visible in the host viewport (both inclusive), or
      undefined when the host has no viewport. Used by `H`/`M`/`L`. */
  visibleRowRange(): { top: number; bottom: number } | undefined;
  /** The host's vertical ruler columns (VSCode `editor.rulers`, resolved for
      the editor's language), in configuration order. The first ruler is the
      `gq`/`gw` format width when `vim.textwidth` is not set. */
  rulerColumns(): readonly number[];

  // Zed: `normal::search` integrates with `BufferSearchBar` so search motions,
  // highlights, and find-widget state share one source of truth. Locally, the
  // fake editor implements this as a model-buffer query while VSCode backs it
  // with the native find controller/model.
  beginSearchPreview(): void;
  endSearchPreview(options?: { restoreViewport?: boolean }): void;
  updateSearch(
    query: string,
    direction: SearchDirection,
    options?: SearchOptions
  ): void;
  findSearchMatch(
    query: string,
    start: Position,
    direction: SearchDirection,
    options?: SearchOptions
  ): SearchMatch | undefined;
  /** Match count for the search-status display: the 1-based index of the match
      starting at [matchStart] among all document matches, or undefined when
      nothing matches. */
  searchMatchCount(
    query: string,
    matchStart: Position,
    options?: SearchOptions
  ): SearchMatchCount | undefined;
  clearSearchHighlights(): void;

  // Live `:s` preview (see [substitutePreviews]): the host highlights each
  // match and shows its resolved replacement inline while the command line is
  // being typed. Cleared when the prompt closes (submit or escape).
  updateSubstitutePreview(previews: readonly SubstitutePreview[]): void;
  clearSubstitutePreview(): void;
}

// Zed: clipping is usually handled by display-map/editor helpers such as
// `DisplaySnapshot::clip_point` / display-map helpers, for example in
// `normal::delete::Vim::delete_motion`.
export function clipPosition(
  editor: VimEditorCapabilities,
  pos: Position
): Position {
  const row = Math.max(0, Math.min(pos.row, editor.lineCount() - 1));
  const column = Math.max(0, Math.min(pos.column, editor.lineLength(row)));
  return { row, column };
}

// Zed: normal-mode cursor fixups appear throughout operator implementations,
// e.g. `normal::delete::Vim::delete_motion` after delete motions.
export function normalCursorPosition(
  editor: VimEditorCapabilities,
  pos: Position
): Position {
  const clipped = clipPosition(editor, pos);
  const line = editor.line(clipped.row);
  if (line.length === 0) return { row: clipped.row, column: 0 };
  // A normal-mode cursor sits on a character cell: snap into the containing
  // grapheme cluster (the last cell starts at the final cluster's boundary,
  // not at length - 1, which can be mid-cluster).
  return {
    row: clipped.row,
    column: graphemeStart(line, Math.min(clipped.column, line.length - 1)),
  };
}

export function rangeText(
  editor: VimEditorCapabilities,
  range: TextRange
): string {
  return editor.getText(range);
}

function exclusiveVisualHead(
  editor: VimEditorCapabilities,
  head: Position
): Position {
  const lineLength = editor.lineLength(head.row);
  if (lineLength === 0) return head;
  return { row: head.row, column: Math.min(head.column + 1, lineLength) };
}

// Zed: `test::vim_test_context::VimTestContext` and
// `test::neovim_backed_test_context::NeovimBackedTestContext`
// motivate this fake editor. It is not a port of either; it is the local host
// implementation used for capability-interface tests.
type UndoSnapshot = {
  textBefore: string;
  textAfter: string;
  selectionsBefore: VimSelection[];
  selectionsAfter: VimSelection[];
};

export class InMemoryVimEditor implements VimEditorCapabilities {
  private lines: string[];
  private contentVersion = 0;
  private selections: VimSelection[];
  private undoStack: UndoSnapshot[] = [];
  private redoStack: UndoSnapshot[] = [];
  private pendingUndoSnapshot: UndoSnapshot | undefined;
  private pendingUndoSelectionsBefore: VimSelection[] | undefined;
  private undoTransactionDepth = 0;
  private readonly lineTrackers = new Set<LineTracker>();
  public cursorStyle: CursorStyle = "block";
  public insertPendingText: string | undefined;
  public easyMotionMarkers: readonly EasyMotionMarker[] = [];
  private viewportLines: number | undefined;
  private viewportScrolloff = 0;
  private viewportTopRow = 0;
  private rulers: readonly number[] = [];
  private readonlyForTest = false;
  public readonly nativeCommands: {
    command: string;
    args: readonly unknown[];
  }[] = [];
  /** Ranges reported through [highlightYankedRanges], one entry per yank. */
  public readonly yankHighlights: TextRange[][] = [];
  /** Commands issued from an [onResolved] callback — i.e. only after the
      previous command completed (for tests: `:wq` must chain, not race). */
  public readonly chainedNativeCommands: string[] = [];
  /** Commands executed with [backgroundSync] (for tests: `:w` must not hold
      the key pipeline while the save runs). */
  public readonly backgroundSyncNativeCommands: string[] = [];
  private inNativeCommandCallback = false;

  constructor(text = "") {
    this.lines = text.split("\n");
    this.selections = [charwiseSelection(position(0, 0))];
  }

  resetForTest(text: string, selections: readonly VimSelection[]): void {
    this.lines = text.split("\n");
    this.contentVersion++;
    this.selections = [charwiseSelection(position(0, 0))];
    this.undoStack = [];
    this.redoStack = [];
    this.pendingUndoSnapshot = undefined;
    this.pendingUndoSelectionsBefore = undefined;
    this.undoTransactionDepth = 0;
    this.easyMotionMarkers = [];
    this.substitutePreview = undefined;
    this.viewportTopRow = 0;
    this.readonlyForTest = false;
    this.setSelections(selections);
  }

  lineCount(): number {
    return this.lines.length;
  }

  line(row: number): string {
    return this.lines[row] ?? "";
  }

  lineLength(row: number): number {
    return this.line(row).length;
  }

  getText(range?: TextRange): string {
    if (range === undefined) return this.lines.join("\n");
    const start = clipPosition(this, range.start);
    const end = clipPosition(this, range.end);
    const ordered = orderedRange(start, end);
    if (ordered.start.row === ordered.end.row) {
      return this.line(ordered.start.row).slice(
        ordered.start.column,
        ordered.end.column
      );
    }

    const parts = [this.line(ordered.start.row).slice(ordered.start.column)];
    for (let row = ordered.start.row + 1; row < ordered.end.row; row++) {
      parts.push(this.line(row));
    }
    parts.push(this.line(ordered.end.row).slice(0, ordered.end.column));
    return parts.join("\n");
  }

  documentVersion(): number {
    return this.contentVersion;
  }

  getSelections(): readonly VimSelection[] {
    return this.selections;
  }

  setSelections(selections: readonly VimSelection[]): void {
    if (selections.length === 0) {
      throw new Error("Vim selections cannot be empty");
    }
    this.selections = selections.map((selection) => {
      switch (selection.type) {
        case "charwise":
          return {
            ...selection,
            anchor: clipPosition(this, selection.anchor),
            head: clipPosition(this, selection.head),
          };
        case "linewise":
          return {
            ...selection,
            anchorLine: clipPosition(this, position(selection.anchorLine, 0))
              .row,
            headLine: clipPosition(this, position(selection.headLine, 0)).row,
            cursor:
              selection.cursor === undefined
                ? undefined
                : clipPosition(this, selection.cursor),
          };
        case "blockwise":
          return {
            ...selection,
            anchor: clipPosition(this, selection.anchor),
            head: clipPosition(this, selection.head),
            cursor:
              selection.cursor === undefined
                ? undefined
                : clipPosition(this, selection.cursor),
          };
      }
    });
    if (this.pendingUndoSnapshot !== undefined) {
      this.pendingUndoSnapshot = {
        ...this.pendingUndoSnapshot,
        selectionsAfter: cloneSelections(this.selections),
      };
    }
    this.revealPrimaryCursorInTestViewport();
  }

  // Editors auto-scroll to keep the cursor visible; mirror that for the
  // test-only viewport so page motions observe the topline a real Neovim
  // window would have after ordinary motions (`gg`, `4j`, ...).
  private revealPrimaryCursorInTestViewport(): void {
    const height = this.viewportHeight();
    const selection = this.selections[0];
    if (height === undefined || selection === undefined) return;
    const row = (
      selection.type === "linewise"
        ? selection.cursor ?? { row: selection.headLine, column: 0 }
        : selection.cursor ?? selectionHead(selection)
    ).row;
    const lastRow = this.lineCount() - 1;
    const scrolloff = this.viewportScrolloff;
    let top = this.viewportTopRow;
    if (2 * scrolloff >= height) {
      top = row - Math.floor((height - 1) / 2);
    } else {
      // The margins relax at the document edges: no padding above row zero or
      // below the last line.
      const maxTop = row - Math.min(scrolloff, row);
      const minTop = row - height + 1 + Math.min(scrolloff, lastRow - row);
      if (top > maxTop) top = maxTop;
      else if (top < minTop) top = minTop;
    }
    this.viewportTopRow = Math.max(0, Math.min(top, lastRow));
  }

  isReadonly(): boolean {
    return this.readonlyForTest;
  }

  setReadonlyForTest(readonly: boolean): void {
    this.readonlyForTest = readonly;
  }

  setCursorStyle(style: CursorStyle): void {
    this.cursorStyle = style;
  }

  setInsertPendingText(text: string | undefined): void {
    this.insertPendingText = text;
  }

  showEasyMotionMarkers(markers: readonly EasyMotionMarker[]): void {
    this.easyMotionMarkers = markers.map((marker) => ({ ...marker }));
  }

  highlightYankedRanges(ranges: readonly TextRange[]): void {
    this.yankHighlights.push(ranges.map((range) => ({
      start: { ...range.start },
      end: { ...range.end },
    })));
  }

  clearEasyMotionMarkers(): void {
    this.easyMotionMarkers = [];
  }

  // Simulate VSCode's default insert-mode handling for the passthrough
  // whitelist: printable keys insert their text; backspace/delete remove one
  // character (joining lines at boundaries); `ctrl-backspace`/`ctrl-delete`
  // remove a (whitespace-delimited — an approximation of VSCode's word rules)
  // word; the navigation keys move the cursor. Edits keep the insert undo
  // transaction open so a replayed session is one undo unit.
  replayInsertKey(key: string): void {
    const options = keepUndoTransactionOpen();
    const text = insertTextForKey(key);
    if (text !== undefined) {
      const edits: TextEdit[] = [];
      const selectionsAfter: VimSelection[] = [];
      for (const selection of this.getSelections()) {
        const head = selectionHead(selection);
        edits.push({ range: { start: head, end: head }, text });
        const lines = text.split("\n");
        const after =
          lines.length > 1
            ? {
                row: head.row + lines.length - 1,
                column: lines[lines.length - 1].length,
              }
            : { row: head.row, column: head.column + text.length };
        selectionsAfter.push(charwiseSelection(after));
      }
      this.applyEdits(edits, selectionsAfter, options);
      return;
    }

    const deleteToTarget = (
      target: (head: Position) => Position,
      side: "before" | "after"
    ): void => {
      const edits: TextEdit[] = [];
      const selectionsAfter: VimSelection[] = [];
      for (const selection of this.getSelections()) {
        const head = selectionHead(selection);
        const other = target(head);
        const range =
          side === "before"
            ? { start: other, end: head }
            : { start: head, end: other };
        edits.push({ range, text: "" });
        selectionsAfter.push(charwiseSelection(range.start));
      }
      this.applyEdits(edits, selectionsAfter, options);
    };
    const moveTo = (target: (head: Position) => Position): void => {
      // Cursor movement splits the insert undo unit, like VSCode (a cursor
      // change breaks typing coalescing) and like Vim, where arrow keys in
      // insert break the undo sequence.
      this.finishUndoTransaction();
      this.setSelections(
        this.getSelections().map((selection) =>
          charwiseSelection(target(selectionHead(selection)))
        )
      );
    };

    switch (key) {
      case "backspace":
        deleteToTarget((head) => characterLeft(this, head), "before");
        return;
      case "delete":
        deleteToTarget((head) => characterRight(this, head), "after");
        return;
      case "ctrl-backspace":
        deleteToTarget((head) => simulatedWordLeft(this, head), "before");
        return;
      case "ctrl-delete":
        deleteToTarget((head) => simulatedWordRight(this, head), "after");
        return;
      case "left":
        moveTo((head) => characterLeft(this, head));
        return;
      case "right":
        moveTo((head) => characterRight(this, head));
        return;
      case "up":
      case "down": {
        const delta = key === "up" ? -1 : 1;
        moveTo((head) => {
          const row = Math.max(
            0,
            Math.min(this.lineCount() - 1, head.row + delta)
          );
          return { row, column: Math.min(head.column, this.lineLength(row)) };
        });
        return;
      }
      case "home":
        moveTo((head) => ({ row: head.row, column: 0 }));
        return;
      case "end":
        moveTo((head) => ({
          row: head.row,
          column: this.lineLength(head.row),
        }));
        return;
      case "ctrl-left":
        moveTo((head) => simulatedWordLeft(this, head));
        return;
      case "ctrl-right":
        moveTo((head) => simulatedWordRight(this, head));
        return;
      case "pageup":
      case "pagedown": {
        this.finishUndoTransaction();
        const moved = this.moveByPages(key === "pageup" ? "up" : "down", 1, {
          halfPage: false,
          extend: false,
        });
        if (moved !== undefined) this.setSelections(moved);
        return;
      }
    }
  }

  applyEdits(
    edits: readonly TextEdit[],
    selectionsAfter: readonly VimSelection[],
    options: ApplyEditsOptions = {}
  ): void {
    const undoStopBefore = options.undoStopBefore ?? true;
    const undoStopAfter = options.undoStopAfter ?? true;
    if (
      undoStopBefore &&
      this.pendingUndoSnapshot === undefined &&
      this.pendingUndoSelectionsBefore === undefined
    ) {
      this.finishUndoTransaction();
    }

    const transactionOpenBefore = this.undoTransactionDepth > 0;
    const snapshotBefore = this.pendingUndoSnapshot;
    const textBefore = snapshotBefore?.textBefore ?? this.getText();
    const selectionsBefore = cloneSelections(
      snapshotBefore?.selectionsBefore ??
        this.pendingUndoSelectionsBefore ??
        this.selections
    );
    const sortedEdits = [...edits].sort(
      (a, b) => -comparePositions(a.range.start, b.range.start)
    );
    for (const edit of sortedEdits) {
      this.replace(edit.range, edit.text);
    }
    this.setSelections(selectionsAfter);
    const textAfter = this.getText();
    const storedSelectionsAfter = cloneSelections(this.selections);
    if (
      textBefore !== textAfter ||
      !selectionsEqual(selectionsBefore, storedSelectionsAfter)
    ) {
      this.pendingUndoSnapshot = {
        textBefore,
        textAfter,
        selectionsBefore,
        selectionsAfter: storedSelectionsAfter,
      };
      this.redoStack = [];
    }
    if (undoStopAfter && snapshotBefore === undefined && !transactionOpenBefore)
      this.finishUndoTransaction();
  }

  trackLines(rows: readonly number[]): TrackedLines {
    const tracker = new LineTracker(rows);
    this.lineTrackers.add(tracker);
    return {
      currentRow: index => tracker.currentRow(index),
      dispose: () => this.lineTrackers.delete(tracker),
    };
  }

  beginUndoTransaction(
    selectionsBefore: readonly VimSelection[]
  ): VimUndoTransaction {
    if (
      this.undoTransactionDepth === 0 &&
      this.pendingUndoSnapshot === undefined &&
      this.pendingUndoSelectionsBefore === undefined
    ) {
      this.pendingUndoSelectionsBefore = cloneSelections(selectionsBefore);
    }
    this.undoTransactionDepth++;
    let finished = false;
    return {
      finish: (selectionsAfter?: readonly VimSelection[]) => {
        if (finished) return;
        finished = true;
        this.finishUndoTransaction(selectionsAfter);
      },
    };
  }

  finishUndoTransaction(selectionsAfter?: readonly VimSelection[]): void {
    if (
      selectionsAfter !== undefined &&
      this.pendingUndoSnapshot !== undefined
    ) {
      this.pendingUndoSnapshot = {
        ...this.pendingUndoSnapshot,
        selectionsAfter: cloneSelections(selectionsAfter),
      };
    }
    if (this.undoTransactionDepth > 0) {
      this.undoTransactionDepth--;
      if (this.undoTransactionDepth > 0) return;
    }

    const snapshot = this.pendingUndoSnapshot;
    this.pendingUndoSelectionsBefore = undefined;
    if (snapshot === undefined) return;
    this.pendingUndoSnapshot = undefined;
    const finalizedSnapshot =
      selectionsAfter === undefined
        ? snapshot
        : { ...snapshot, selectionsAfter: cloneSelections(selectionsAfter) };
    if (
      finalizedSnapshot.textBefore !== finalizedSnapshot.textAfter ||
      !selectionsEqual(
        finalizedSnapshot.selectionsBefore,
        finalizedSnapshot.selectionsAfter
      )
    ) {
      this.undoStack.push(finalizedSnapshot);
    }
  }

  flushUndoTransaction(): void {
    this.undoTransactionDepth = 0;
    this.finishUndoTransaction(this.selections);
  }

  executeHostCommand(command: HostCommand): void {
    switch (command) {
      case "undo":
        this.undo();
        return;
      case "redo":
        this.redo();
        return;
      case "navigateBack":
      case "navigateForward":
        return;
    }
  }

  executeNativeCommand(
    command: string,
    args: readonly unknown[] = [],
    options: NativeCommandOptions = {}
  ): void {
    this.nativeCommands.push({ command, args });
    if (this.inNativeCommandCallback) this.chainedNativeCommands.push(command);
    if (options.backgroundSync === true) this.backgroundSyncNativeCommands.push(command);
    if (options.selectionsAfter !== undefined) {
      this.setSelections([...options.selectionsAfter]);
    }
    // The in-memory host runs commands synchronously (as no-ops), so the
    // completion callback fires immediately; a returned promise is not
    // awaited here (this host has no async), so tests should use synchronous
    // callbacks.
    if (options.onResolved !== undefined) {
      const wasInCallback = this.inNativeCommandCallback;
      this.inNativeCommandCallback = true;
      try {
        void options.onResolved();
      } finally {
        this.inNativeCommandCallback = wasInCallback;
      }
    }
  }

  revealPrimaryCursorIfOutsideViewport(): void {}

  revealRange(_range: TextRange): void {}

  revealCurrentLine(_target: HostRevealTarget): void {}

  executeFoldCommand(_command: HostFoldCommand): void {}

  moveByViewLines(
    direction: HostDirection,
    count: number,
    { extend }: { displayLine: boolean; extend: boolean }
  ): readonly VimSelection[] | undefined {
    // The in-memory editor has no VSCode view model, hidden ranges, or soft-wrap data.
    // Use a deliberately naive model-row approximation for non-extending movements so
    // host-motion callers such as [dj] are testable without a real VSCode instance.
    // Extending visual selections keep the core fallback because Vim's inclusive visual
    // semantics are richer than this fake host can approximate faithfully.
    if (extend) return undefined;
    return this.modelRowSelections(direction, count, { extend });
  }

  moveByPages(
    direction: HostDirection,
    count: number,
    { halfPage, extend }: { halfPage: boolean; extend: boolean }
  ): readonly VimSelection[] {
    const height = this.viewportHeight();
    if (height === undefined) {
      const pageSize = Math.max(
        1,
        Math.floor(this.lineCount() / (halfPage ? 2 : 1))
      );
      return this.modelRowSelections(direction, count * pageSize, { extend });
    }
    const lastRow = this.lineCount() - 1;
    // Page scrolls keep the window full: the topline stops once the last line
    // reaches the bottom of the window (unlike `ctrl-e`, which can scroll the
    // last line up to the top).
    const maxTop = Math.max(0, this.lineCount() - height);
    if (halfPage) {
      // Vim: `ctrl-d`/`ctrl-u` scroll by 'scroll' (half the window height); the
      // cursor moves with the viewport and is then pushed inside the
      // 'scrolloff' margins.
      const delta = count * Math.max(1, Math.floor(height / 2));
      const signedDelta = direction === "up" ? -delta : delta;
      this.viewportTopRow = Math.max(
        0,
        Math.min(this.viewportTopRow + signedDelta, maxTop)
      );
      return this.modelRowSelections(direction, delta, { extend }, (row) =>
        this.rowInsideScrolloffMargins(row)
      );
    }
    // Vim `onepage()`: `ctrl-f`/`ctrl-b` scroll by a window (keeping two lines
    // of overlap) and land the cursor on the new window's first/last line,
    // pushed inside the 'scrolloff' margins.
    const delta = count * Math.max(1, height - 2);
    const signedDelta = direction === "up" ? -delta : delta;
    this.viewportTopRow = Math.max(
      0,
      Math.min(this.viewportTopRow + signedDelta, maxTop)
    );
    const target =
      direction === "down"
        ? this.viewportTopRow
        : Math.min(this.viewportTopRow + height - 1, lastRow);
    const row = this.rowInsideScrolloffMargins(target);
    return this.modelRowSelections(direction, 0, { extend }, () => row);
  }

  scrollByLines(
    direction: HostDirection,
    count: number,
    { extend = false }: { extend?: boolean } = {}
  ): void {
    const height = this.viewportHeight();
    if (height === undefined) return;
    // Vim: `ctrl-e`/`ctrl-y` scroll the viewport; the cursor stays put until
    // the 'scrolloff' margins push it.
    const lastRow = this.lineCount() - 1;
    const signedDelta = direction === "up" ? -count : count;
    this.viewportTopRow = Math.max(
      0,
      Math.min(this.viewportTopRow + signedDelta, lastRow)
    );
    this.setSelections(
      this.modelRowSelections(direction, 0, { extend }, (row) =>
        this.rowInsideScrolloffMargins(row)
      )
    );
  }

  visibleRowRange(): { top: number; bottom: number } {
    const lastRow = this.lineCount() - 1;
    const height = this.viewportHeight();
    // Without a configured viewport the whole document is "visible".
    if (height === undefined) return { top: 0, bottom: lastRow };
    return {
      top: this.viewportTopRow,
      bottom: Math.min(this.viewportTopRow + height - 1, lastRow),
    };
  }

  // Test-only viewport model so fixtures recorded with Neovim UI options
  // (`lines=N`, `scrolloff=N`) can replay page motions faithfully.
  configureViewportForTest({
    lines,
    scrolloff,
  }: {
    lines?: number;
    scrolloff?: number;
  }): void {
    if (lines !== undefined) this.viewportLines = lines;
    if (scrolloff !== undefined) this.viewportScrolloff = scrolloff;
  }

  rulerColumns(): readonly number[] {
    return this.rulers;
  }

  // Test-only stand-in for VSCode's `editor.rulers`.
  configureRulersForTest(rulers: readonly number[]): void {
    this.rulers = rulers;
  }

  private viewportHeight(): number | undefined {
    // Neovim: 'lines' counts the whole screen; the text window loses one row
    // each to the statusline and the command line.
    return this.viewportLines === undefined
      ? undefined
      : Math.max(1, this.viewportLines - 2);
  }

  private rowInsideScrolloffMargins(row: number): number {
    const height = this.viewportHeight();
    if (height === undefined) return row;
    const lastRow = this.lineCount() - 1;
    const top = this.viewportTopRow;
    const bottom = Math.min(top + height - 1, lastRow);
    const scrolloff = this.viewportScrolloff;
    // Vim: when the margins cannot both be satisfied the cursor is centered in
    // the window; the margins never push the cursor past the document edges.
    if (2 * scrolloff >= height) {
      const center = top + Math.floor((height - 1) / 2);
      const minRow = top === 0 ? 0 : center;
      const maxRow = bottom >= lastRow ? lastRow : center;
      return Math.max(minRow, Math.min(row, maxRow));
    }
    const minRow = top === 0 ? top : Math.min(top + scrolloff, bottom);
    const maxRow =
      bottom >= lastRow ? bottom : Math.max(bottom - scrolloff, top);
    return Math.max(minRow, Math.min(row, maxRow));
  }

  beginSearchPreview(): void {}

  endSearchPreview(_options: { restoreViewport?: boolean } = {}): void {}

  updateSearch(
    _query: string,
    _direction: SearchDirection,
    _options: SearchOptions = {}
  ): void {}

  findSearchMatch(
    query: string,
    start: Position,
    direction: SearchDirection,
    options: SearchOptions = {}
  ): SearchMatch | undefined {
    return findSearchMatchInText(
      this.getText(),
      query,
      offsetOfPosition(this, start),
      direction,
      options
    )?.range;
  }

  searchMatchCount(
    query: string,
    matchStart: Position,
    options: SearchOptions = {}
  ): SearchMatchCount | undefined {
    const matches = allSearchMatchesInText(this.getText(), query, options);
    if (matches.length === 0) return undefined;
    const target = offsetOfPosition(this, matchStart);
    const index = matches.findIndex(match => match.offset >= target);
    return { index: (index < 0 ? matches.length - 1 : index) + 1, total: matches.length, capped: false };
  }

  clearSearchHighlights(): void {}

  /** The last live `:s` preview, or undefined when cleared (for tests). */
  public substitutePreview: readonly SubstitutePreview[] | undefined =
    undefined;

  updateSubstitutePreview(previews: readonly SubstitutePreview[]): void {
    this.substitutePreview = previews;
  }

  clearSubstitutePreview(): void {
    this.substitutePreview = undefined;
  }

  private undo(): void {
    this.finishUndoTransaction();
    const snapshot = this.undoStack.pop();
    if (snapshot === undefined) return;
    this.lines = snapshot.textBefore.split("\n");
    if (snapshot.textBefore !== snapshot.textAfter) this.contentVersion++;
    // Vim restores the cursor saved when the change began, clamped to a
    // normal-mode cell of the restored text (an undone append from the end of
    // a line lands on its last character).
    this.setSelections(
      snapshot.selectionsBefore.map((selection) =>
        charwiseSelection(normalCursorPosition(this, selectionHead(selection)))
      )
    );
    this.redoStack.push(snapshot);
  }

  private redo(): void {
    this.finishUndoTransaction();
    const snapshot = this.redoStack.pop();
    if (snapshot === undefined) return;
    this.lines = snapshot.textAfter.split("\n");
    if (snapshot.textBefore !== snapshot.textAfter) this.contentVersion++;
    // Vim `u_redo`: the cursor is put at the start of the redone change, not
    // where the cursor sat when the change finished.
    const changeStart = firstDifferencePosition(
      snapshot.textBefore,
      snapshot.textAfter
    );
    this.setSelections(
      changeStart !== undefined
        ? [charwiseSelection(normalCursorPosition(this, changeStart))]
        : snapshot.selectionsAfter.map((selection) =>
            charwiseSelection(
              normalCursorPosition(this, selectionHead(selection))
            )
          )
    );
    this.undoStack.push(snapshot);
  }

  private modelRowSelections(
    direction: HostDirection,
    count: number,
    { extend }: { extend: boolean },
    clampRow: (row: number) => number = (row) => row
  ): readonly VimSelection[] {
    return this.selections.map((selection) => {
      const head = selection.cursor ?? selectionHead(selection);
      const goal =
        selection.goal ??
        modelGoalForHead(head, {
          extend:
            extend &&
            selection.type === "charwise" &&
            selection.cursor !== undefined,
        });
      const rowDelta = direction === "up" ? -count : count;
      const row = clampRow(
        Math.max(0, Math.min(head.row + rowDelta, this.lineCount() - 1))
      );
      const next = normalCursorPosition(this, {
        row,
        column: modelColumnForGoal(this, row, goal),
      });
      if (extend) {
        switch (selection.type) {
          case "charwise":
            return {
              ...selection,
              head: exclusiveVisualHead(this, next),
              cursor: next,
              goal,
            };
          case "linewise":
            return {
              ...selection,
              headLine: next.row,
              cursor: next,
              goal,
            };
          case "blockwise":
            return {
              ...selection,
              head: next,
              cursor: next,
              goal,
            };
        }
      }
      return { ...charwiseSelection(next), goal };
    });
  }

  private replace(range: TextRange, text: string): void {
    const ordered = orderedRange(
      clipPosition(this, range.start),
      clipPosition(this, range.end)
    );
    for (const tracker of this.lineTrackers) tracker.applyChange({ range: ordered, text });
    if (this.getText(ordered) !== text) this.contentVersion++;
    const before = this.line(ordered.start.row).slice(0, ordered.start.column);
    const after = this.line(ordered.end.row).slice(ordered.end.column);
    const replacementLines = (before + text + after).split("\n");
    this.lines.splice(
      ordered.start.row,
      ordered.end.row - ordered.start.row + 1,
      ...replacementLines
    );
  }
}

// Position (in [after]) of the first character where the two texts differ, or
// undefined when the texts are equal.
// Character/word steps for the in-memory default-handler simulation
// ([InMemoryVimEditor.replayInsertKey]). Word boundaries are a deliberate
// simplification of VSCode's word rules (whitespace-delimited): only the test
// double uses them, and the real editor runs VSCode's own commands.
function characterLeft(
  editor: VimEditorCapabilities,
  head: Position
): Position {
  if (head.column > 0) return { row: head.row, column: head.column - 1 };
  if (head.row > 0)
    return { row: head.row - 1, column: editor.lineLength(head.row - 1) };
  return head;
}

function characterRight(
  editor: VimEditorCapabilities,
  head: Position
): Position {
  if (head.column < editor.lineLength(head.row))
    return { row: head.row, column: head.column + 1 };
  if (head.row < editor.lineCount() - 1)
    return { row: head.row + 1, column: 0 };
  return head;
}

function simulatedWordLeft(
  editor: VimEditorCapabilities,
  head: Position
): Position {
  if (head.column === 0) return characterLeft(editor, head);
  const line = editor.line(head.row);
  let column = head.column;
  while (column > 0 && /\s/.test(line[column - 1])) column--;
  while (column > 0 && !/\s/.test(line[column - 1])) column--;
  return { row: head.row, column };
}

function simulatedWordRight(
  editor: VimEditorCapabilities,
  head: Position
): Position {
  const line = editor.line(head.row);
  if (head.column >= line.length) return characterRight(editor, head);
  let column = head.column;
  while (column < line.length && /\s/.test(line[column])) column++;
  while (column < line.length && !/\s/.test(line[column])) column++;
  return { row: head.row, column };
}

function firstDifferencePosition(
  before: string,
  after: string
): Position | undefined {
  if (before === after) return undefined;
  const limit = Math.min(before.length, after.length);
  let offset = 0;
  while (offset < limit && before[offset] === after[offset]) offset++;
  const prefix = after.slice(0, offset);
  const row = prefix.split("\n").length - 1;
  const column = offset - (row === 0 ? 0 : prefix.lastIndexOf("\n") + 1);
  return { row, column };
}

function cloneSelections(selections: readonly VimSelection[]): VimSelection[] {
  return selections.map(cloneSelection);
}

function cloneSelection(selection: VimSelection): VimSelection {
  switch (selection.type) {
    case "charwise":
      return {
        ...selection,
        anchor: { ...selection.anchor },
        head: { ...selection.head },
        cursor:
          selection.cursor === undefined ? undefined : { ...selection.cursor },
        goal: selection.goal === undefined ? undefined : { ...selection.goal },
      };
    case "linewise":
      return {
        ...selection,
        cursor:
          selection.cursor === undefined ? undefined : { ...selection.cursor },
        goal: selection.goal === undefined ? undefined : { ...selection.goal },
      };
    case "blockwise":
      return {
        ...selection,
        anchor: { ...selection.anchor },
        head: { ...selection.head },
        cursor:
          selection.cursor === undefined ? undefined : { ...selection.cursor },
        goal: selection.goal === undefined ? undefined : { ...selection.goal },
      };
  }
}

function selectionsEqual(
  a: readonly VimSelection[],
  b: readonly VimSelection[]
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function modelGoalForHead(
  head: Position,
  { extend }: { extend: boolean }
): VimSelectionGoal {
  return {
    type: "modelColumn",
    column: extend ? head.column + 1 : head.column,
  };
}

function modelColumnForGoal(
  editor: VimEditorCapabilities,
  row: number,
  goal: VimSelectionGoal
): number {
  const maxColumn = Math.max(0, editor.lineLength(row) - 1);
  switch (goal.type) {
    case "endOfLine":
      return maxColumn;
    case "modelColumn":
      return Math.min(goal.column, maxColumn);
    case "viewColumn":
      // View-column goals are 1-based VSCode view coordinates; convert to the
      // 0-based model column (approximate under soft wraps/folds).
      return Math.max(0, Math.min(goal.column - 1, maxColumn));
  }
}

function offsetOfPosition(
  editor: VimEditorCapabilities,
  pos: Position
): number {
  let offset = 0;
  for (let row = 0; row < pos.row; row++) offset += editor.lineLength(row) + 1;
  return offset + pos.column;
}
