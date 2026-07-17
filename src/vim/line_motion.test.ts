// Standalone line motions `G` / `+` / `-` migrated to the framework
// (lineMotionForKey in normal_mode_handler.ts). There is no Neovim fixture for a
// bare `G` key or for visual `+`/`-`/`G`, so these integration tests pin the
// behavior — including that the operator target path (`dG`) is unchanged.
import { InMemoryVimEditor, normalViewLineColumnForGoal } from "./editor.js";
import type { HostDirection } from "./editor.js";
import { Vim, runKeys } from "./vim.js";
import type { VimSelection } from "./state.js";
import { charwiseSelection, selectionHead } from "./state.js";

function head(editor: InMemoryVimEditor) {
  return selectionHead(editor.getSelections()[0]);
}
function cursor(editor: InMemoryVimEditor) {
  return (editor.getSelections()[0] as { cursor: { row: number; column: number } }).cursor;
}

class WrappedLineEditor extends InMemoryVimEditor {
  readonly verticalMoves: { direction: HostDirection; count: number; displayLine: boolean }[] = [];

  override moveByViewLines(
    direction: HostDirection,
    count: number,
    options: { displayLine: boolean; extend: boolean }
  ): readonly VimSelection[] | undefined {
    this.verticalMoves.push({ direction, count, displayLine: options.displayLine });
    // One display-line step remains on the same wrapped model line. Logical
    // movement crosses to the neighboring model line.
    return options.displayLine
      ? this.getSelections()
      : super.moveByViewLines(direction, count, options);
  }
}

class FoldAwareEditor extends InMemoryVimEditor {
  readonly verticalMoves: { direction: HostDirection; count: number; displayLine: boolean }[] = [];

  override moveByViewLines(
    direction: HostDirection,
    count: number,
    { displayLine }: { displayLine: boolean; extend: boolean }
  ): readonly VimSelection[] {
    this.verticalMoves.push({ direction, count, displayLine });
    const selection = this.getSelections()[0];
    const start = selectionHead(selection);
    let row = start.row;
    for (let step = 0; step < count; step++) {
      if (direction === "down") {
        row = row === 1 ? 4 : Math.min(row + 1, this.lineCount() - 1);
      } else {
        row = row === 4 ? 1 : Math.max(row - 1, 0);
      }
    }
    const column = Math.min(start.column, Math.max(0, this.lineLength(row) - 1));
    return [{
      ...charwiseSelection({ row, column }),
      goal: selection.goal ?? { type: "modelColumn", column: start.column },
    }];
  }
}


describe("line motions G / + / - via framework", () => {
  it("normal G goes to the last line (count -> line N), keeping the column", () => {
    const editor = new InMemoryVimEditor("abc\nxyz\npqr\ndef");
    const vim = new Vim(editor);
    runKeys(vim, ["l", "l"]); // col 2
    runKeys(vim, ["G"]);
    expect(head(editor)).toEqual({ row: 3, column: 2 }); // last line, column kept
    runKeys(vim, ["2", "G"]);
    expect(head(editor)).toEqual({ row: 1, column: 2 }); // line 2, column kept
  });

  it("normal + / - move to the first non-blank of the next/prev line (count-aware)", () => {
    const editor = new InMemoryVimEditor("one\n   two\nthree\nfour");
    const vim = new Vim(editor);
    // start at row 2 ("three")
    runKeys(vim, ["G", "k"]); // G->row3(four), k->row2(three)
    expect(head(editor).row).toBe(2);
    runKeys(vim, ["-"]);
    expect(head(editor)).toEqual({ row: 1, column: 3 }); // "   two" first non-blank
    runKeys(vim, ["-"]);
    expect(head(editor)).toEqual({ row: 0, column: 0 }); // "one"
    runKeys(vim, ["2", "+"]);
    expect(head(editor)).toEqual({ row: 2, column: 0 }); // 2 lines down -> "three"
  });

  it("visual G / + / - extend the selection and stay in visual", () => {
    const editor = new InMemoryVimEditor("a\nb\nc\nd");
    const vim = new Vim(editor);
    runKeys(vim, ["v", "G"]);
    expect(vim.modeName).toBe("vim:visual");
    expect(cursor(editor)).toEqual({ row: 3, column: 0 });
    runKeys(vim, ["-"]);
    expect(cursor(editor)).toEqual({ row: 2, column: 0 });
  });

  it("G / - move to the expected lines (framework-owned)", () => {
    // The legacy operator stack this test used to introspect is gone; assert
    // the motions' behavior directly.
    const editor = new InMemoryVimEditor("a\nb\nc");
    const vim = new Vim(editor);
    runKeys(vim, ["G"]);
    expect(head(editor)).toEqual({ row: 2, column: 0 });
    runKeys(vim, ["-"]);
    expect(head(editor)).toEqual({ row: 1, column: 0 });
  });

  it("dG still deletes linewise (operator path unchanged)", () => {
    const editor = new InMemoryVimEditor("a\nb\nc\nd");
    const vim = new Vim(editor);
    runKeys(vim, ["j"]); // row 1
    runKeys(vim, ["d", "G"]); // delete rows 1..3 linewise
    expect(editor.getText()).toBe("a");
  });

  it("enter moves to the first non-blank of the next line (count-aware)", () => {
    const editor = new InMemoryVimEditor("one\n   two\nthree\nfour");
    const vim = new Vim(editor);
    runKeys(vim, ["enter"]);
    expect(head(editor)).toEqual({ row: 1, column: 3 }); // "   two"
    runKeys(vim, ["2", "enter"]);
    expect(head(editor)).toEqual({ row: 3, column: 0 }); // 2 lines down -> "four"
  });

  it("visual enter extends the selection to the next line", () => {
    const editor = new InMemoryVimEditor("a\nb\nc");
    const vim = new Vim(editor);
    runKeys(vim, ["v", "enter"]);
    expect(vim.modeName).toBe("vim:visual");
    expect(cursor(editor)).toEqual({ row: 1, column: 0 });
  });

  it("| goes to the (1-based) column given by the count", () => {
    const editor = new InMemoryVimEditor("hello world");
    const vim = new Vim(editor);
    runKeys(vim, ["l", "l"]); // col 2
    runKeys(vim, ["|"]);
    expect(head(editor)).toEqual({ row: 0, column: 0 }); // no count -> column 1
    runKeys(vim, ["5", "|"]);
    expect(head(editor)).toEqual({ row: 0, column: 4 }); // column 5
  });

  it("visual | extends the selection to the column", () => {
    const editor = new InMemoryVimEditor("hello world");
    const vim = new Vim(editor);
    runKeys(vim, ["v", "5", "|"]);
    expect(vim.modeName).toBe("vim:visual");
    expect(cursor(editor)).toEqual({ row: 0, column: 4 });
  });

  it("d| deletes charwise to the column (exclusive)", () => {
    const editor = new InMemoryVimEditor("hello world");
    const vim = new Vim(editor);
    runKeys(vim, ["d", "5", "|"]); // delete cols 0..3 (to column 5 exclusive)
    expect(editor.getText()).toBe("o world");
  });
});

describe("fold-aware vertical motions", () => {
  it("normal j/k cross a closed fold through the host motion capability", () => {
    // Rows 2-3 are hidden behind the fold header on row 1. A model-row `j`
    // would land on hidden row 2 and make VSCode unfold it; the host reports
    // the next visible logical row instead.
    const editor = new FoldAwareEditor("zero\nfold\nhidden-a\nhidden-b\nfour\nfive");
    const vim = new Vim(editor);

    runKeys(vim, ["j", "j"]);
    expect(head(editor)).toEqual({ row: 4, column: 0 });
    runKeys(vim, ["k"]);
    expect(head(editor)).toEqual({ row: 1, column: 0 });
    runKeys(vim, ["2", "k"]);
    expect(head(editor)).toEqual({ row: 0, column: 0 });
    expect(editor.verticalMoves).toEqual([
      { direction: "down", count: 1, displayLine: false },
      { direction: "down", count: 1, displayLine: false },
      { direction: "up", count: 1, displayLine: false },
      { direction: "up", count: 2, displayLine: false },
    ]);
  });

  it("gj/gk request display-line rather than logical-line movement", () => {
    const editor = new FoldAwareEditor("zero\nfold\nhidden-a\nhidden-b\nfour");
    const vim = new Vim(editor);

    runKeys(vim, ["j", "g", "j", "g", "k"]);
    expect(editor.verticalMoves.map(({ direction, displayLine }) => ({ direction, displayLine }))).toEqual([
      { direction: "down", displayLine: false },
      { direction: "down", displayLine: true },
      { direction: "up", displayLine: true },
    ]);
  });
});

describe("operators over wrapped lines", () => {
  it("dj uses logical-line movement from the first display line", () => {
    const editor = new WrappedLineEditor("above\nwrapped-long-line\nbelow\nafter");
    const vim = new Vim(editor);
    runKeys(vim, ["j", "d", "j"]);

    expect(editor.getText()).toBe("above\nafter");
    expect(editor.verticalMoves[editor.verticalMoves.length - 1]).toEqual({
      direction: "down",
      count: 1,
      displayLine: false,
    });
  });

  it("dk uses logical-line movement from the last display line", () => {
    const editor = new WrappedLineEditor("above\nwrapped-long-line\nbelow\nafter");
    const vim = new Vim(editor);
    runKeys(vim, ["j", "d", "k"]);

    expect(editor.getText()).toBe("below\nafter");
    expect(editor.verticalMoves[editor.verticalMoves.length - 1]).toEqual({
      direction: "up",
      count: 1,
      displayLine: false,
    });
  });
});

describe("viewColumn selection goals (host view-line movements)", () => {
  it("clamps a gj/gk goal to the last character before a soft wrap", () => {
    // `abc<wrap>def`: VS Code reports column 4 as the position after `c`.
    // Converting that boundary back to a model position selects `d`, so a
    // normal-mode display-line cursor must stop at column 3 instead.
    expect(normalViewLineColumnForGoal(
      { type: "viewColumn", column: 5 },
      { minColumn: 1, maxColumn: 4 }
    )).toBe(3);
  });

  // The VSCode adapter's view-line movements (`ctrl-d`/`ctrl-u`, `gj`/`gk`)
  // stamp the resulting selection with a 1-based *view*-column goal. A
  // following model-space vertical motion (`j`/`k`) must convert that back to
  // the 0-based model column instead of drifting one column to the right
  // (regression: `ctrl-u` `ctrl-d` then `k` shifted the cursor right by one).
  it("j/k interpret a 1-based viewColumn goal as the same model column", () => {
    const editor = new InMemoryVimEditor("abcdef\nghijkl\nmnopqr");
    const vim = new Vim(editor);
    runKeys(vim, ["j", "l", "l"]); // row 1, column 2
    expect(head(editor)).toEqual({ row: 1, column: 2 });
    const selection = editor.getSelections()[0];
    editor.setSelections([{ ...selection, goal: { type: "viewColumn", column: 3 } }]);
    runKeys(vim, ["k"]);
    expect(head(editor)).toEqual({ row: 0, column: 2 });
    runKeys(vim, ["j", "j"]);
    expect(head(editor)).toEqual({ row: 2, column: 2 });
  });

  it("a viewColumn goal keeps the column through short lines", () => {
    const editor = new InMemoryVimEditor("abcdef\nx\nmnopqr");
    const vim = new Vim(editor);
    runKeys(vim, ["5", "|"]); // row 0, column 4
    const selection = editor.getSelections()[0];
    editor.setSelections([{ ...selection, goal: { type: "viewColumn", column: 5 } }]);
    runKeys(vim, ["j"]); // clipped by the short line
    expect(head(editor)).toEqual({ row: 1, column: 0 });
    runKeys(vim, ["j"]); // returns to the goal column
    expect(head(editor)).toEqual({ row: 2, column: 4 });
  });
});
