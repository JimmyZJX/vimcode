// The `gq`/`gw` reflow semantics are pinned by the Neovim-recorded
// test_format_operator fixtures; these tests cover the width *resolution*,
// which has no Neovim counterpart: an explicit `vim.textwidth` wins, then the
// editor's first ruler (`editor.rulers`, like VSCodeVim), then Vim's 79-column
// 'textwidth'=0 fallback.
import { InMemoryVimEditor } from "./editor.js";
import { Vim, runKeys } from "./vim.js";

const LONG_LINE = "aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn ooo ppp qqq rrr sss ttt uuu";

describe("gq format width resolution", () => {
  it("uses the first editor ruler when textwidth is not configured", () => {
    const editor = new InMemoryVimEditor(LONG_LINE);
    editor.configureRulersForTest([20, 40]);
    const vim = new Vim(editor);
    runKeys(vim, ["g", "q", "q"]);
    expect(editor.getText().split("\n")[0]).toBe("aaa bbb ccc ddd eee");
  });

  it("prefers an explicit textwidth over the ruler", () => {
    const editor = new InMemoryVimEditor(LONG_LINE);
    editor.configureRulersForTest([20]);
    const vim = new Vim(editor, { textwidth: 27 });
    runKeys(vim, ["g", "q", "q"]);
    // 27 columns fit exactly seven three-letter words.
    expect(editor.getText().split("\n")[0]).toBe("aaa bbb ccc ddd eee fff ggg");
  });

  it("falls back to 79 columns without textwidth or rulers", () => {
    const editor = new InMemoryVimEditor(LONG_LINE);
    const vim = new Vim(editor);
    runKeys(vim, ["g", "q", "q"]);
    // 79 columns fit exactly twenty three-letter words.
    expect(editor.getText().split("\n")[0]).toBe(
      "aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn ooo ppp qqq rrr sss ttt"
    );
  });
});
