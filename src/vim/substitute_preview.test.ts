// Live `:s` preview (Neovim 'inccommand', VSCodeVim's substitute preview):
// while the command line holds a substitute, the matches in the addressed
// range are pushed to the host with their resolved replacements. The pure
// computation is [substitutePreviews]; the integration path drives the real
// `:` prompt and asserts what the in-memory host recorded.
import { substitutePreviews } from "./command.js";
import { InMemoryVimEditor } from "./editor.js";
import { Vim, runKeys } from "./vim.js";

function typeCommand(vim: Vim, text: string): void {
  runKeys(vim, [...text].map(char => (char === " " ? "space" : char)));
}

describe("substitutePreviews (pure)", () => {
  const editor = () => new InMemoryVimEditor("foo bar foo\nbar foo bar\nfoo");

  it("is undefined for non-substitute commands", () => {
    expect(substitutePreviews(editor(), "")).toBeUndefined();
    expect(substitutePreviews(editor(), "w")).toBeUndefined();
    expect(substitutePreviews(editor(), "sort")).toBeUndefined();
    expect(substitutePreviews(editor(), "3")).toBeUndefined();
  });

  it("is undefined while the pattern is empty or invalid", () => {
    expect(substitutePreviews(editor(), "s/")).toBeUndefined();
    expect(substitutePreviews(editor(), "s/[")).toBeUndefined();
  });

  it("previews the last search pattern while the typed pattern is empty", () => {
    const options = { lastSearchPattern: { read: () => "foo", write: () => undefined } };
    expect(substitutePreviews(editor(), "s//X", options)).toEqual([
      { range: { start: { row: 0, column: 0 }, end: { row: 0, column: 3 } }, replacement: "X" },
    ]);
    // Still nothing to preview without a last pattern.
    const noLast = { lastSearchPattern: { read: () => undefined, write: () => undefined } };
    expect(substitutePreviews(editor(), "s//X", noLast)).toBeUndefined();
  });

  it("highlights matches on the current line before the replacement exists", () => {
    expect(substitutePreviews(editor(), "s/foo")).toEqual([
      { range: { start: { row: 0, column: 0 }, end: { row: 0, column: 3 } }, replacement: undefined },
    ]);
  });

  it("previews the replacement once its section exists", () => {
    expect(substitutePreviews(editor(), "s/foo/X")).toEqual([
      { range: { start: { row: 0, column: 0 }, end: { row: 0, column: 3 } }, replacement: "X" },
    ]);
    // A typed second delimiter with nothing after it previews a deletion.
    expect(substitutePreviews(editor(), "s/foo/")).toEqual([
      { range: { start: { row: 0, column: 0 }, end: { row: 0, column: 3 } }, replacement: "" },
    ]);
  });

  it("honors ranges and the g flag", () => {
    expect(substitutePreviews(editor(), "%s/foo/X/g")).toEqual([
      { range: { start: { row: 0, column: 0 }, end: { row: 0, column: 3 } }, replacement: "X" },
      { range: { start: { row: 0, column: 8 }, end: { row: 0, column: 11 } }, replacement: "X" },
      { range: { start: { row: 1, column: 4 }, end: { row: 1, column: 7 } }, replacement: "X" },
      { range: { start: { row: 2, column: 0 }, end: { row: 2, column: 3 } }, replacement: "X" },
    ]);
    expect(substitutePreviews(editor(), "1,2s/foo/X/")).toHaveLength(2);
  });

  it("resolves capture groups and & per match", () => {
    // Patterns are JS-flavored regex (VSCodeVim-compatible), so groups are
    // plain parentheses.
    expect(substitutePreviews(editor(), "%s/(f)oo/[\\1|&]/g")?.map(preview => preview.replacement)).toEqual([
      "[f|foo]",
      "[f|foo]",
      "[f|foo]",
      "[f|foo]",
    ]);
  });

  it("the n (count-only) flag highlights without replacement previews", () => {
    expect(substitutePreviews(editor(), "s/foo/X/n")).toEqual([
      { range: { start: { row: 0, column: 0 }, end: { row: 0, column: 3 } }, replacement: undefined },
    ]);
  });

  it("gdefault flips the g parity", () => {
    // "foo bar foo" has four o's; without gdefault `s/o/0/` previews one.
    expect(substitutePreviews(editor(), "s/o/0/", { exOptions: { gdefault: true } })).toHaveLength(4);
    expect(substitutePreviews(editor(), "s/o/0/")).toHaveLength(1);
  });

  it("zero-length matches advance and terminate", () => {
    const previews = substitutePreviews(new InMemoryVimEditor("ab"), "s/x*/y/g");
    expect(previews).toBeDefined();
    expect(previews!.length).toBeGreaterThan(0);
    expect(previews!.length).toBeLessThanOrEqual(3);
  });

  it("caps the number of previews on pathological inputs", () => {
    const bigEditor = new InMemoryVimEditor(Array(500).fill("aaaa").join("\n"));
    expect(substitutePreviews(bigEditor, "%s/a/b/g")).toHaveLength(200);
  });

  it("caps the scanned text, so rare patterns in huge buffers stay cheap", () => {
    // ~2MB of non-matching text with the only match at the end: the preview
    // gives up at its scan budget instead of regex-walking the whole buffer
    // on every prompt keystroke. A match before the budget is still found.
    const filler = Array(2000).fill("a".repeat(1000)).join("\n");
    const matchAtEnd = new InMemoryVimEditor(`${filler}\nzzz`);
    expect(substitutePreviews(matchAtEnd, "%s/z/b/g")).toEqual([]);
    const matchAtStart = new InMemoryVimEditor(`zzz\n${filler}`);
    expect(substitutePreviews(matchAtStart, "%s/z/b/g")).toHaveLength(3);
  });
});

describe("substitute preview through the : prompt", () => {
  it("updates while typing, previews replacements, and clears on submit", () => {
    const editor = new InMemoryVimEditor("foo bar\nfoo");
    const vim = new Vim(editor);

    typeCommand(vim, ":%s/fo");
    expect(editor.substitutePreview).toEqual([
      { range: { start: { row: 0, column: 0 }, end: { row: 0, column: 2 } }, replacement: undefined },
      { range: { start: { row: 1, column: 0 }, end: { row: 1, column: 2 } }, replacement: undefined },
    ]);

    typeCommand(vim, "o/X");
    expect(editor.substitutePreview).toEqual([
      { range: { start: { row: 0, column: 0 }, end: { row: 0, column: 3 } }, replacement: "X" },
      { range: { start: { row: 1, column: 0 }, end: { row: 1, column: 3 } }, replacement: "X" },
    ]);

    runKeys(vim, ["enter"]);
    expect(editor.substitutePreview).toBeUndefined();
    expect(editor.getText()).toBe("X bar\nX");
  });

  it("backspace recomputes the preview", () => {
    const editor = new InMemoryVimEditor("ab\ncd");
    const vim = new Vim(editor);
    typeCommand(vim, ":s/ab");
    expect(editor.substitutePreview).toHaveLength(1);
    runKeys(vim, ["backspace", "backspace"]);
    // Back to `s/` — empty pattern, no preview.
    expect(editor.substitutePreview).toBeUndefined();
  });

  it("escape clears the preview", () => {
    const editor = new InMemoryVimEditor("foo");
    const vim = new Vim(editor);
    typeCommand(vim, ":s/foo/X");
    expect(editor.substitutePreview).toHaveLength(1);
    runKeys(vim, ["<escape>"]);
    expect(editor.substitutePreview).toBeUndefined();
    expect(editor.getText()).toBe("foo");
    expect(vim.mode).toBe("normal");
  });

  it("a visual '<,'> range previews only the selected lines", () => {
    const editor = new InMemoryVimEditor("foo\nfoo\nfoo");
    const vim = new Vim(editor);
    // Select the first two lines, then `:` prefills '<,'>.
    runKeys(vim, ["V", "j"]);
    typeCommand(vim, ":s/foo/X");
    expect(editor.substitutePreview).toEqual([
      { range: { start: { row: 0, column: 0 }, end: { row: 0, column: 3 } }, replacement: "X" },
      { range: { start: { row: 1, column: 0 }, end: { row: 1, column: 3 } }, replacement: "X" },
    ]);
  });

  it("non-substitute command lines show no preview", () => {
    const editor = new InMemoryVimEditor("foo");
    const vim = new Vim(editor);
    typeCommand(vim, ":sort");
    expect(editor.substitutePreview).toBeUndefined();
  });
});
