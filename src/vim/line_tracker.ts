// Vim reference (`:h :global`, `:h mark-motions`): `:g` runs in two passes —
// mark every matching line, then execute the command per mark. Marks shift as
// earlier iterations add or remove lines, and "every deleted line also deletes
// the marks in it". This module is the host-agnostic mark bookkeeping; each
// editor implementation feeds it the buffer changes it observes (see
// [VimEditorCapabilities.trackLines]).

import { TextRange } from "./state.js";

/** A buffer change replacing [range] (pre-change coordinates, ordered) with
    [text]. */
export type LineChange = { range: TextRange; text: string };

export type TrackedLines = {
  /** Current row of the [index]-th tracked line, or undefined once the line
      was deleted (its `:g` iteration is skipped). */
  currentRow(index: number): number | undefined;
  dispose(): void;
};

// The per-change transform is pinned against Neovim probes:
// - lines below a change shift by its net line delta (`:g/a/norm oX`);
// - a line deleted whole (`dd`) or together with its neighbors (`dj`, `dG`)
//   loses its mark;
// - a line merged into an earlier one (`J`, charwise multi-line deletes)
//   loses its mark too;
// - edits within a single line (`cc`, `:s`) leave its mark in place.
export class LineTracker {
  private rows: (number | undefined)[];

  constructor(rows: readonly number[]) {
    this.rows = [...rows];
  }

  currentRow(index: number): number | undefined {
    return this.rows[index];
  }

  applyChange(change: LineChange): void {
    this.rows = this.rows.map(row => row === undefined ? undefined : transformRow(row, change));
  }
}

function transformRow(row: number, { range: { start, end }, text }: LineChange): number | undefined {
  const insertedLines = countNewlines(text);
  const delta = start.row + insertedLines - end.row;
  if (row < start.row) return row;
  if (row > end.row) return row + delta;
  if (start.row === end.row) {
    // Same-line change. Whole lines inserted at the line's head (`O`, `P`
    // linewise) push it down; any other edit stays within the line.
    return start.column === 0 && text.endsWith("\n") ? row + insertedLines : row;
  }
  if (row === start.row) {
    // A multi-line deletion starting at column 0 (`dd`, `dj`) removes this
    // line; other multi-line changes keep its head in place (`J`).
    return start.column === 0 && text.length === 0 ? undefined : row;
  }
  if (row === end.row) {
    // The change's last line survives when its content was not consumed: the
    // range ends before its first character and any replacement text ends at
    // a line boundary (the `dd` full-line shape). Otherwise its remainder
    // merged into an earlier line and the mark dies (`J`, `dG`).
    const untouched = end.column === 0 && (text.length === 0 || text.endsWith("\n"));
    return untouched ? row + delta : undefined;
  }
  // Strictly inside the replaced range: the line is gone.
  return undefined;
}

function countNewlines(text: string): number {
  let count = 0;
  for (const char of text) {
    if (char === "\n") count++;
  }
  return count;
}
