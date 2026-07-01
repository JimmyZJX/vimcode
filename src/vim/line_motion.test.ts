// Standalone line motions `G` / `+` / `-` migrated to the framework
// (lineMotionForKey in normal_mode_handler.ts). There is no Neovim fixture for a
// bare `G` key or for visual `+`/`-`/`G`, so these integration tests pin the
// behavior — including that the operator target path (`dG`) is unchanged.
import { InMemoryVimEditor } from "./editor.js";
import { Vim, runKeys } from "./vim.js";
import { selectionHead } from "./state.js";

function head(editor: InMemoryVimEditor) {
  return selectionHead(editor.getSelections()[0]);
}
function cursor(editor: InMemoryVimEditor) {
  return (editor.getSelections()[0] as { cursor: { row: number; column: number } }).cursor;
}
function opStackLen(vim: Vim): number {
  return (vim as unknown as { operatorStack: { length: number } }).operatorStack.length;
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

  it("G / + / - are framework-owned (operatorStack stays empty)", () => {
    const editor = new InMemoryVimEditor("a\nb\nc");
    const vim = new Vim(editor);
    runKeys(vim, ["G"]);
    expect(opStackLen(vim)).toBe(0);
    runKeys(vim, ["-"]);
    expect(opStackLen(vim)).toBe(0);
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
