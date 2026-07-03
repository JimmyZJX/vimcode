// vim-surround tag targets (`t`/`<`). vim-surround is a plugin (not in
// nvim --clean), so these pin behavior directly, matching the plugin's
// documented semantics: tag entry collects a body until `>` or enter;
// attributes go on the opening tag only; `cst` + enter preserves the old
// tag's attributes; `dst` deletes the enclosing tag pair.
import { InMemoryVimEditor } from "./editor.js";
import { Vim, runKeys } from "./vim.js";

function edit(text: string, keys: string[]): { text: string; mode: string } {
  const editor = new InMemoryVimEditor(text);
  const vim = new Vim(editor);
  runKeys(vim, keys);
  return { text: editor.getText(), mode: vim.modeName };
}

describe("surround tag targets", () => {
  it("ysiwt wraps a word in a typed tag", () => {
    expect(edit("say hello now", ["w", "y", "s", "i", "w", "t", ..."em", ">"]).text).toBe("say <em>hello</em> now");
  });

  it("ysiw< also enters tag entry, attributes only on the open tag", () => {
    expect(edit("hello", ["y", "s", "i", "w", "<", ..."div class=\"x\"", ">"]).text)
      .toBe("<div class=\"x\">hello</div>");
  });

  it("dst deletes the enclosing tag pair", () => {
    expect(edit("<div><em>heˇllo</em></div>".replace("ˇ", ""), ["f", "l", "d", "s", "t"]).text)
      .toBe("<div>hello</div>");
  });

  it("cst\" changes the enclosing tag to quotes", () => {
    expect(edit("<em>hello</em> x", ["f", "l", "c", "s", "t", "\""]).text).toBe("\"hello\" x");
  });

  it("cs\"t changes quotes to a typed tag", () => {
    expect(edit("say \"hello\" now", ["f", "h", "c", "s", "\"", "t", ..."b", ">"]).text)
      .toBe("say <b>hello</b> now");
  });

  it("cst + enter preserves the old tag's attributes", () => {
    expect(edit("<div class=\"x\">hello</div>", ["f", "l", "c", "s", "t", "<", ..."span", "enter"]).text)
      .toBe("<span class=\"x\">hello</span>");
  });

  it("cst + > replaces the attributes", () => {
    expect(edit("<div class=\"x\">hello</div>", ["f", "l", "c", "s", "t", "<", ..."span", ">"]).text)
      .toBe("<span>hello</span>");
  });

  it("backspace edits the tag entry; escape cancels", () => {
    expect(edit("hello", ["y", "s", "i", "w", "t", ..."emx", "backspace", ">"]).text).toBe("<em>hello</em>");
    const cancelled = edit("hello", ["y", "s", "i", "w", "t", ..."em", "escape"]);
    expect(cancelled.text).toBe("hello");
    expect(cancelled.mode).toBe("vim:normal");
  });

  it("visual St wraps the selection", () => {
    const result = edit("pick me now", ["w", "v", "e", "S", "t", ..."b", ">"]);
    expect(result.text).toBe("pick <b>me</b> now");
    expect(result.mode).toBe("vim:normal");
  });

  it("yss t wraps the line in a tag on the same line", () => {
    expect(edit("  content here", ["y", "s", "s", "t", ..."p", ">"]).text).toBe("  <p>content here</p>");
  });
});
