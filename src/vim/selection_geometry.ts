// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/visual.rs (selection expansion around the inclusive Vim
//   cursor), crates/vim/src/vim.rs `vim::Vim::update_editor` selection handling.
// - translated concepts: Vim charwise visual selections are inclusive of the head
//   character cell, while the host editor stores boundary-based exclusive selections.
// - intentional differences: Zed's editor shares Vim's selection model, so it has no
//   boundary<->cell conversion layer. VSCode does, and this module is the single
//   owner of that conversion. Every raise (native -> Vim-inclusive) and lower
//   (Vim-inclusive -> native + cursor cell) must go through here so the convention
//   stays round-trippable: for non-empty charwise selections,
//   `lowerCharwiseGeometry(editor, raiseCharwiseSelection(editor, s))` preserves the
//   native range and direction of `s`.

import {
  Position,
  VimSelection,
  VimSelectionGoal,
  comparePositions,
  selectionHead,
} from "./state.js";

/** The minimal editor surface needed for cell arithmetic. */
export type CharacterCellEditor = {
  lineLength(row: number): number;
  lineCount(): number;
};

export type CharwiseSelection = Extract<VimSelection, { type: "charwise" }>;

/** Inclusive charwise visual geometry: both [anchor] and [head] are character
    cells inside the selection. This is the Vim-side shape of a charwise visual
    selection, mirroring `CharwiseVisualState` without the state-machine fields. */
export type CharwiseGeometry = {
  anchor: Position;
  head: Position;
  goal?: VimSelectionGoal;
};

/** The character cell that ends at boundary [position]: one cell to the left,
    wrapping to the last cell of the previous line at column 0. */
export function previousCharacterCell(editor: CharacterCellEditor, position: Position): Position {
  if (position.column > 0) return { row: position.row, column: position.column - 1 };
  if (position.row > 0) {
    return { row: position.row - 1, column: Math.max(0, editor.lineLength(position.row - 1) - 1) };
  }
  return position;
}

/** The boundary just after the character cell at [position]. On an empty line
    the cell and its end coincide (Neovim-verified: a visual cursor parked on an
    empty line selects nothing, not the newline). From the virtual end-of-line
    cell of a non-empty line the end wraps past the newline to the start of the
    next line. On the last line the end clamps to the cell itself. */
export function characterCellEnd(editor: CharacterCellEditor, position: Position): Position {
  const lineLength = editor.lineLength(position.row);
  if (lineLength === 0) return position;
  if (position.column < lineLength) return { row: position.row, column: position.column + 1 };
  if (position.row + 1 < editor.lineCount()) return { row: position.row + 1, column: 0 };
  return position;
}

/** Raise a native-shaped (boundary-based, exclusive) charwise selection to
    inclusive Vim geometry. When the selection carries an explicit [cursor] cell,
    that cell is authoritative for the head. */
export function raiseCharwiseSelection(
  editor: CharacterCellEditor,
  selection: CharwiseSelection
): CharwiseGeometry {
  if (selection.cursor !== undefined) {
    if (comparePositions(selection.cursor, selection.anchor) < 0) {
      return {
        anchor: previousCharacterCell(editor, selection.anchor),
        head: selection.cursor,
        goal: selection.goal,
      };
    }
    return { anchor: selection.anchor, head: selection.cursor, goal: selection.goal };
  }

  if (comparePositions(selection.anchor, selection.head) <= 0) {
    const head = previousCharacterCell(editor, selection.head);
    // A selection narrower than one real cell (e.g. covering only a newline)
    // collapses onto the head cell so raising stays a one-step normalization.
    const anchor = comparePositions(head, selection.anchor) < 0 ? head : selection.anchor;
    return { anchor, head, goal: selection.goal };
  }
  const anchor = previousCharacterCell(editor, selection.anchor);
  const head = comparePositions(anchor, selection.head) < 0 ? anchor : selection.head;
  return { anchor, head, goal: selection.goal };
}

/** Lower inclusive Vim geometry to the native exclusive selection shape, keeping
    the inclusive head cell as explicit [cursor] metadata. */
export function lowerCharwiseGeometry(
  editor: CharacterCellEditor,
  geometry: CharwiseGeometry
): CharwiseSelection {
  if (comparePositions(geometry.anchor, geometry.head) <= 0) {
    return {
      type: "charwise",
      anchor: geometry.anchor,
      head: characterCellEnd(editor, geometry.head),
      cursor: geometry.head,
      goal: geometry.goal,
    };
  }
  return {
    type: "charwise",
    anchor: characterCellEnd(editor, geometry.anchor),
    head: geometry.head,
    cursor: geometry.head,
    goal: geometry.goal,
  };
}

/** Canonicalize an externally produced selection: non-empty charwise selections
    get the equivalent canonical shape with explicit cursor-cell metadata; other
    selections pass through unchanged. Like Neovim, canonicalization does not
    swap anchor and active unless the selection actually extends backwards: when
    the canonical range collapses to a single cell, direction is meaningless in
    Vim terms, so the native direction is preserved. */
export function canonicalVimSelection(
  editor: CharacterCellEditor,
  selection: VimSelection
): VimSelection {
  if (selection.type !== "charwise") return selection;
  if (comparePositions(selection.anchor, selection.head) === 0) return selection;
  const lowered = lowerCharwiseGeometry(editor, raiseCharwiseSelection(editor, selection));
  if (comparePositions(selection.head, selection.anchor) < 0
    && comparePositions(lowered.anchor, lowered.head) < 0) {
    return { ...lowered, anchor: lowered.head, head: lowered.anchor };
  }
  return lowered;
}

/** Whether two selections have the same native shape: kind, endpoints, and
    direction. Vim-only metadata such as the cursor cell and goal column is
    ignored. */
export function sameNativeShape(a: VimSelection, b: VimSelection): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "linewise" || b.type === "linewise") {
    return a.type === "linewise" && b.type === "linewise"
      && a.anchorLine === b.anchorLine && a.headLine === b.headLine;
  }
  return comparePositions(a.anchor, b.anchor) === 0 && comparePositions(a.head, b.head) === 0;
}

/** Whether canonicalizing [selection] would change its Vim meaning — the raised
    inclusive geometry — rather than merely its boundary encoding or metadata.
    For example, a native full-line selection ending at the start of the next
    line and its canonical form ending at the end of the line raise to the same
    geometry, so rewriting it would be meaningless (and would destroy native
    gesture state such as a word/line drag anchor). */
export function canonicalizationChangesMeaning(
  editor: CharacterCellEditor,
  selection: VimSelection
): boolean {
  if (selection.type !== "charwise") return false;
  if (comparePositions(selection.anchor, selection.head) === 0) return false;
  const canonical = canonicalVimSelection(editor, selection);
  if (sameNativeShape(canonical, selection)) return false;
  const raisedCanonical = raiseCharwiseSelection(editor, canonical as CharwiseSelection);
  const raised = raiseCharwiseSelection(editor, selection);
  return comparePositions(raisedCanonical.anchor, raised.anchor) !== 0
    || comparePositions(raisedCanonical.head, raised.head) !== 0;
}

/** The character cell the block cursor should be rendered on for a charwise
    selection: the explicit cursor cell when present, the cell before the head
    boundary for forward selections, and the head itself otherwise. */
export function charwiseRenderCursor(
  editor: CharacterCellEditor,
  selection: CharwiseSelection
): Position {
  if (selection.cursor !== undefined) return selection.cursor;
  if (comparePositions(selection.anchor, selection.head) < 0) {
    return previousCharacterCell(editor, selection.head);
  }
  return selection.head;
}

/** Render cursor cell for any selection kind that does not carry its own cursor
    metadata. Linewise/blockwise lowering computes per-line cursors itself. */
export function renderCursorCell(editor: CharacterCellEditor, selection: VimSelection): Position {
  if (selection.type === "charwise") return charwiseRenderCursor(editor, selection);
  return selection.cursor ?? selectionHead(selection);
}
