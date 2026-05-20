// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/vim.rs, crates/vim/src/test/vim_test_context.rs
// - translated concepts: editor operations are mediated through a testable host interface
// - intentional differences: VSCode and fake editors implement this capability interface directly

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
import { SearchDirection, SearchMatch, SearchOptions, findSearchMatchInText } from "./search.js";

export type HostCommand = "navigateBack" | "navigateForward" | "undo" | "redo";
export type HostDirection = "up" | "down";
export type HostRevealTarget = "top" | "center" | "bottom";
export type HostFoldCommand = "toggle" | "open" | "close" | "openRecursive" | "closeRecursive" | "openAll" | "closeAll";
export type ApplyEditsOptions = {
  selectionsBefore?: readonly VimSelection[];
  undoStopBefore?: boolean;
  undoStopAfter?: boolean;
};

export type NativeCommandOptions = {
  preserveVisualSelection?: boolean;
};

// Most Vim edits are complete commands and should become one native undo unit.
// Change-like commands ([c], [s], visual [c], etc.) first delete text and then
// enter insert/replace mode; use [keepUndoTransactionOpen] for the deletion half
// and call [finishUndoTransaction] when Escape leaves insert/replace mode.
export function keepUndoTransactionOpen(options: ApplyEditsOptions = {}): ApplyEditsOptions {
  return { ...options, undoStopAfter: false };
}

// Zed: `vim::Vim::update_editor` is the closest
// equivalent boundary, but it closes over Zed's concrete `Editor`. This interface
// is intentionally local: production VSCode and fake tests both implement it.
export interface VimEditorCapabilities {
  lineCount(): number;
  line(row: number): string;
  lineLength(row: number): number;
  getText(range?: TextRange): string;

  getSelections(): readonly VimSelection[];
  setSelections(selections: readonly VimSelection[]): void;
  setCursorStyle(style: CursorStyle): void;

  applyEdits(edits: readonly TextEdit[], selectionsAfter: readonly VimSelection[], options?: ApplyEditsOptions): void;
  finishUndoTransaction(): void;

  executeHostCommand(command: HostCommand): void;
  executeNativeCommand(command: string, args?: readonly unknown[], options?: NativeCommandOptions): void;
  isExecutingNativeCommand?(): boolean;
  revealPrimaryCursorIfOutsideViewport(): void;
  revealCurrentLine(target: HostRevealTarget): void;
  executeFoldCommand(command: HostFoldCommand): void;
  moveByViewLines(direction: HostDirection, count: number, options: { displayLine: boolean; extend: boolean }): readonly VimSelection[] | undefined;
  moveByPages(direction: HostDirection, count: number, options: { halfPage: boolean; extend: boolean }): readonly VimSelection[] | undefined;
  scrollByLines(direction: HostDirection, count: number): void;

  // Zed: `normal::search` integrates with `BufferSearchBar` so search motions,
  // highlights, and find-widget state share one source of truth. Locally, the
  // fake editor implements this as a model-buffer query while VSCode backs it
  // with the native find controller/model.
  updateSearch(query: string, direction: SearchDirection, options?: SearchOptions): void;
  findSearchMatch(query: string, start: Position, direction: SearchDirection, options?: SearchOptions): SearchMatch | undefined;
  clearSearchHighlights(): void;
}

// Zed: clipping is usually handled by display-map/editor helpers such as
// `DisplaySnapshot::clip_point` / display-map helpers, for example in
// `normal::delete::Vim::delete_motion`.
export function clipPosition(editor: VimEditorCapabilities, pos: Position): Position {
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
  const lineLength = editor.lineLength(clipped.row);
  if (lineLength === 0) return { row: clipped.row, column: 0 };
  return { row: clipped.row, column: Math.min(clipped.column, lineLength - 1) };
}

export function rangeText(editor: VimEditorCapabilities, range: TextRange): string {
  return editor.getText(range);
}

function exclusiveVisualHead(editor: VimEditorCapabilities, head: Position): Position {
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
  private selections: VimSelection[];
  private undoStack: UndoSnapshot[] = [];
  private redoStack: UndoSnapshot[] = [];
  private pendingUndoSnapshot: UndoSnapshot | undefined;
  public cursorStyle: CursorStyle = "block";
  public readonly nativeCommands: { command: string; args: readonly unknown[] }[] = [];

  constructor(text = "") {
    this.lines = text.split("\n");
    this.selections = [charwiseSelection(position(0, 0))];
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
      return this.line(ordered.start.row).slice(ordered.start.column, ordered.end.column);
    }

    const parts = [this.line(ordered.start.row).slice(ordered.start.column)];
    for (let row = ordered.start.row + 1; row < ordered.end.row; row++) {
      parts.push(this.line(row));
    }
    parts.push(this.line(ordered.end.row).slice(0, ordered.end.column));
    return parts.join("\n");
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
            anchorLine: clipPosition(this, position(selection.anchorLine, 0)).row,
            headLine: clipPosition(this, position(selection.headLine, 0)).row,
            cursor: selection.cursor === undefined ? undefined : clipPosition(this, selection.cursor),
          };
        case "blockwise":
          return {
            ...selection,
            anchor: clipPosition(this, selection.anchor),
            head: clipPosition(this, selection.head),
            cursor: selection.cursor === undefined ? undefined : clipPosition(this, selection.cursor),
          };
      }
    });
    if (this.pendingUndoSnapshot !== undefined) {
      this.pendingUndoSnapshot = {
        ...this.pendingUndoSnapshot,
        selectionsAfter: cloneSelections(this.selections),
      };
    }
  }

  setCursorStyle(style: CursorStyle): void {
    this.cursorStyle = style;
  }

  applyEdits(edits: readonly TextEdit[], selectionsAfter: readonly VimSelection[], options: ApplyEditsOptions = {}): void {
    const undoStopBefore = options.undoStopBefore ?? true;
    const undoStopAfter = options.undoStopAfter ?? true;
    if (undoStopBefore && this.pendingUndoSnapshot === undefined) this.finishUndoTransaction();

    const snapshotBefore = this.pendingUndoSnapshot;
    const textBefore = snapshotBefore?.textBefore ?? this.getText();
    const selectionsBefore = cloneSelections(snapshotBefore?.selectionsBefore ?? options.selectionsBefore ?? this.selections);
    const sortedEdits = [...edits].sort((a, b) => -comparePositions(a.range.start, b.range.start));
    for (const edit of sortedEdits) {
      this.replace(edit.range, edit.text);
    }
    this.setSelections(selectionsAfter);
    const textAfter = this.getText();
    const storedSelectionsAfter = cloneSelections(this.selections);
    if (textBefore !== textAfter || !selectionsEqual(selectionsBefore, storedSelectionsAfter)) {
      this.pendingUndoSnapshot = { textBefore, textAfter, selectionsBefore, selectionsAfter: storedSelectionsAfter };
      this.redoStack = [];
    }
    if (undoStopAfter && snapshotBefore === undefined) this.finishUndoTransaction();
  }

  finishUndoTransaction(): void {
    const snapshot = this.pendingUndoSnapshot;
    if (snapshot === undefined) return;
    this.pendingUndoSnapshot = undefined;
    if (snapshot.textBefore !== snapshot.textAfter || !selectionsEqual(snapshot.selectionsBefore, snapshot.selectionsAfter)) {
      this.undoStack.push(snapshot);
    }
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

  executeNativeCommand(command: string, args: readonly unknown[] = [], _options: NativeCommandOptions = {}): void {
    this.nativeCommands.push({ command, args });
  }

  revealPrimaryCursorIfOutsideViewport(): void {}

  revealCurrentLine(_target: HostRevealTarget): void {}

  executeFoldCommand(_command: HostFoldCommand): void {}

  moveByViewLines(direction: HostDirection, count: number, { extend }: { displayLine: boolean; extend: boolean }): readonly VimSelection[] | undefined {
    // The in-memory editor has no VSCode view model, hidden ranges, or soft-wrap data.
    // Use a deliberately naive model-row approximation for non-extending movements so
    // host-motion callers such as [dj] are testable without a real VSCode instance.
    // Extending visual selections keep the core fallback because Vim's inclusive visual
    // semantics are richer than this fake host can approximate faithfully.
    if (extend) return undefined;
    return this.modelRowSelections(direction, count, { extend });
  }

  moveByPages(direction: HostDirection, count: number, { halfPage, extend }: { halfPage: boolean; extend: boolean }): readonly VimSelection[] {
    const pageSize = Math.max(1, Math.floor(this.lineCount() / (halfPage ? 2 : 1)));
    return this.modelRowSelections(direction, count * pageSize, { extend });
  }

  scrollByLines(_direction: HostDirection, _count: number): void {}

  updateSearch(_query: string, _direction: SearchDirection, _options: SearchOptions = {}): void {}

  findSearchMatch(query: string, start: Position, direction: SearchDirection, options: SearchOptions = {}): SearchMatch | undefined {
    return findSearchMatchInText(this.getText(), query, offsetOfPosition(this, start), direction, options)?.range;
  }

  clearSearchHighlights(): void {}

  private undo(): void {
    this.finishUndoTransaction();
    const snapshot = this.undoStack.pop();
    if (snapshot === undefined) return;
    this.lines = snapshot.textBefore.split("\n");
    this.setSelections(snapshot.selectionsBefore);
    this.redoStack.push(snapshot);
  }

  private redo(): void {
    this.finishUndoTransaction();
    const snapshot = this.redoStack.pop();
    if (snapshot === undefined) return;
    this.lines = snapshot.textAfter.split("\n");
    this.setSelections(snapshot.selectionsAfter);
    this.undoStack.push(snapshot);
  }

  private modelRowSelections(direction: HostDirection, count: number, { extend }: { extend: boolean }): readonly VimSelection[] {
    return this.selections.map(selection => {
      const head = selection.cursor ?? selectionHead(selection);
      const goal = selection.goal ?? modelGoalForHead(head, { extend: extend && selection.type === "charwise" && selection.cursor !== undefined });
      const rowDelta = direction === "up" ? -count : count;
      const row = Math.max(0, Math.min(head.row + rowDelta, this.lineCount() - 1));
      const next = normalCursorPosition(this, { row, column: modelColumnForGoal(this, row, goal) });
      if (extend && selection.type === "charwise") {
        return {
          ...selection,
          head: exclusiveVisualHead(this, next),
          cursor: next,
          goal,
        };
      }
      return { ...charwiseSelection(next), goal };
    });
  }

  private replace(range: TextRange, text: string): void {
    const ordered = orderedRange(clipPosition(this, range.start), clipPosition(this, range.end));
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
        cursor: selection.cursor === undefined ? undefined : { ...selection.cursor },
        goal: selection.goal === undefined ? undefined : { ...selection.goal },
      };
    case "linewise":
      return {
        ...selection,
        cursor: selection.cursor === undefined ? undefined : { ...selection.cursor },
        goal: selection.goal === undefined ? undefined : { ...selection.goal },
      };
    case "blockwise":
      return {
        ...selection,
        anchor: { ...selection.anchor },
        head: { ...selection.head },
        cursor: selection.cursor === undefined ? undefined : { ...selection.cursor },
        goal: selection.goal === undefined ? undefined : { ...selection.goal },
      };
  }
}

function selectionsEqual(a: readonly VimSelection[], b: readonly VimSelection[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function modelGoalForHead(head: Position, { extend }: { extend: boolean }): VimSelectionGoal {
  return { type: "modelColumn", column: extend ? head.column + 1 : head.column };
}

function modelColumnForGoal(editor: VimEditorCapabilities, row: number, goal: VimSelectionGoal): number {
  const maxColumn = Math.max(0, editor.lineLength(row) - 1);
  switch (goal.type) {
    case "endOfLine":
      return maxColumn;
    case "modelColumn":
    case "viewColumn":
      return Math.min(goal.column, maxColumn);
  }
}

function offsetOfPosition(editor: VimEditorCapabilities, pos: Position): number {
  let offset = 0;
  for (let row = 0; row < pos.row; row++) offset += editor.lineLength(row) + 1;
  return offset + pos.column;
}
