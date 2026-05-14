import { InMemoryVimEditor } from "./editor.js";
import { Vim, runKeys } from "./vim.js";
import { charwiseSelection, selectionHead } from "./state.js";

function head(editor: InMemoryVimEditor) {
  return selectionHead(editor.getSelections()[0]);
}

describe("Zed-inspired Vim core smoke tests", () => {
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

  it("opens lines above and below using normal VSCode-like edit transactions", () => {
    const editor = new InMemoryVimEditor("alpha\nbeta");
    const vim = new Vim(editor);

    runKeys(vim, ["o", "x", "<escape>", "O", "y", "<escape>"]);

    expect(editor.getText()).toBe("alpha\ny\nx\nbeta");
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
