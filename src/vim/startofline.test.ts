// Vim 'startofline' ([VimConfiguration.startofline]): `G`, `gg`, `H`, `M`, `L`
// and the page keys land on the line's first non-blank; off, they keep the
// column (Neovim).
import { InMemoryVimEditor } from "./editor.js";
import { Vim, runKeys } from "./vim.js";

function head(editor: InMemoryVimEditor): { row: number; column: number } {
  const selection = editor.getSelections()[0] as any;
  return selection.cursor ?? selection.head;
}

const text = "    abc def\n  ghi jkl mno\n      pqr";

describe("startofline", () => {
  it("is off by default: the column stays", () => {
    const editor = new InMemoryVimEditor(text);
    const vim = new Vim(editor);
    runKeys(vim, ["2", "G", "$"]);
    runKeys(vim, ["G"]);
    expect(head(editor)).toEqual({ row: 2, column: 8 });
  });

  it("puts G, gg, H, M and L on the first non-blank", () => {
    const editor = new InMemoryVimEditor(text);
    const vim = new Vim(editor, { startofline: true });
    runKeys(vim, ["$", "G"]);
    expect(head(editor)).toEqual({ row: 2, column: 6 });
    runKeys(vim, ["$", "2", "G"]);
    expect(head(editor)).toEqual({ row: 1, column: 2 });
    runKeys(vim, ["$", "g", "g"]);
    expect(head(editor)).toEqual({ row: 0, column: 4 });
    runKeys(vim, ["$", "L"]);
    expect(head(editor)).toEqual({ row: 2, column: 6 });
    runKeys(vim, ["$", "H"]);
    expect(head(editor)).toEqual({ row: 0, column: 4 });
    runKeys(vim, ["$", "M"]);
    expect(head(editor)).toEqual({ row: 1, column: 2 });
  });

  it("puts the page keys on the first non-blank", () => {
    const editor = new InMemoryVimEditor(text);
    const vim = new Vim(editor, { startofline: true });
    runKeys(vim, ["$", "ctrl-d"]);
    expect(head(editor)).toEqual({ row: 1, column: 2 });
    runKeys(vim, ["$", "ctrl-u"]);
    expect(head(editor)).toEqual({ row: 0, column: 4 });
    // Off: the column stays.
    const plain = new InMemoryVimEditor(text);
    runKeys(new Vim(plain), ["$", "ctrl-d"]);
    expect(head(plain)).toEqual({ row: 1, column: 12 });
  });

  it("does so in visual mode too", () => {
    const editor = new InMemoryVimEditor(text);
    const vim = new Vim(editor, { startofline: true });
    runKeys(vim, ["$", "v", "G"]);
    expect(head(editor)).toEqual({ row: 2, column: 6 });
    runKeys(vim, ["g", "g"]);
    expect(head(editor)).toEqual({ row: 0, column: 4 });
    runKeys(vim, ["$", "ctrl-d"]);
    expect(head(editor)).toEqual({ row: 1, column: 2 });
  });
});
