// Vim `search-offset` (`:help search-offset`): a `/pat/e`, `/pat/s`, or `/pat/b`
// offset (with an optional `+N`/`-N` character delta) moves the cursor relative
// to the match. This is a real Vim feature that Zed does not implement, so there
// is no upstream fixture to port; these integration tests pin the behavior.
import { InMemoryVimEditor } from "./editor.js";
import { Vim, runKeys } from "./vim.js";
import { selectionHead } from "./state.js";

function head(editor: InMemoryVimEditor) {
  return selectionHead(editor.getSelections()[0]);
}

function cursor(editor: InMemoryVimEditor) {
  return (editor.getSelections()[0] as { cursor: { row: number; column: number } }).cursor;
}

function searchKeys(query: string): string[] {
  return [...query].map((c) => (c === " " ? "space" : c));
}

describe("search offsets /pat/e /pat/s /pat/b with ±N", () => {
  it("/pat/e lands on the last char of the match; e+N / e-N shift it", () => {
    // "hello world": w=6 o=7 r=8 l=9 d=10
    const runOffset = (offset: string) => {
      const editor = new InMemoryVimEditor("hello world");
      const vim = new Vim(editor);
      runKeys(vim, ["/", ...searchKeys(`world/${offset}`), "enter"]);
      return head(editor);
    };
    expect(runOffset("e")).toEqual({ row: 0, column: 10 }); // 'd'
    expect(runOffset("e-1")).toEqual({ row: 0, column: 9 }); // 'l'
    expect(runOffset("e+1")).toEqual({ row: 0, column: 11 }); // trailing space
  });

  it("/pat/s and /pat/b land on the match start; s+N shifts it", () => {
    const runOffset = (offset: string) => {
      const editor = new InMemoryVimEditor("hello world");
      const vim = new Vim(editor);
      runKeys(vim, ["/", ...searchKeys(`world/${offset}`), "enter"]);
      return head(editor);
    };
    expect(runOffset("s")).toEqual({ row: 0, column: 6 }); // 'w'
    expect(runOffset("b")).toEqual({ row: 0, column: 6 }); // 'w'
    expect(runOffset("s+2")).toEqual({ row: 0, column: 8 }); // 'r'
  });

  it("a plain /pat search still lands on the match start", () => {
    const editor = new InMemoryVimEditor("hello world");
    const vim = new Vim(editor);
    runKeys(vim, ["/", ...searchKeys("world"), "enter"]);
    expect(head(editor)).toEqual({ row: 0, column: 6 });
  });

  it("n / N repeat carries the offset", () => {
    // "xx ab ab ab": ab at 3-4, 6-7, 9-10
    const editor = new InMemoryVimEditor("xx ab ab ab");
    const vim = new Vim(editor);
    runKeys(vim, ["/", ...searchKeys("ab/e"), "enter"]);
    expect(head(editor)).toEqual({ row: 0, column: 4 }); // 'b' of first ab
    runKeys(vim, ["n"]);
    expect(head(editor)).toEqual({ row: 0, column: 7 }); // 'b' of second ab
    runKeys(vim, ["N"]);
    expect(head(editor)).toEqual({ row: 0, column: 4 }); // back to first
  });

  it("d/pat/e is inclusive (deletes through the end of the match)", () => {
    const editor = new InMemoryVimEditor("hello world");
    const vim = new Vim(editor);
    // Delete from col 0 through the 'o' of the first match inclusive.
    runKeys(vim, ["d", "/", ...searchKeys("o/e"), "enter"]);
    expect(editor.getText()).toBe(" world");
  });

  it("d/pat (no offset) stays exclusive", () => {
    const editor = new InMemoryVimEditor("hello world");
    const vim = new Vim(editor);
    runKeys(vim, ["d", "/", ...searchKeys("o"), "enter"]);
    expect(editor.getText()).toBe("o world");
  });

  it("visual /pat/e extends the selection to the end of the match", () => {
    const editor = new InMemoryVimEditor("hello world");
    const vim = new Vim(editor);
    runKeys(vim, ["v", "/", ...searchKeys("world/e"), "enter"]);
    expect(vim.modeName).toBe("vim:visual");
    expect(cursor(editor)).toEqual({ row: 0, column: 10 }); // 'd'
  });
});
