// The `:` command line is the same [SingleLineEditor] mini-buffer as the
// `/`?` search prompt: cursor movement, editing around the cursor, and
// history recall. Prompts own the keyboard: keys they do not understand are
// swallowed (never forwarded to normal mode or the host) and reported through
// a transient status warning.
import { InMemoryVimEditor } from "./editor.js";
import { Vim, runKeys } from "./vim.js";

function type(vim: Vim, text: string): void {
  runKeys(vim, [...text].map(char => (char === " " ? "space" : char)));
}

describe(": command-line mini-buffer", () => {
  it("left/right move the cursor and typed keys insert at it", () => {
    const editor = new InMemoryVimEditor("foo foo");
    const vim = new Vim(editor);
    type(vim, ":s/foo/X");
    runKeys(vim, ["left", "left", "left", "left"]);
    type(vim, "12");
    expect(vim.status.chord).toBe(":s/f12|oo/X");
    runKeys(vim, ["end"]);
    expect(vim.status.chord).toBe(":s/f12oo/X|");
    runKeys(vim, ["home"]);
    expect(vim.status.chord).toBe(":|s/f12oo/X");
  });

  it("delete and backspace edit around the cursor", () => {
    const editor = new InMemoryVimEditor("x");
    const vim = new Vim(editor);
    type(vim, ":abc");
    runKeys(vim, ["left", "backspace"]);
    expect(vim.status.chord).toBe(":a|c");
    runKeys(vim, ["delete"]);
    expect(vim.status.chord).toBe(":a|");
  });

  it("ctrl-w deletes the word before the cursor (c_CTRL-W), in both prompts", () => {
    const editor = new InMemoryVimEditor("x");
    const vim = new Vim(editor);
    type(vim, ":sort foo");
    runKeys(vim, ["ctrl-w"]);
    expect(vim.status.chord).toBe(":sort |");
    runKeys(vim, ["<escape>"]);
    type(vim, "/abc def");
    runKeys(vim, ["ctrl-w"]);
    expect(vim.status.chord).toBe("/abc |");
  });

  it("mid-line edits keep the substitute preview live", () => {
    const editor = new InMemoryVimEditor("aXc");
    const vim = new Vim(editor);
    type(vim, ":s/ac/Y");
    expect(editor.substitutePreview).toEqual([]);
    // Move into the pattern and fix it to `aXc`.
    runKeys(vim, ["left", "left", "left"]);
    type(vim, "X");
    expect(vim.status.chord).toBe(":s/aX|c/Y");
    expect(editor.substitutePreview).toEqual([
      { range: { start: { row: 0, column: 0 }, end: { row: 0, column: 3 } }, replacement: "Y" },
    ]);
  });

  it("editing after a history recall works on the recalled text", () => {
    const editor = new InMemoryVimEditor("x");
    const vim = new Vim(editor);
    type(vim, ":sort");
    runKeys(vim, ["enter"]);
    runKeys(vim, [":", "up"]);
    expect(vim.status.chord).toBe(":sort|");
    runKeys(vim, ["backspace"]);
    expect(vim.status.chord).toBe(":sor|");
  });

  it("the command executes with the edited text", () => {
    const editor = new InMemoryVimEditor("b\na\nc");
    const vim = new Vim(editor);
    // Type `:%sort!`, then fix it to `%sort` by deleting the bang.
    type(vim, ":%sort!");
    runKeys(vim, ["backspace", "enter"]);
    expect(editor.getText()).toBe("a\nb\nc");
  });
});

describe("visual-origin :", () => {
  // Deliberate divergence: Neovim keeps the selection highlighted until the
  // command line is first edited; vimcode exits visual on `:` and relies on
  // the '<,'> marks (plus the substitute preview) instead.
  it("exits visual on entry; the range and gv still work via the marks", () => {
    const editor = new InMemoryVimEditor("aaa\nbbb\nccc\nbdd");
    const vim = new Vim(editor);
    runKeys(vim, ["V", "j", ":"]);
    expect(vim.mode).toBe("command");
    expect(vim.status.chord).toBe(":'<,'>|");
    expect(editor.getSelections()[0].type).toBe("charwise");
    runKeys(vim, ["s", "/", "b", "/", "X", "enter"]);
    // Only the selected rows 0-1 substitute; row 3 keeps its b.
    expect(editor.getText()).toBe("aaa\nXbb\nccc\nbdd");
    expect(vim.mode).toBe("normal");
    // The '<,'> marks survive: gv restores the selection.
    runKeys(vim, ["g", "v"]);
    expect(vim.mode).toBe("visualLine");
  });
});

describe("prompts swallow unknown keys, loudly", () => {
  it("command mode swallows tab and warns instead of forwarding", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor);
    type(vim, ":s/a");
    runKeys(vim, ["tab"]);
    expect(vim.mode).toBe("command");
    expect(vim.status.chord).toBe(":s/a|");
    expect(editor.getText()).toBe("abc");
    expect(vim.status.swallowedKeyWarning).toBe("<tab>");
    expect(vim.status.swallowedKeyWarningRemainingMs).toBeGreaterThan(0);
  });

  it("search mode swallows unknown ctrl chords and warns", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor);
    runKeys(vim, ["/", "a", "ctrl-k"]);
    expect(vim.mode).toBe("search");
    expect(vim.status.chord).toBe("/a|");
    expect(vim.status.swallowedKeyWarning).toBe("<ctrl-k>");
  });

  it("the operator search operand swallows unknown keys and keeps waiting", () => {
    const editor = new InMemoryVimEditor("abc def");
    const vim = new Vim(editor);
    runKeys(vim, ["d", "/", "d", "tab"]);
    expect(vim.status.swallowedKeyWarning).toBe("<tab>");
    // The operand prompt survived the stray key: enter completes `d/d`.
    runKeys(vim, ["enter"]);
    expect(editor.getText()).toBe("def");
  });

  it("the warning expires", () => {
    jest.useFakeTimers();
    try {
      const editor = new InMemoryVimEditor("abc");
      const vim = new Vim(editor);
      runKeys(vim, [":", "tab"]);
      expect(vim.status.swallowedKeyWarning).toBe("<tab>");
      jest.advanceTimersByTime(2500);
      expect(vim.status.swallowedKeyWarning).toBeUndefined();
      expect(vim.status.swallowedKeyWarningRemainingMs).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it("escape still cancels the prompt rather than being swallowed", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor);
    runKeys(vim, [":", "tab", "<escape>"]);
    expect(vim.mode).toBe("normal");
  });
});
