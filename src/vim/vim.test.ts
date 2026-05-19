import { layeredConfigValue, normalizeKey } from "./config.js";
import { InMemoryVimEditor } from "./editor.js";
import { Vim, runKeys } from "./vim.js";
import { charwiseSelection, selectionHead } from "./state.js";

function head(editor: InMemoryVimEditor) {
  return selectionHead(editor.getSelections()[0]);
}

describe("Zed-inspired Vim core smoke tests", () => {
  it("layers VSCodeVim-compatible array and object config values", () => {
    expect(layeredConfigValue({
      normalModeKeyBindings__team: [{ before: ["a"], after: ["b"] }],
      normalModeKeyBindings__user_defaults: [{ before: ["c"], after: ["d"] }],
      normalModeKeyBindings: [{ before: ["e"], after: ["f"] }],
    }, "normalModeKeyBindings")).toEqual([
      { before: ["a"], after: ["b"] },
      { before: ["c"], after: ["d"] },
      { before: ["e"], after: ["f"] },
    ]);

    expect(layeredConfigValue({
      handleKeys__team: { "<C-f>": false },
      handleKeys: { "<C-d>": true },
    }, "handleKeys")).toEqual({ "<C-f>": false, "<C-d>": true });
  });

  it("normalizes VSCodeVim handleKeys config", () => {
    const vim = new Vim(new InMemoryVimEditor(""), {
      handleKeys: { "<C-f>": false, "<C-d>": true },
    });

    expect(vim.handleKeyOverride("ctrl-f")).toBe(false);
    expect(vim.handleKeyOverride("ctrl-d")).toBe(true);
    expect(vim.handleKeyOverride("ctrl-x")).toBeUndefined();
  });

  it("moves in normal mode and inserts through the editor capability interface", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor);

    runKeys(vim, ["l", "i", "X", "<escape>"]);

    expect(editor.getText()).toBe("aXbc");
    expect(vim.modeName).toBe("vim:normal");
    expect(editor.cursorStyle).toBe("block");
    expect(head(editor)).toEqual({ row: 0, column: 1 });
  });

  it("supports counts for motions", () => {
    const editor = new InMemoryVimEditor("one two three");
    const vim = new Vim(editor);

    runKeys(vim, ["2", "w"]);

    expect(head(editor)).toEqual({ row: 0, column: 8 });
  });

  it("normalizes VSCodeVim key notation", () => {
    expect(normalizeKey("<Esc>", "\\")).toBe("<escape>");
    expect(normalizeKey("<C-[>", "\\")).toBe("ctrl-[");
    expect(normalizeKey("<C-Right>", "\\")).toBe("ctrl-right");
    expect(normalizeKey("<S-u>", "\\")).toBe("U");
    expect(normalizeKey("<space>", "\\")).toBe("space");
    expect(normalizeKey("<leader>", "space")).toBe("space");
  });

  it("supports VSCodeVim-style normal remaps", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: [{ before: ["q"], after: ["w"] }],
    });

    runKeys(vim, ["q"]);

    expect(head(editor)).toEqual({ row: 0, column: 4 });
  });

  it("supports VSCodeVim-style insert remaps", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor, {
      insertModeKeyBindingsNonRecursive: [{ before: ["j", "j"], after: ["<Esc>"] }],
    });

    runKeys(vim, ["A", "j", "j"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getText()).toBe("one");
  });

  it("supports VSCodeVim-style visual remaps", () => {
    const editor = new InMemoryVimEditor("abc def");
    const vim = new Vim(editor, {
      visualModeKeyBindingsNonRecursive: [{ before: ["q"], after: ["g", "U"] }],
    });

    runKeys(vim, ["v", "w", "q"]);

    expect(editor.getText()).toBe("ABC def");
    expect(vim.modeName).toBe("vim:normal");
  });

  it("supports VSCodeVim-style command remaps", () => {
    const editor = new InMemoryVimEditor("one\ntwo");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: [{ before: ["q"], commands: [":2"] }],
    });

    runKeys(vim, ["q"]);

    expect(head(editor)).toEqual({ row: 1, column: 0 });
  });

  it("supports arrow keys as Vim motions", () => {
    const editor = new InMemoryVimEditor("abc\ndef");
    const vim = new Vim(editor);

    runKeys(vim, ["right", "right", "down", "left", "up"]);

    expect(head(editor)).toEqual({ row: 0, column: 1 });
  });

  it("supports ctrl-left and ctrl-right as word motions", () => {
    const editor = new InMemoryVimEditor("one two three");
    const vim = new Vim(editor);

    runKeys(vim, ["ctrl-right", "ctrl-right", "ctrl-left"]);

    expect(head(editor)).toEqual({ row: 0, column: 4 });
  });

  it("uses ctrl-right as an operator-pending motion", () => {
    const editor = new InMemoryVimEditor("one two three");
    const vim = new Vim(editor);

    runKeys(vim, ["d", "ctrl-right"]);

    expect(editor.getText()).toBe("two three");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("uses ctrl-right as a visual motion", () => {
    const editor = new InMemoryVimEditor("one two three");
    const vim = new Vim(editor);

    runKeys(vim, ["v", "ctrl-right"]);

    expect(editor.getSelections()[0]).toMatchObject({
      type: "charwise",
      anchor: { row: 0, column: 0 },
      cursor: { row: 0, column: 3 },
    });
  });

  it("supports home and end as line motions", () => {
    const editor = new InMemoryVimEditor("abc def");
    const vim = new Vim(editor);

    runKeys(vim, ["end", "home"]);

    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("supports ctrl-home and ctrl-end as document motions", () => {
    const editor = new InMemoryVimEditor("abc\ndef\nghi");
    const vim = new Vim(editor);

    runKeys(vim, ["ctrl-end", "ctrl-home"]);

    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("uses end as an operator-pending motion", () => {
    const editor = new InMemoryVimEditor("abc def");
    const vim = new Vim(editor);

    runKeys(vim, ["d", "end"]);

    expect(editor.getText()).toBe("");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("uses end as a visual motion", () => {
    const editor = new InMemoryVimEditor("abc def");
    const vim = new Vim(editor);

    runKeys(vim, ["v", "end"]);

    expect(editor.getSelections()[0]).toMatchObject({
      type: "charwise",
      anchor: { row: 0, column: 0 },
      cursor: { row: 0, column: 7 },
    });
  });

  it("supports case-conversion motions", () => {
    const editor = new InMemoryVimEditor("abc def");
    const vim = new Vim(editor);

    runKeys(vim, ["g", "U", "w", "g", "u", "w", "g", "~", "w"]);

    expect(editor.getText()).toBe("ABC def");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("supports visual case conversion", () => {
    const editor = new InMemoryVimEditor("abc def");
    const vim = new Vim(editor);

    runKeys(vim, ["v", "w", "g", "U"]);

    expect(editor.getText()).toBe("ABC def");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 0 });

    runKeys(vim, ["v", "w", "u"]);

    expect(editor.getText()).toBe("abc def");
  });

  it("dot-repeats g~ conversion motions", () => {
    const editor = new InMemoryVimEditor("abc def");
    const vim = new Vim(editor);

    runKeys(vim, ["g", "~", "w", "."]);

    expect(editor.getText()).toBe("abc def");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("supports join-lines commands", () => {
    const editor = new InMemoryVimEditor("one\ntwo\nthree");
    const vim = new Vim(editor);

    runKeys(vim, ["J", "g", "J"]);

    expect(editor.getText()).toBe("one twothree");
    expect(head(editor)).toEqual({ row: 0, column: 7 });
  });

  it("supports indent operators and visual indent", () => {
    const editor = new InMemoryVimEditor("one\n  two\nthree");
    const vim = new Vim(editor);

    runKeys(vim, [">", ">", "j", "<", "<", "V", "j", ">"]);

    expect(editor.getText()).toBe("    one\n    two\n    three");
    expect(vim.modeName).toBe("vim:normal");
  });

  it("dot-repeats visual indent from the start of downward selections", () => {
    const editor = new InMemoryVimEditor("one\ntwo\nthree");
    const vim = new Vim(editor);

    runKeys(vim, ["v", "j", ">", "."]);

    expect(editor.getText()).toBe("        one\n        two\nthree");
    expect(head(editor).row).toBe(0);
    expect(vim.modeName).toBe("vim:normal");
  });

  it("dot-repeats visual indent from the start of upward selections", () => {
    const editor = new InMemoryVimEditor("one\ntwo\nthree");
    const vim = new Vim(editor);

    runKeys(vim, ["j", "v", "k", ">", "."]);

    expect(editor.getText()).toBe("        one\n        two\nthree");
    expect(head(editor).row).toBe(0);
    expect(vim.modeName).toBe("vim:normal");
  });

  it("supports decimal increment and decrement", () => {
    const editor = new InMemoryVimEditor("count 9");
    const vim = new Vim(editor);

    runKeys(vim, ["ctrl-a", "2", "ctrl-x"]);

    expect(editor.getText()).toBe("count 8");
    expect(head(editor)).toEqual({ row: 0, column: 6 });
  });

  it("supports insert-mode ctrl-w and ctrl-u", () => {
    const editor = new InMemoryVimEditor("hello brave world");
    const vim = new Vim(editor);

    runKeys(vim, ["A", "ctrl-w", "y", "o", "u", "ctrl-u", "h", "i", "<escape>"]);

    expect(editor.getText()).toBe("hi");
    expect(head(editor)).toEqual({ row: 0, column: 1 });
  });

  it("supports counted insert and replace sessions", () => {
    const insertEditor = new InMemoryVimEditor("hello");
    const insertVim = new Vim(insertEditor);
    runKeys(insertVim, ["3", "i", "-", "<escape>"]);
    expect(insertEditor.getText()).toBe("---hello");
    expect(head(insertEditor)).toEqual({ row: 0, column: 2 });

    const replaceEditor = new InMemoryVimEditor("hello");
    const replaceVim = new Vim(replaceEditor);
    runKeys(replaceVim, ["3", "R", "a", "b", "c", "<escape>"]);
    expect(replaceEditor.getText()).toBe("abcabcabc");
    expect(head(replaceEditor)).toEqual({ row: 0, column: 8 });
  });

  it("supports gi at the previous insert position", () => {
    const editor = new InMemoryVimEditor("one two\nthree fr");
    const vim = new Vim(editor);

    runKeys(vim, ["G", "$", "i", "o", "<escape>", "k", "g", "i", "u", "<escape>"]);

    expect(editor.getText()).toBe("one two\nthree four");
    expect(head(editor)).toEqual({ row: 1, column: 8 });
  });

  it("preserves the target column across vertical motions", () => {
    const editor = new InMemoryVimEditor("abcdef\nx\nabcdef");
    const vim = new Vim(editor);

    runKeys(vim, ["5", "l", "j", "j"]);

    expect(head(editor)).toEqual({ row: 2, column: 5 });
  });

  it("resets the target column after non-vertical motions", () => {
    const editor = new InMemoryVimEditor("abcdef\nx\nabcdef");
    const vim = new Vim(editor);

    runKeys(vim, ["5", "l", "j", "0", "j"]);

    expect(head(editor)).toEqual({ row: 2, column: 0 });
  });

  it("preserves the target column across half-page motions", () => {
    const editor = new InMemoryVimEditor("abcdef\nx\nx\nabcdef");
    const vim = new Vim(editor);

    runKeys(vim, ["5", "l", "ctrl-d", "ctrl-d"]);

    expect(head(editor)).toEqual({ row: 3, column: 5 });
  });

  it("preserves the end-of-line goal across vertical motions", () => {
    const editor = new InMemoryVimEditor("abcdef\nx\nabcdefghi");
    const vim = new Vim(editor);

    runKeys(vim, ["$", "j", "j"]);

    expect(head(editor)).toEqual({ row: 2, column: 8 });
  });

  it("preserves the end-of-line goal across half-page motions", () => {
    const editor = new InMemoryVimEditor("abcdef\nx\nx\nabcdefghi");
    const vim = new Vim(editor);

    runKeys(vim, ["$", "ctrl-d", "ctrl-d"]);

    expect(head(editor)).toEqual({ row: 3, column: 8 });
  });

  it("deletes by motion with an operator", () => {
    const editor = new InMemoryVimEditor("one two three");
    const vim = new Vim(editor);

    runKeys(vim, ["d", "w"]);

    expect(editor.getText()).toBe("two three");
    expect(vim.readRegister(undefined)).toBe("one ");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("applies counts before an operator", () => {
    const editor = new InMemoryVimEditor("one two three four");
    const vim = new Vim(editor);

    runKeys(vim, ["2", "d", "w"]);

    expect(editor.getText()).toBe("three four");
    expect(vim.readRegister(undefined)).toBe("one two ");
  });

  it("applies counts after an operator", () => {
    const editor = new InMemoryVimEditor("one two three four");
    const vim = new Vim(editor);

    runKeys(vim, ["d", "2", "w"]);

    expect(editor.getText()).toBe("three four");
    expect(vim.readRegister(undefined)).toBe("one two ");
  });

  it("deletes whole lines", () => {
    const editor = new InMemoryVimEditor("alpha\nbeta\ngamma");
    const vim = new Vim(editor);

    runKeys(vim, ["2", "d", "d"]);

    expect(editor.getText()).toBe("gamma");
    expect(vim.readRegister(undefined)).toBe("alpha\nbeta\n");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("changes by motion and enters insert mode", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    runKeys(vim, ["c", "w", "X", "<escape>"]);

    expect(editor.getText()).toBe("X two");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("yanks by motion without changing the buffer", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    runKeys(vim, ["y", "w"]);

    expect(editor.getText()).toBe("one two");
    expect(vim.readRegister(undefined)).toBe("one ");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("yanks into named registers while also updating the unnamed register", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    runKeys(vim, ["\"", "a", "y", "w"]);

    expect(editor.getText()).toBe("one two");
    expect(vim.readRegister("a")).toBe("one ");
    expect(vim.readRegister(undefined)).toBe("one ");
  });

  it("pastes from a selected named register", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    runKeys(vim, ["\"", "a", "y", "w", "G", "$", "\"", "a", "p"]);

    expect(editor.getText()).toBe("one twoone ");
  });

  it("shows unfinished chords using Vim keys rather than semantic names", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    runKeys(vim, ["d"]);
    expect(vim.status.chord).toBe("d");
    expect(vim.status.text).toBe("NORMAL d");

    runKeys(vim, ["i"]);
    expect(vim.status.chord).toBe("di");
    expect(vim.status.text).toBe("NORMAL di");
  });

  it("ignores invalid text objects without entering insert mode", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    runKeys(vim, ["d", "i", "c"]);

    expect(editor.getText()).toBe("one two");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("substitutes characters with s", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    runKeys(vim, ["s", "X", "<escape>"]);

    expect(editor.getText()).toBe("Xne two");
    expect(vim.modeName).toBe("vim:normal");
  });

  it("stays in insert mode while typing", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);

    runKeys(vim, ["i", "X"]);

    expect(editor.getText()).toBe("Xone");
    expect(vim.modeName).toBe("vim:insert");
  });

  it("extends visual selections backward", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor);

    runKeys(vim, ["l", "l", "v", "h", "h"]);

    expect(editor.getSelections()).toEqual([
      {
        type: "charwise",
        anchor: { row: 0, column: 3 },
        head: { row: 0, column: 0 },
        cursor: { row: 0, column: 0 },
      },
    ]);
    expect(vim.modeName).toBe("vim:visual");
  });

  it("deletes backward visual selections", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor);

    runKeys(vim, ["l", "l", "v", "h", "h", "d"]);

    expect(editor.getText()).toBe("");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("lets visual l reach end of line and delete the newline", () => {
    const editor = new InMemoryVimEditor("ab\ncd");
    const vim = new Vim(editor);

    runKeys(vim, ["l", "v", "l", "d"]);

    expect(editor.getText()).toBe("acd");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 1 });
  });

  it("lets visual $ select through the newline", () => {
    const editor = new InMemoryVimEditor("ab\ncd");
    const vim = new Vim(editor);

    runKeys(vim, ["v", "$", "d"]);

    expect(editor.getText()).toBe("cd");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("exits visual-line mode at the motion target", () => {
    const editor = new InMemoryVimEditor("alpha\nbeta\ngamma");
    const vim = new Vim(editor);

    runKeys(vim, ["l", "l", "V", "j", "<escape>"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 1, column: 2 });
  });

  it("supports horizontal motions in visual-line mode", () => {
    const editor = new InMemoryVimEditor("alpha\nbeta\ngamma");
    const vim = new Vim(editor);

    runKeys(vim, ["l", "l", "V", "h", "j", "l", "<escape>"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 1, column: 2 });
  });

  it("adds surrounds around a text object", () => {
    const editor = new InMemoryVimEditor("The quick brown");
    const vim = new Vim(editor);

    runKeys(vim, ["w", "y", "s", "i", "w", "{"]);

    expect(editor.getText()).toBe("The { quick } brown");
    expect(head(editor)).toEqual({ row: 0, column: 4 });
  });

  it("adds compact surrounds with closing bracket keys", () => {
    const editor = new InMemoryVimEditor("The quick brown");
    const vim = new Vim(editor);

    runKeys(vim, ["w", "y", "s", "i", "w", "}"]);

    expect(editor.getText()).toBe("The {quick} brown");
  });

  it("adds surrounds by motion", () => {
    const editor = new InMemoryVimEditor("The quick brown");
    const vim = new Vim(editor);

    runKeys(vim, ["4", "l", "y", "s", "$", "}"]);

    expect(editor.getText()).toBe("The {quick brown}");
  });

  it("deletes surrounds", () => {
    const editor = new InMemoryVimEditor("The { quick } brown");
    const vim = new Vim(editor);

    runKeys(vim, ["6", "l", "d", "s", "{"]);

    expect(editor.getText()).toBe("The quick brown");
    expect(head(editor)).toEqual({ row: 0, column: 4 });
  });

  it("changes surrounds", () => {
    const editor = new InMemoryVimEditor("The {quick} brown");
    const vim = new Vim(editor);

    runKeys(vim, ["6", "l", "c", "s", "{", "["]);

    expect(editor.getText()).toBe("The [ quick ] brown");
    expect(head(editor)).toEqual({ row: 0, column: 4 });
  });

  it("uses shifted surround keys as bracket pairs", () => {
    const editor = new InMemoryVimEditor("The quick brown");
    const vim = new Vim(editor);

    runKeys(vim, ["w", "y", "s", "i", "w", ")"]);

    expect(editor.getText()).toBe("The (quick) brown");
  });

  it("collapses visual-block insert back to one cursor on escape", () => {
    const editor = new InMemoryVimEditor("abc\ndef");
    const vim = new Vim(editor);

    runKeys(vim, ["ctrl-v", "j", "I", "x", "<escape>"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getText()).toBe("xabc\nxdef");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 0 } },
    ]);
  });

  it("syncs external non-empty selections into visual mode without rewriting editor state", () => {
    const editor = new InMemoryVimEditor("abcdef");
    const vim = new Vim(editor);
    const externalSelection = { type: "charwise" as const, anchor: { row: 0, column: 1 }, head: { row: 0, column: 4 } };

    editor.setSelections([externalSelection]);
    vim.syncFromEditorState({ render: false });

    expect(vim.modeName).toBe("vim:visual");
    expect(editor.getSelections()).toEqual([externalSelection]);
  });

  it("can render an externally-adopted visual selection when Vim takes over", () => {
    const editor = new InMemoryVimEditor("abcdef");
    const vim = new Vim(editor);

    editor.setSelections([{ type: "charwise", anchor: { row: 0, column: 1 }, head: { row: 0, column: 4 } }]);
    vim.syncFromEditorState();

    expect(vim.modeName).toBe("vim:visual");
    expect(editor.getSelections()).toEqual([
      {
        type: "charwise",
        anchor: { row: 0, column: 1 },
        head: { row: 0, column: 4 },
        cursor: { row: 0, column: 3 },
      },
    ]);
  });

  it("syncs external zero-width selections into normal mode", () => {
    const editor = new InMemoryVimEditor("abcdef");
    const vim = new Vim(editor);

    runKeys(vim, ["v", "l"]);
    editor.setSelections([charwiseSelection({ row: 0, column: 2 })]);
    vim.syncFromEditorState();

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getSelections()).toEqual([charwiseSelection({ row: 0, column: 2 })]);
  });

  it("clips external end-of-line cursors when syncing into normal mode", () => {
    const editor = new InMemoryVimEditor("abcdef");
    const vim = new Vim(editor);

    editor.setSelections([charwiseSelection({ row: 0, column: 6 })]);
    vim.syncFromEditorState();

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getSelections()).toEqual([charwiseSelection({ row: 0, column: 5 })]);
  });

  it("opens lines above and below using normal VSCode-like edit transactions", () => {
    const editor = new InMemoryVimEditor("alpha\nbeta");
    const vim = new Vim(editor);

    runKeys(vim, ["o", "x", "<escape>", "O", "y", "<escape>"]);

    expect(editor.getText()).toBe("alpha\ny\nx\nbeta");
  });

  it("supports smart-case search", () => {
    const lowerCaseSearchEditor = new InMemoryVimEditor("foo FOO foo");
    const lowerCaseSearchVim = new Vim(lowerCaseSearchEditor);

    runKeys(lowerCaseSearchVim, ["/", "f", "o", "o", "enter"]);
    expect(head(lowerCaseSearchEditor)).toEqual({ row: 0, column: 4 });

    const upperCaseSearchEditor = new InMemoryVimEditor("foo FOO Foo");
    const upperCaseSearchVim = new Vim(upperCaseSearchEditor);

    runKeys(upperCaseSearchVim, ["/", "F", "o", "o", "enter"]);
    expect(head(upperCaseSearchEditor)).toEqual({ row: 0, column: 8 });
  });

  it("treats Vim search queries as regexes", () => {
    const editor = new InMemoryVimEditor("foo axc abc");
    const vim = new Vim(editor);

    runKeys(vim, ["/", "a", ".", "c", "enter"]);

    expect(head(editor)).toEqual({ row: 0, column: 4 });
  });

  it("supports gg and G line motions", () => {
    const editor = new InMemoryVimEditor("  alpha\n  beta\n  gamma");
    const vim = new Vim(editor);

    runKeys(vim, ["G"]);
    expect(head(editor)).toEqual({ row: 2, column: 0 });

    runKeys(vim, ["g", "g"]);
    expect(head(editor)).toEqual({ row: 0, column: 0 });

    runKeys(vim, ["2", "G"]);
    expect(head(editor)).toEqual({ row: 1, column: 0 });
  });
});
