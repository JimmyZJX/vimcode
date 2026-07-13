// Escape cancelling the ctrl-k digraph waiters is a deliberate divergence
// from Neovim, which resolves `r ctrl-k <Esc>` by committing a literal ^K
// control character into the buffer; cancelling is strictly better in an
// editor host. The nvim-agreeing escape behavior for `r` / `v_r` themselves
// (and the `ctrl-[` synonym) is pinned by the recorded
// test_replace_escape_cancels fixture.
import { InMemoryVimEditor } from "./editor.js";
import { Vim, runKeys } from "./vim.js";

function edit(text: string, keys: readonly string[]): { text: string; editor: InMemoryVimEditor; vim: Vim } {
  const editor = new InMemoryVimEditor(text);
  const vim = new Vim(editor);
  runKeys(vim, keys);
  return { text: editor.getText(), editor, vim };
}

describe("escape cancels the digraph waiter (deliberate nvim divergence)", () => {
  it("r ctrl-k <escape> cancels the replace", () => {
    const result = edit("abc def", ["r", "ctrl-k", "<escape>"]);
    expect(result.text).toBe("abc def");
    expect(result.vim.mode).toBe("normal");
    runKeys(result.vim, ["x"]);
    expect(result.editor.getText()).toBe("bc def");
  });

  it("r ctrl-k a <escape> cancels after the first digraph char", () => {
    const result = edit("abc def", ["r", "ctrl-k", "a", "<escape>"]);
    expect(result.text).toBe("abc def");
    expect(result.vim.mode).toBe("normal");
  });

  it("v r ctrl-k <escape> cancels and keeps the selection", () => {
    const result = edit("abc def", ["v", "l", "r", "ctrl-k", "<escape>"]);
    expect(result.text).toBe("abc def");
    expect(result.vim.mode).toBe("visual");
    runKeys(result.vim, ["d"]);
    expect(result.editor.getText()).toBe("c def");
  });

  it("a digraph still resolves when completed", () => {
    const result = edit("abc def", ["r", "ctrl-k", "o", ":"]);
    expect(result.text).toBe("öbc def");
  });
});
