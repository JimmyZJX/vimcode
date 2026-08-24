// The `:g` mark transform (line_tracker.ts), pinned against the Neovim
// behaviors probed for `:g/pat/normal`: marks shift with insertions and
// deletions, and die when their line is deleted or merged away.
import { LineTracker } from "./line_tracker.js";

function change(
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
  text: string
) {
  return { range: { start: { row: startRow, column: startColumn }, end: { row: endRow, column: endColumn } }, text };
}

function rows(tracker: LineTracker, count: number): (number | undefined)[] {
  return Array.from({ length: count }, (_, index) => tracker.currentRow(index));
}

describe("LineTracker", () => {
  it("deleting a whole line kills its mark and shifts the marks below", () => {
    // dd on row 1 of {foo1, foo2, bar, foo3}: marks 0/1/3.
    const tracker = new LineTracker([0, 1, 3]);
    tracker.applyChange(change(1, 0, 2, 0, ""));
    expect(rows(tracker, 3)).toEqual([0, undefined, 2]);
  });

  it("deleting the last line through the preceding newline kills its mark", () => {
    // dd on the last line of {a, b}: the edit consumes a's trailing newline.
    const tracker = new LineTracker([0, 1]);
    tracker.applyChange(change(0, 1, 1, 1, ""));
    expect(rows(tracker, 2)).toEqual([0, undefined]);
  });

  it("a multi-line delete kills the marks inside and shifts the rest", () => {
    // dj on rows 0-1 of {m1, m2, x, m3}: marks 0/1/3.
    const tracker = new LineTracker([0, 1, 3]);
    tracker.applyChange(change(0, 0, 2, 0, ""));
    expect(rows(tracker, 3)).toEqual([undefined, undefined, 1]);
  });

  it("a delete reaching the end of the buffer kills the merged last line's mark", () => {
    // dG from row 1 of {m1, x, m2}: consumes rows 1-2 through row 0's newline.
    const tracker = new LineTracker([0, 2]);
    tracker.applyChange(change(0, 2, 2, 2, ""));
    expect(rows(tracker, 2)).toEqual([0, undefined]);
  });

  it("J kills the merged line's mark", () => {
    // J on row 0 of {x1, x2, y}: replaces the newline (and indent) with a space.
    const tracker = new LineTracker([0, 1]);
    tracker.applyChange(change(0, 2, 1, 0, " "));
    expect(rows(tracker, 2)).toEqual([0, undefined]);
  });

  it("opening a line below shifts only the marks underneath", () => {
    // o on row 0 of {a, b, a}: marks 0/2.
    const tracker = new LineTracker([0, 2]);
    tracker.applyChange(change(0, 1, 0, 1, "\nX"));
    expect(rows(tracker, 2)).toEqual([0, 3]);
  });

  it("inserting whole lines above a mark shifts it down", () => {
    // O (or a linewise put) above row 1 of {a, b}.
    const tracker = new LineTracker([0, 1]);
    tracker.applyChange(change(1, 0, 1, 1, "X\n"));
    expect(rows(tracker, 2)).toEqual([0, 2]);
  });

  it("edits within a line leave its mark in place", () => {
    // cc on row 0 of {x a, x b}: marks 0/1.
    const tracker = new LineTracker([0, 1]);
    tracker.applyChange(change(0, 0, 0, 3, "Y"));
    expect(rows(tracker, 2)).toEqual([0, 1]);
  });

  it("a same-line replacement splitting the line shifts the marks below", () => {
    // :s/x/a\rb/ on row 0.
    const tracker = new LineTracker([0, 1]);
    tracker.applyChange(change(0, 0, 0, 3, "a\nb"));
    expect(rows(tracker, 2)).toEqual([0, 2]);
  });

  it("applies batched descending edits sequentially", () => {
    // Two single-line deletes applied bottom-up (deleteMatchingRows order).
    const tracker = new LineTracker([1, 3, 4]);
    tracker.applyChange(change(3, 0, 4, 0, ""));
    tracker.applyChange(change(1, 0, 2, 0, ""));
    expect(rows(tracker, 3)).toEqual([undefined, undefined, 2]);
  });
});
