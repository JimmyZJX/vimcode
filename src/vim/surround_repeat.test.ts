// Dot-repeat of vim-surround commands. vim-surround (with repeat.vim) makes
// `ys`/`ds`/`cs` repeatable with `.`; the framework replays the recorded
// chord keys, so the whole family repeats — including the tag-entry forms.
import { InMemoryVimEditor } from "./editor.js";
import { Vim, runKeys } from "./vim.js";

function repeatOnNextLine(text: string, keys: string[]): string {
  const editor = new InMemoryVimEditor(text);
  const vim = new Vim(editor);
  runKeys(vim, keys);
  runKeys(vim, ["j", "0"]);
  runKeys(vim, ["."]);
  return editor.getText();
}

describe("surround dot-repeat", () => {
  it(". repeats cs (alias and spelled pair)", () => {
    expect(repeatOnNextLine("(foo)\n(bar)", ["c", "s", "b", "]"])).toBe("[foo]\n[bar]");
    expect(repeatOnNextLine("(foo)\n(bar)", ["c", "s", "(", "]"])).toBe("[foo]\n[bar]");
  });

  it(". repeats ds", () => {
    expect(repeatOnNextLine('"foo"\n"bar"', ["d", "s", '"'])).toBe("foo\nbar");
  });

  it(". repeats ys with a motion and an object", () => {
    expect(repeatOnNextLine("foo x\nbar y", ["y", "s", "e", ")"])).toBe("(foo) x\n(bar) y");
    expect(repeatOnNextLine("foo x\nbar y", ["y", "s", "i", "w", "]"])).toBe("[foo] x\n[bar] y");
  });

  it("yss wraps only the current line on a multi-line buffer", () => {
    // Regression: the linewise-delete range shape made yss wrap across the
    // newline on any line but the last.
    const editor = new InMemoryVimEditor("foo x\nbar y");
    const vim = new Vim(editor);
    runKeys(vim, ["y", "s", "s", ")"]);
    expect(editor.getText()).toBe("(foo x)\nbar y");
  });

  it(". repeats yss", () => {
    expect(repeatOnNextLine("foo x\nbar y", ["y", "s", "s", ")"])).toBe("(foo x)\n(bar y)");
  });

  it(". repeats cst with a typed tag body", () => {
    expect(
      repeatOnNextLine("<b>foo</b>\n<b>bar</b>", ["c", "s", "t", "t", "e", "m", ">"])
    ).toBe("<em>foo</em>\n<em>bar</em>");
  });

  it(". repeats ysiw with a tag", () => {
    expect(
      repeatOnNextLine("foo\nbar", ["y", "s", "i", "w", "t", "u", ">"])
    ).toBe("<u>foo</u>\n<u>bar</u>");
  });
});
