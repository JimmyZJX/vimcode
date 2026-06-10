// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/vim.rs, crates/vim/src/visual.rs
// - translated concepts: editor selections are the source of truth for visual
//   geometry; Vim mode state is reconciled with editor selection state at the
//   editor boundary.
// - intentional differences: VSCode has lossy native selections and a patched
//   render-cursor channel, so this module only decides the core mode/selection
//   shape. The adapter still owns lowering/rendering details.

import { VimMode, VimSelection, charwiseSelection, comparePositions, rangeOfSelection, selectionHead } from "./state.js";

export type EditorCursorState = {
  selections: readonly VimSelection[];
};

export type VimCursorState = {
  mode: VimMode;
  selections: readonly VimSelection[];
};

export type CursorReconciliation = {
  modeKind: "normal" | "visual";
  selections: readonly VimSelection[];
  selectionCount: number;
  visualSelectionFound: boolean;
  adoptedVisualSelection: boolean;
  reason: string;
};

export function reconcileCursorState(
  vscodeState: EditorCursorState,
  vimState: VimCursorState
): CursorReconciliation {
  // Minor mouse movement in normal mode produces a single one-character native
  // selection (the patched hit testing selects the character cell under the
  // pointer). Treat it as cursor placement on that character, not visual mode.
  const minorSelection = minorSingleCharacterSelection(vscodeState.selections, vimState.mode);
  if (minorSelection !== undefined) {
    return {
      modeKind: "normal",
      selections: [collapseToSelectedCharacterCursor(minorSelection)],
      selectionCount: vscodeState.selections.length,
      visualSelectionFound: false,
      adoptedVisualSelection: false,
      reason: "collapsed single-character selection in normal mode",
    };
  }

  const visualSelectionFound = hasNonEmptyCharwiseSelection(vscodeState.selections);
  if (visualSelectionFound) {
    return {
      modeKind: "visual",
      selections: vscodeState.selections,
      selectionCount: vscodeState.selections.length,
      visualSelectionFound,
      adoptedVisualSelection: true,
      reason: "adopted non-empty charwise selection",
    };
  }

  return {
    modeKind: "normal",
    selections: collapseSelectionsToNormalCursors(vscodeState.selections),
    selectionCount: vscodeState.selections.length,
    visualSelectionFound,
    adoptedVisualSelection: false,
    reason: "no non-empty charwise selection",
  };
}

export function hasNonEmptyCharwiseSelection(selections: readonly VimSelection[]): boolean {
  return selections.some(selection =>
    selection.type === "charwise"
    && comparePositions(selection.anchor, selection.head) !== 0);
}

function minorSingleCharacterSelection(
  selections: readonly VimSelection[],
  mode: VimMode
): Extract<VimSelection, { type: "charwise" }> | undefined {
  if (mode.kind !== "normal" || selections.length !== 1) return undefined;
  const selection = selections[0];
  if (selection?.type !== "charwise") return undefined;
  const range = rangeOfSelection(selection);
  const isSingleCharacter = range.start.row === range.end.row
    && range.end.column - range.start.column === 1;
  return isSingleCharacter ? selection : undefined;
}

// The single selected character is [range.start, range.end); parking the cursor
// on that character means using the range start, regardless of selection direction.
function collapseToSelectedCharacterCursor(
  selection: Extract<VimSelection, { type: "charwise" }>
): VimSelection {
  const collapsed = charwiseSelection(rangeOfSelection(selection).start);
  return selection.goal === undefined ? collapsed : { ...collapsed, goal: selection.goal };
}

export function hasMultipleCursorsOrSelection(selections: readonly VimSelection[]): boolean {
  return selections.length > 1 || selections.some(selection => {
    const range = rangeOfSelection(selection);
    return comparePositions(range.start, range.end) !== 0;
  });
}

export function isEditorOwnedCharwiseSelection(
  selection: VimSelection
): selection is Extract<VimSelection, { type: "charwise" }> {
  return selection.type === "charwise" && selection.cursor === undefined;
}

export function collapseSelectionsToNormalCursors(
  selections: readonly VimSelection[]
): readonly VimSelection[] {
  return selections.map(selection => {
    const collapsed = charwiseSelection(selectionHead(selection));
    return selection.goal === undefined ? collapsed : { ...collapsed, goal: selection.goal };
  });
}

export function collapseToPrimaryNormalCursor(
  selections: readonly VimSelection[]
): readonly VimSelection[] {
  const first = selections[0];
  return first === undefined ? [] : [charwiseSelection(selectionHead(first))];
}
