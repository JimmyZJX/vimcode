import {
  CharacterCellEditor,
  canonicalVimSelection,
  canonicalizationChangesMeaning,
  characterCellEnd,
  charwiseRenderCursor,
  lowerCharwiseGeometry,
  previousCharacterCell,
  raiseCharwiseSelection,
  CharwiseGeometry,
  CharwiseSelection,
} from "./selection_geometry.js";
import { Position, VimSelection, comparePositions } from "./state.js";

function editorOf(lines: readonly string[]): CharacterCellEditor {
  return {
    line: row => lines[row] ?? "",
    lineLength: row => lines[row]?.length ?? 0,
    lineCount: () => lines.length,
  };
}

const lines = ["abc", "", "xy"] as const;
const editor = editorOf(lines);

function characterCells(): Position[] {
  const cells: Position[] = [];
  for (let row = 0; row < lines.length; row++) {
    for (let column = 0; column < Math.max(1, lines[row].length); column++) {
      cells.push({ row, column });
    }
  }
  return cells;
}

function boundaries(): Position[] {
  const positions: Position[] = [];
  for (let row = 0; row < lines.length; row++) {
    for (let column = 0; column <= lines[row].length; column++) {
      positions.push({ row, column });
    }
  }
  return positions;
}

function charwise(anchor: Position, head: Position, cursor?: Position): CharwiseSelection {
  return cursor === undefined
    ? { type: "charwise", anchor, head }
    : { type: "charwise", anchor, head, cursor };
}

describe("selection_geometry", () => {
  it("raise(lower(geometry)) is the identity on real character cells", () => {
    for (const anchor of characterCells()) {
      for (const head of characterCells()) {
        // A backward selection anchored on an empty line lowers to an empty
        // anchor extent (Neovim-verified empty-line behavior), which cannot be
        // distinguished from a plain boundary when raising again.
        if (comparePositions(head, anchor) < 0 && lines[anchor.row].length === 0) continue;
        const geometry: CharwiseGeometry = { anchor, head };
        expect(raiseCharwiseSelection(editor, lowerCharwiseGeometry(editor, geometry))).toEqual(geometry);
      }
    }
  });

  it("lower(raise(selection)) preserves non-empty native ranges with interior endpoints", () => {
    for (const anchor of boundaries()) {
      for (const head of boundaries()) {
        if (comparePositions(anchor, head) === 0) continue;
        // Endpoints at column 0 cross a line boundary; those normalize (see below).
        const range = [anchor, head].sort(comparePositions);
        if (range[1].column === 0) continue;
        const selection = charwise(anchor, head);
        const lowered = lowerCharwiseGeometry(editor, raiseCharwiseSelection(editor, selection));
        const loweredRange = [lowered.anchor, lowered.head].sort(comparePositions);
        expect(loweredRange).toEqual(range);
        // Direction is preserved for selections spanning more than one cell;
        // single-cell selections normalize to forward (the cursor cell is the
        // anchor cell, so direction is meaningless in Vim terms).
        if (comparePositions(raiseCharwiseSelection(editor, selection).anchor, raiseCharwiseSelection(editor, selection).head) !== 0) {
          expect(comparePositions(lowered.anchor, lowered.head) < 0)
            .toBe(comparePositions(anchor, head) < 0);
        }
      }
    }
  });

  it("normalizes a selection ending at column 0 to the previous line's end boundary", () => {
    // Native [0:1 .. 1:0] includes "bc\n"; the inclusive head cell is "c", so the
    // canonical exclusive end is the end of line 0, dropping only the newline.
    const lowered = lowerCharwiseGeometry(
      editor,
      raiseCharwiseSelection(editor, charwise({ row: 0, column: 1 }, { row: 1, column: 0 }))
    );
    expect(lowered.anchor).toEqual({ row: 0, column: 1 });
    expect(lowered.head).toEqual({ row: 0, column: 3 });
    expect(lowered.cursor).toEqual({ row: 0, column: 2 });
  });

  it("canonicalVimSelection is idempotent away from line-crossing endpoints", () => {
    for (const anchor of boundaries()) {
      for (const head of boundaries()) {
        if (anchor.column === 0 || head.column === 0) continue;
        const selection = charwise(anchor, head);
        const once = canonicalVimSelection(editor, selection);
        expect(canonicalVimSelection(editor, once)).toEqual(once);
      }
    }
  });

  it("canonicalVimSelection converges for every boundary pair", () => {
    // Selections whose endpoints cross line boundaries (newline-only spans,
    // empty-line anchors) normalize over at most a couple of steps; external
    // write-back never loops because vim-sourced selection events are ignored,
    // but canonicalization must still reach a fixed point.
    for (const anchor of boundaries()) {
      for (const head of boundaries()) {
        let selection = charwise(anchor, head);
        for (let step = 0; step < 3; step++) selection = canonicalVimSelection(editor, selection) as CharwiseSelection;
        expect(canonicalVimSelection(editor, selection)).toEqual(selection);
      }
    }
  });

  it("canonicalVimSelection attaches the cursor cell without changing interior ranges", () => {
    const forward = canonicalVimSelection(editor, charwise({ row: 0, column: 1 }, { row: 0, column: 3 }));
    expect(forward).toEqual({
      type: "charwise",
      anchor: { row: 0, column: 1 },
      head: { row: 0, column: 3 },
      cursor: { row: 0, column: 2 },
      goal: undefined,
    });

    const backward = canonicalVimSelection(editor, charwise({ row: 0, column: 3 }, { row: 0, column: 1 }));
    expect(backward).toEqual({
      type: "charwise",
      anchor: { row: 0, column: 3 },
      head: { row: 0, column: 1 },
      cursor: { row: 0, column: 1 },
      goal: undefined,
    });
  });

  it("preserves direction for single-cell backward selections", () => {
    // Like Neovim: anchor and active are not swapped unless the selection is
    // actually extended backwards.
    const backward = canonicalVimSelection(editor, charwise({ row: 0, column: 2 }, { row: 0, column: 1 }));
    expect(backward).toEqual({
      type: "charwise",
      anchor: { row: 0, column: 2 },
      head: { row: 0, column: 1 },
      cursor: { row: 0, column: 1 },
      goal: undefined,
    });
  });

  it("treats boundary re-encodings as meaning-preserving", () => {
    // A full-line selection ending at the next line start raises to the same
    // geometry as one ending at the end of the line.
    expect(canonicalizationChangesMeaning(editor, charwise({ row: 0, column: 0 }, { row: 1, column: 0 })))
      .toBe(false);
    // Canonical and direction-preserved shapes are untouched as well.
    expect(canonicalizationChangesMeaning(editor, charwise({ row: 0, column: 1 }, { row: 0, column: 3 })))
      .toBe(false);
    expect(canonicalizationChangesMeaning(editor, charwise({ row: 0, column: 2 }, { row: 0, column: 1 })))
      .toBe(false);
    // A backward selection anchored just past an empty line genuinely changes
    // meaning when canonicalized.
    expect(canonicalizationChangesMeaning(editor, charwise({ row: 2, column: 0 }, { row: 0, column: 0 })))
      .toBe(true);
  });

  it("passes empty and non-charwise selections through unchanged", () => {
    const empty = charwise({ row: 0, column: 1 }, { row: 0, column: 1 });
    expect(canonicalVimSelection(editor, empty)).toBe(empty);

    const linewise: VimSelection = { type: "linewise", anchorLine: 0, headLine: 1 };
    expect(canonicalVimSelection(editor, linewise)).toBe(linewise);
  });

  it("honors explicit cursor metadata when raising", () => {
    const raised = raiseCharwiseSelection(
      editor,
      charwise({ row: 0, column: 0 }, { row: 0, column: 3 }, { row: 0, column: 2 })
    );
    expect(raised).toEqual({ anchor: { row: 0, column: 0 }, head: { row: 0, column: 2 }, goal: undefined });
  });

  it("computes render cursor cells for selections without metadata", () => {
    expect(charwiseRenderCursor(editor, charwise({ row: 0, column: 0 }, { row: 0, column: 2 })))
      .toEqual({ row: 0, column: 1 });
    expect(charwiseRenderCursor(editor, charwise({ row: 0, column: 2 }, { row: 0, column: 0 })))
      .toEqual({ row: 0, column: 0 });
    expect(charwiseRenderCursor(editor, charwise({ row: 0, column: 1 }, { row: 0, column: 1 })))
      .toEqual({ row: 0, column: 1 });
  });

  it("wraps the end-of-line cell past the newline and clamps at buffer edges", () => {
    expect(characterCellEnd(editor, { row: 0, column: 3 })).toEqual({ row: 1, column: 0 });
    expect(characterCellEnd(editor, { row: 1, column: 0 })).toEqual({ row: 1, column: 0 });
    expect(characterCellEnd(editor, { row: 2, column: 2 })).toEqual({ row: 2, column: 2 });
    expect(previousCharacterCell(editor, { row: 0, column: 0 })).toEqual({ row: 0, column: 0 });
    expect(previousCharacterCell(editor, { row: 1, column: 0 })).toEqual({ row: 0, column: 2 });
    expect(previousCharacterCell(editor, { row: 2, column: 0 })).toEqual({ row: 1, column: 0 });
  });
});
