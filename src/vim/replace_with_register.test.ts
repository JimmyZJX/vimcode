import { InMemoryVimEditor } from "./editor.js";
import { Vim, runKeys } from "./vim.js";
import type { VimSystemClipboard } from "./registers.js";
import { charwiseSelection, selectionHead } from "./state.js";

function head(editor: InMemoryVimEditor) {
  return selectionHead(editor.getSelections()[0]);
}

function replaceWithRegisterVim(editor: InMemoryVimEditor) {
  return new Vim(editor, { replaceWithRegister: true });
}

describe("VSCodeVim ReplaceWithRegister compatibility", () => {
  it("defaults off and leaves the gr prefix to LSP bindings in normal and visual mode", () => {
    const normalEditor = new InMemoryVimEditor("one");
    const normalVim = new Vim(normalEditor);
    runKeys(normalVim, ["g", "r", "r"]);
    expect(normalEditor.nativeCommands).toEqual([
      { command: "editor.action.referenceSearch.trigger", args: [] },
    ]);

    const visualEditor = new InMemoryVimEditor("one");
    const visualVim = new Vim(visualEditor);
    runKeys(visualVim, ["v", "g", "r", "n"]);
    expect(visualEditor.nativeCommands).toEqual([
      { command: "editor.action.rename", args: [] },
    ]);
    expect(visualVim.modeName).toBe("vim:visual");
  });

  it("refreshes clipboard-backed registers only after the full target parses", async () => {
    const editor = new InMemoryVimEditor("old target");
    const vim = new Vim(editor, { replaceWithRegister: true, useSystemClipboard: true });
    let reads = 0;
    const clipboard: VimSystemClipboard = {
      readText: async () => {
        reads++;
        return "new";
      },
      writeText: () => {},
    };

    for (const key of ["g", "r", "i"]) {
      await vim.handleKey(key)?.run({ clipboard });
      expect(reads).toBe(0);
    }
    await vim.handleKey("w")?.run({ clipboard });

    expect(reads).toBe(1);
    expect(editor.getText()).toBe("new target");
  });

  it("replaces a motion target without overwriting the register", () => {
    const editor = new InMemoryVimEditor("first second");
    const vim = replaceWithRegisterVim(editor);

    runKeys(vim, ["y", "i", "w", "w", "g", "r", "i", "w"]);

    expect(editor.getText()).toBe("first first");
    expect(head(editor)).toEqual({ row: 0, column: 10 });
    expect(vim.readRegister(undefined)).toBe("first");
  });

  it("supports named registers and dot repeat", () => {
    const editor = new InMemoryVimEditor("one two three");
    const vim = replaceWithRegisterVim(editor);

    runKeys(vim, ["\"", "a", "y", "i", "w", "w", "\"", "a", "g", "r", "i", "w", "w", "."]);

    expect(editor.getText()).toBe("one one one");
    expect(vim.readRegister("a")).toBe("one");
  });

  it("dot-repeats a visual replacement over the same selection shape", () => {
    const editor = new InMemoryVimEditor("one two abc");
    const vim = replaceWithRegisterVim(editor);

    runKeys(vim, ["y", "i", "w", "w", "v", "i", "w", "g", "r", "w", "."]);

    expect(editor.getText()).toBe("one one one");
    expect(vim.readRegister(undefined)).toBe("one");
  });

  it("does not overwrite dot history when the source register is empty", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = replaceWithRegisterVim(editor);

    runKeys(vim, ["x", "\"", "z", "g", "r", "i", "w", "."]);

    expect(editor.getText()).toBe("c");
  });

  it("keeps a visual selection active when the source register is empty", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = replaceWithRegisterVim(editor);

    runKeys(vim, ["v", "i", "w", "\"", "z", "g", "r"]);

    expect(editor.getText()).toBe("abc");
    expect(vim.modeName).toBe("vim:visual");
  });

  it("supports grr, counts, and linewise motions", () => {
    const lineEditor = new InMemoryVimEditor("first second\nthird");
    const lineVim = replaceWithRegisterVim(lineEditor);
    runKeys(lineVim, ["y", "i", "w", "w", "g", "r", "r"]);
    expect(lineEditor.getText()).toBe("first\nthird");
    expect(head(lineEditor)).toEqual({ row: 0, column: 0 });

    const countEditor = new InMemoryVimEditor("first\nsecond\nthird");
    const countVim = replaceWithRegisterVim(countEditor);
    runKeys(countVim, ["y", "i", "w", "2", "g", "r", "r"]);
    expect(countEditor.getText()).toBe("first\nthird");

    const motionEditor = new InMemoryVimEditor("first second\nthird fourth\nfifth sixth");
    const motionVim = replaceWithRegisterVim(motionEditor);
    runKeys(motionVim, ["y", "i", "w", "w", "g", "r", "j"]);
    expect(motionEditor.getText()).toBe("first\nfifth sixth");
  });

  it("replaces characterwise and linewise visual selections", () => {
    const charEditor = new InMemoryVimEditor("first second");
    const charVim = replaceWithRegisterVim(charEditor);
    runKeys(charVim, ["y", "i", "w", "w", "v", "i", "w", "g", "r"]);
    expect(charEditor.getText()).toBe("first first");
    expect(head(charEditor)).toEqual({ row: 0, column: 10 });

    const lineEditor = new InMemoryVimEditor("first second");
    const lineVim = replaceWithRegisterVim(lineEditor);
    runKeys(lineVim, ["y", "i", "w", "w", "V", "g", "r"]);
    expect(lineEditor.getText()).toBe("first");
    expect(head(lineEditor)).toEqual({ row: 0, column: 4 });
  });

  it("preserves prefixes outside multiline visual selections", () => {
    const editor = new InMemoryVimEditor("src\n  alpha\n  beta");
    const vim = replaceWithRegisterVim(editor);

    runKeys(vim, ["y", "i", "w", "j", "l", "l", "v", "j", "g", "r"]);

    expect(editor.getText()).toBe("src\n  srceta");
  });

  it("distributes multicursor register parts by source selection", () => {
    const editor = new InMemoryVimEditor("one\ntwo\nred\nblue");
    editor.setSelections([
      charwiseSelection({ row: 0, column: 0 }),
      charwiseSelection({ row: 2, column: 0 }),
    ]);
    const vim = replaceWithRegisterVim(editor);

    runKeys(vim, ["y", "i", "w", "w", "g", "r", "i", "w"]);

    expect(editor.getText()).toBe("one\none\nred\nred");
  });

  it("preserves multiline linewise register contents", () => {
    const editor = new InMemoryVimEditor("{\n  first\n  second\n  third\n}");
    editor.setSelections([charwiseSelection({ row: 2, column: 2 })]);
    const vim = replaceWithRegisterVim(editor);

    runKeys(vim, ["y", "j", "g", "r", "i", "}"]);

    expect(editor.getText()).toBe("{\n  second\n  third\n}");
    expect(head(editor)).toEqual({ row: 1, column: 2 });
    expect(vim.readRegister(undefined)).toBe("  second\n  third\n");
  });

  it("keeps yi} followed by gri} as a no-op apart from cursor movement", () => {
    const editor = new InMemoryVimEditor("{\n  first\n  second\n  third\n}");
    editor.setSelections([charwiseSelection({ row: 2, column: 2 })]);
    const vim = replaceWithRegisterVim(editor);

    runKeys(vim, ["y", "i", "}", "g", "r", "i", "}"]);

    expect(editor.getText()).toBe("{\n  first\n  second\n  third\n}");
    expect(head(editor)).toEqual({ row: 1, column: 2 });
  });

  it("matches VSCodeVim multiline object geometry with a characterwise register", () => {
    const editor = new InMemoryVimEditor("{\n  first\n  second\n  third\n}");
    editor.setSelections([charwiseSelection({ row: 2, column: 2 })]);
    const vim = replaceWithRegisterVim(editor);

    runKeys(vim, ["y", "i", "w", "g", "r", "i", "}"]);

    expect(editor.getText()).toBe("{\nsecond\n}");
    expect(head(editor)).toEqual({ row: 1, column: 0 });
  });
});
