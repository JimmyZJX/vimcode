// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/state.rs, crates/vim/src/visual.rs
// - translated concepts: explicit modes, semantic operators, Vim-shaped selections
// - intentional differences: this file is a VSCode-oriented core vocabulary, not a GPUI/Zed type port

export type Position = {
  row: number;
  column: number;
};

export type TextRange = {
  start: Position;
  end: Position;
};

// Zed: `SelectionGoal`. Vertical motions carry a horizontal goal separately from
// the clipped cursor position, so moving through short lines can return to the
// intended column on longer lines. `modelColumn` is used by the model-buffer core,
// `viewColumn` by the VSCode view-model adapter, and `endOfLine` mirrors Zed's
// `HorizontalPosition(f64::INFINITY)` behavior for `$`.
export type VimSelectionGoal =
  | { type: "modelColumn"; column: number }
  | { type: "viewColumn"; column: number }
  | { type: "endOfLine" };

// Zed: `state::RecordedSelection` and `visual` module selection handling.
// This is a local
// normalized selection model; Zed stores concrete editor selections plus visual
// mode state instead of this exact union.
export type VimSelection =
  | { type: "charwise"; anchor: Position; head: Position; cursor?: Position; goal?: VimSelectionGoal }
  | { type: "linewise"; anchorLine: number; headLine: number; cursor?: Position; goal?: VimSelectionGoal }
  | { type: "blockwise"; anchor: Position; head: Position; cursor?: Position; goal?: VimSelectionGoal };

export type VimDialect = "vim" | "helix";

// Zed: `state::Mode`. We keep the same conceptual modes
// but add an explicit `dialect` field so Vim and Helix can share core primitives.
export type VimMode =
  | { dialect: VimDialect; kind: "normal" }
  | { dialect: VimDialect; kind: "insert" }
  | { dialect: VimDialect; kind: "replace" }
  | { dialect: VimDialect; kind: "search" }
  | { dialect: VimDialect; kind: "command" }
  | { dialect: VimDialect; kind: "visual" }
  | { dialect: VimDialect; kind: "visualLine" }
  | { dialect: VimDialect; kind: "visualBlock" }
  | { dialect: "helix"; kind: "select" };

// Zed: `state::Operator`. This first slice only carries
// the operator variants needed by the basic vertical slice.
export type Operator = "delete" | "change" | "yank";

// Local adapter boundary type. Zed applies edits through `editor.transact` and
// `editor.change_selections` in modules such as crates/vim/src/normal/delete.rs.
export type TextEdit = {
  range: TextRange;
  text: string;
};

export type CursorStyle = "block" | "line" | "underline";

export type KeyResult = "handled" | "not-handled";

export function isVisualModeKind(kind: VimMode["kind"]): kind is "visual" | "visualLine" | "visualBlock" {
  return kind === "visual" || kind === "visualLine" || kind === "visualBlock";
}

export function position(row: number, column: number): Position {
  return { row, column };
}

export function comparePositions(a: Position, b: Position): number {
  return a.row === b.row ? a.column - b.column : a.row - b.row;
}

export function samePosition(a: Position, b: Position): boolean {
  return a.row === b.row && a.column === b.column;
}

export function orderedRange(anchor: Position, head: Position): TextRange {
  return comparePositions(anchor, head) <= 0
    ? { start: anchor, end: head }
    : { start: head, end: anchor };
}

export function charwiseSelection(head: Position): VimSelection {
  return { type: "charwise", anchor: head, head };
}

export function selectionHead(selection: VimSelection): Position {
  switch (selection.type) {
    case "charwise":
    case "blockwise":
      return selection.head;
    case "linewise":
      return { row: selection.headLine, column: 0 };
  }
}

export function selectionAnchor(selection: VimSelection): Position {
  switch (selection.type) {
    case "charwise":
    case "blockwise":
      return selection.anchor;
    case "linewise":
      return { row: selection.anchorLine, column: 0 };
  }
}

export function rangeOfSelection(selection: VimSelection): TextRange {
  switch (selection.type) {
    case "charwise":
      return orderedRange(selection.anchor, selection.head);
    case "linewise": {
      const startLine = Math.min(selection.anchorLine, selection.headLine);
      const endLine = Math.max(selection.anchorLine, selection.headLine) + 1;
      return {
        start: { row: startLine, column: 0 },
        end: { row: endLine, column: 0 },
      };
    }
    case "blockwise":
      return orderedRange(selection.anchor, selection.head);
  }
}
