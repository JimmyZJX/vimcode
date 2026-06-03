import { RemapTimeoutKey, layeredConfigValue, normalizeKey } from "./config.js";
import type { VimKeyRemapping } from "./config.js";
import { InMemoryVimEditor } from "./editor.js";
import { Vim, VimModelState, runKeys } from "./vim.js";
import type { VimSystemClipboard } from "./registers.js";
import { TextRange, charwiseSelection, selectionHead } from "./state.js";

function head(editor: InMemoryVimEditor) {
  return selectionHead(editor.getSelections()[0]);
}

async function runKeysAsync(vim: Vim, keys: readonly string[], clipboard: VimSystemClipboard): Promise<void> {
  for (const key of keys) {
    await vim.onKeyAsync(key, { clipboard });
  }
}

class FakeAsyncClipboard implements VimSystemClipboard {
  readCount = 0;
  writes: string[] = [];

  constructor(public text: string) {}

  async readText(): Promise<string> {
    this.readCount++;
    await Promise.resolve();
    return this.text;
  }

  writeText(text: string): void {
    this.text = text;
    this.writes.push(text);
  }
}

class SearchTrackingEditor extends InMemoryVimEditor {
  clearSearchHighlightsCount = 0;
  revealPrimaryCursorCount = 0;
  searchPreviewStartCount = 0;
  searchPreviewEndOptions: { restoreViewport?: boolean }[] = [];
  revealedRanges: TextRange[] = [];

  override clearSearchHighlights(): void {
    this.clearSearchHighlightsCount++;
  }

  override revealPrimaryCursorIfOutsideViewport(): void {
    this.revealPrimaryCursorCount++;
  }

  override beginSearchPreview(): void {
    this.searchPreviewStartCount++;
  }

  override endSearchPreview(options: { restoreViewport?: boolean } = {}): void {
    this.searchPreviewEndOptions.push(options);
  }

  override revealRange(range: TextRange): void {
    this.revealedRanges.push(range);
  }
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

  it("uses vim.useCtrlKeys for unmapped built-in Ctrl keys", () => {
    const vim = new Vim(new InMemoryVimEditor("one\ntwo"), { useCtrlKeys: false });

    expect(vim.shouldHandleKey("ctrl-d")).toBe(false);
    expect(vim.shouldHandleKey("ctrl-h")).toBe(false);
  });

  it("keeps local marks in attached model state", () => {
    const editor = new InMemoryVimEditor("one\ntwo");
    const firstModel = new VimModelState();
    const secondModel = new VimModelState();
    const vim = new Vim(editor, {}, undefined, firstModel);

    runKeys(vim, ["m", "a", "j"]);
    expect(head(editor)).toEqual({ row: 1, column: 0 });

    vim.attachModelState(secondModel);
    runKeys(vim, ["`", "a"]);
    expect(head(editor)).toEqual({ row: 1, column: 0 });

    vim.attachModelState(firstModel);
    runKeys(vim, ["`", "a"]);
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("lets handleKeys force Ctrl key handling", () => {
    const vim = new Vim(new InMemoryVimEditor("one\ntwo"), {
      useCtrlKeys: false,
      handleKeys: { "<C-d>": true },
    });

    expect(vim.shouldHandleKey("ctrl-d")).toBe(true);
  });

  it("handles mapped Ctrl keys even when they are not built-in Vim commands", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {
      useCtrlKeys: false,
      normalModeKeyBindingsNonRecursive: [{ before: ["<C-h>"], after: ["l"] }],
    });

    expect(vim.shouldHandleKey("ctrl-h")).toBe(true);
    runKeys(vim, ["ctrl-h"]);

    expect(head(editor)).toEqual({ row: 0, column: 1 });
  });

  it("does not handle unmapped unsupported Ctrl keys by default", () => {
    const vim = new Vim(new InMemoryVimEditor("abc"));

    expect(vim.shouldHandleKey("ctrl-h")).toBe(false);
  });

  it("delegates Zed-style normal-mode multicursor bindings to VSCode actions", () => {
    const editor = new InMemoryVimEditor("one one one");
    const vim = new Vim(editor);

    expect(vim.shouldHandleKey("ctrl-n")).toBe(true);
    runKeys(vim, ["ctrl-n", "g", "l", "g", "L", "g", ">", "g", "<", "g", "a"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.nativeCommands).toEqual([
      { command: "editor.action.addSelectionToNextFindMatch", args: [] },
      { command: "editor.action.addSelectionToNextFindMatch", args: [] },
      { command: "editor.action.addSelectionToPreviousFindMatch", args: [] },
      { command: "editor.action.moveSelectionToNextFindMatch", args: [] },
      { command: "editor.action.moveSelectionToPreviousFindMatch", args: [] },
      { command: "editor.action.selectHighlights", args: [] },
    ]);
  });

  it("delegates Zed-style visual-mode multicursor bindings to VSCode actions", () => {
    const editor = new InMemoryVimEditor("one one one");
    const vim = new Vim(editor);

    runKeys(vim, ["v", "e", "ctrl-n", "g", "l", "g", "L", "g", ">", "g", "<", "g", "a"]);

    expect(vim.modeName).toBe("vim:visual");
    expect(editor.nativeCommands).toEqual([
      { command: "editor.action.addSelectionToNextFindMatch", args: [] },
      { command: "editor.action.addSelectionToNextFindMatch", args: [] },
      { command: "editor.action.addSelectionToPreviousFindMatch", args: [] },
      { command: "editor.action.moveSelectionToNextFindMatch", args: [] },
      { command: "editor.action.moveSelectionToPreviousFindMatch", args: [] },
      { command: "editor.action.selectHighlights", args: [] },
    ]);
  });

  it("enters visual mode from every normal-mode cursor", () => {
    const editor = new InMemoryVimEditor("one\ntwo");
    const vim = new Vim(editor);

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 0 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 0 } },
    ]);
    runKeys(vim, ["v"]);

    expect(vim.modeName).toBe("vim:visual");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 1 }, cursor: { row: 0, column: 0 }, goal: undefined },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 1 }, cursor: { row: 1, column: 0 }, goal: undefined },
    ]);
  });

  it("clears the desired column when entering visual mode", () => {
    const editor = new InMemoryVimEditor("abcdef\nx\nabcdef");
    const vim = new Vim(editor);

    runKeys(vim, ["5", "l", "j", "v", "j"]);

    expect(vim.modeName).toBe("vim:visual");
    expect(editor.getSelections()).toEqual([
      {
        type: "charwise",
        anchor: { row: 1, column: 0 },
        head: { row: 2, column: 1 },
        cursor: { row: 2, column: 0 },
        goal: { type: "modelColumn", column: 0 },
      },
    ]);
  });

  it("does not move visual mode from an empty line to the next line", () => {
    const editor = new InMemoryVimEditor("\nabc");
    const vim = new Vim(editor);

    runKeys(vim, ["v"]);

    expect(vim.modeName).toBe("vim:visual");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 0 }, cursor: { row: 0, column: 0 }, goal: undefined },
    ]);
  });

  it("surrounds an empty visual selection", () => {
    const editor = new InMemoryVimEditor("\n123456");
    const vim = new Vim(editor);

    runKeys(vim, ["v", "S", "b"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getText()).toBe("()\n123456");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 0 } },
    ]);
  });

  it("does not keep next-line text selected after visual motion returns to an empty line", () => {
    const editor = new InMemoryVimEditor("\n123456");
    const vim = new Vim(editor);

    runKeys(vim, ["v", "j", "l", "l", "k", "S", "b"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getText()).toBe("()\n123456");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 0 } },
    ]);
  });

  it("syncs undo-restored visual multicursor selections into visual mode", () => {
    const editor = new InMemoryVimEditor("one two\none two");
    const vim = new Vim(editor);

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 3 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 3 } },
    ]);
    vim.syncFromUndoRedoState({ render: false });

    expect(vim.modeName).toBe("vim:visual");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 3 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 3 } },
    ]);
  });

  it("turns synced multicursor visual selections into normal-mode cursors on escape", () => {
    const editor = new InMemoryVimEditor("one\ntwo");
    const vim = new Vim(editor);

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 3 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 3 } },
    ]);
    vim.syncFromEditorState({ render: false });

    expect(vim.modeName).toBe("vim:visual");
    runKeys(vim, ["<escape>"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 3 }, head: { row: 0, column: 3 } },
      { type: "charwise", anchor: { row: 1, column: 3 }, head: { row: 1, column: 3 } },
    ]);
  });

  it("does not handle escape in plain normal mode", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);

    expect(vim.shouldHandleKey("<escape>")).toBe(false);
    expect(vim.onKey("<escape>")).toBe("not-handled");
    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 0 } },
    ]);
  });

  it("uses escape to cancel pending normal-mode operators", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);

    runKeys(vim, ["d"]);
    expect(vim.shouldHandleKey("<escape>")).toBe(true);
    expect(vim.onKey("<escape>")).toBe("handled");

    expect(vim.modeName).toBe("vim:normal");
    expect(vim.status.pending).toBe(false);
    expect(editor.getText()).toBe("one");
  });

  it("collapses normal-mode multicursor selections on escape", () => {
    const editor = new InMemoryVimEditor("one\ntwo");
    const vim = new Vim(editor);

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 3 }, head: { row: 0, column: 3 } },
      { type: "charwise", anchor: { row: 1, column: 3 }, head: { row: 1, column: 3 } },
    ]);
    runKeys(vim, ["<escape>"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 3 }, head: { row: 0, column: 3 } },
    ]);
  });

  it("deletes all synced visual multicursor selections", () => {
    const editor = new InMemoryVimEditor("one two\none two");
    const vim = new Vim(editor);

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 3 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 3 } },
    ]);
    vim.syncFromEditorState({ render: false });
    runKeys(vim, ["d"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getText()).toBe(" two\n two");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 0 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 0 } },
    ]);
    expect(vim.readRegister(undefined)).toBe("one\none");
  });

  it("changes all synced visual multicursor selections", () => {
    const editor = new InMemoryVimEditor("one two\none two");
    const vim = new Vim(editor);

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 3 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 3 } },
    ]);
    vim.syncFromEditorState({ render: false });
    runKeys(vim, ["c", "X", "<escape>"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getText()).toBe("X two\nX two");
    expect(vim.readRegister(undefined)).toBe("one\none");
  });

  it("applies visual motions to all synced visual multicursor selections", () => {
    const editor = new InMemoryVimEditor("one two\none two");
    const vim = new Vim(editor);

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 3 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 3 } },
    ]);
    vim.syncFromEditorState({ render: false });
    runKeys(vim, ["l", "d"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getText()).toBe("two\ntwo");
    expect(vim.readRegister(undefined)).toBe("one \none ");
  });

  it("applies text objects to all synced visual multicursor selections", () => {
    const editor = new InMemoryVimEditor("one two\none two");
    const vim = new Vim(editor);

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 1 }, head: { row: 0, column: 2 } },
      { type: "charwise", anchor: { row: 1, column: 5 }, head: { row: 1, column: 6 } },
    ]);
    vim.syncFromEditorState({ render: false });
    runKeys(vim, ["i", "w", "d"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getText()).toBe(" two\none ");
    expect(vim.readRegister(undefined)).toBe("one\ntwo");
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
    expect(normalizeKey("<Del>", "\\")).toBe("delete");
    expect(normalizeKey("<Delete>", "\\")).toBe("delete");
    expect(normalizeKey("<Ins>", "\\")).toBe("insert");
    expect(normalizeKey("<Insert>", "\\")).toBe("insert");
    expect(normalizeKey("<Nop>", "\\")).toBe("<nop>");
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

  it("supports <Nop> normal remaps", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: [{ before: ["x"], after: ["<Nop>"] }],
    });

    runKeys(vim, ["x"]);

    expect(editor.getText()).toBe("abc");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
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

  it("shows pending insert remap text before the timeout finishes", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor, {
      insertModeKeyBindingsNonRecursive: [{ before: ["f", "d"], after: ["<Esc>"] }],
    });

    runKeys(vim, ["A", "f"]);

    expect(vim.modeName).toBe("vim:insert+");
    expect(vim.status.insertPendingText).toBe("f");
    expect(editor.getText()).toBe("one");
  });

  it("replays pending insert remap text when the timeout finishes", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor, {
      insertModeKeyBindingsNonRecursive: [{ before: ["f", "d"], after: ["<Esc>"] }],
    });

    runKeys(vim, ["A", "f", RemapTimeoutKey]);

    expect(vim.modeName).toBe("vim:insert");
    expect(vim.status.insertPendingText).toBeUndefined();
    expect(editor.getText()).toBe("onef");
  });

  it("waits on ambiguous remaps until timeout or a longer match", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor, {
      insertModeKeyBindingsNonRecursive: [
        { before: ["f"], after: ["F"] },
        { before: ["f", "d"], after: ["<Esc>"] },
      ],
    });

    runKeys(vim, ["A", "f"]);
    expect(editor.getText()).toBe("one");
    expect(vim.status.insertPendingText).toBe("f");

    runKeys(vim, [RemapTimeoutKey]);
    expect(editor.getText()).toBe("oneF");
    expect(vim.modeName).toBe("vim:insert");

    runKeys(vim, ["f", "d"]);
    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getText()).toBe("oneF");
  });

  it("runs a shorter ambiguous remap before replaying the disambiguating key", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor, {
      insertModeKeyBindingsNonRecursive: [
        { before: ["f"], after: ["F"] },
        { before: ["f", "d"], after: ["<Esc>"] },
      ],
    });

    runKeys(vim, ["A", "f", "x"]);

    expect(vim.modeName).toBe("vim:insert");
    expect(editor.getText()).toBe("oneFx");
  });

  it("supports <Nop> insert remaps", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor, {
      insertModeKeyBindingsNonRecursive: [{ before: ["x"], after: ["<Nop>"] }],
    });

    runKeys(vim, ["A", "x"]);

    expect(vim.modeName).toBe("vim:insert");
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

  it("supports VSCodeVim-style gh hover", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);

    runKeys(vim, ["g", "h"]);

    expect(editor.nativeCommands).toEqual([
      { command: "editor.action.showHover", args: [] },
    ]);
  });

  it("supports write ex commands", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);

    runKeys(vim, [":", "w", "enter"]);

    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.files.save", args: [] },
    ]);
  });

  it("passes VSCodeVim-style command remap args to native commands", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: [
        { before: ["q"], commands: [{ command: "workbench.action.openSettings", args: ["vim.enabled"] }] },
      ],
    });

    runKeys(vim, ["q"]);

    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.openSettings", args: ["vim.enabled"] },
    ]);
  });

  it("runs remap after-keys before commands like VSCodeVim", () => {
    const editor = new InMemoryVimEditor("abc\ndef");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: [
        { before: ["q"], after: ["l"], commands: [":2"] },
      ],
    });

    runKeys(vim, ["q"]);

    expect(head(editor)).toEqual({ row: 1, column: 0 });
  });

  it("guards recursive remaps whose rhs starts with lhs", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {
      normalModeKeyBindings: [{ before: ["h"], after: ["h", "l"] }],
    });

    runKeys(vim, ["l", "h"]);

    expect(head(editor)).toEqual({ row: 0, column: 1 });
  });

  it("keeps non-recursive remaps non-recursive even when rhs starts with lhs", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: [{ before: ["h"], after: ["h", "l"] }],
    });

    runKeys(vim, ["l", "h"]);

    expect(head(editor)).toEqual({ row: 0, column: 1 });
  });

  it("waits for ambiguous remaps and exposes conflicts for logging", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: [
        { before: ["q"], after: ["l"] },
        { before: ["q", "q"], after: ["l", "l"] },
      ],
    });

    runKeys(vim, ["q"]);

    expect(vim.modeName).toBe("vim:normal+");
    expect(head(editor)).toEqual({ row: 0, column: 0 });

    runKeys(vim, [RemapTimeoutKey]);

    expect(head(editor)).toEqual({ row: 0, column: 1 });
    expect(vim.ambiguousRemapConflicts()).toEqual([
      { mode: "normal", shorter: ["q"], longer: ["q", "q"] },
    ]);
  });

  it("prefers later duplicate remaps like VSCodeVim", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: [
        { before: ["q"], after: ["w"] },
        { before: ["q"], after: ["e"] },
      ],
    });

    runKeys(vim, ["q"]);

    expect(head(editor)).toEqual({ row: 0, column: 2 });
  });

  it("lets base remap settings override layered defaults with the same lhs", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: layeredConfigValue({
        normalModeKeyBindingsNonRecursive__team: [{ before: ["q"], after: ["w"] }],
        normalModeKeyBindingsNonRecursive: [{ before: ["q"], after: ["e"] }],
      }, "normalModeKeyBindingsNonRecursive") as VimKeyRemapping[],
    });

    runKeys(vim, ["q"]);

    expect(head(editor)).toEqual({ row: 0, column: 2 });
  });

  it("supports arrow keys as Vim motions", () => {
    const editor = new InMemoryVimEditor("abc\ndef");
    const vim = new Vim(editor);

    runKeys(vim, ["right", "right", "down", "left", "up"]);

    expect(head(editor)).toEqual({ row: 0, column: 1 });
  });

  it("supports delete key as normal-mode delete-right", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor);

    runKeys(vim, ["delete"]);

    expect(editor.getText()).toBe("bc");
    expect(vim.readRegister(undefined)).toBe("a");
  });

  it("uses VSCodeVim delete-key notation in remaps", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: [{ before: ["<Del>"], after: ["l"] }],
    });

    runKeys(vim, ["delete"]);

    expect(editor.getText()).toBe("abc");
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

  it("supports stepped increment through g ctrl-a", () => {
    const editor = new InMemoryVimEditor("1\n1\n1");
    const vim = new Vim(editor);

    runKeys(vim, ["v", "G", "g", "ctrl-a"]);

    expect(editor.getText()).toBe("2\n3\n4");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
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

  it("keeps gi position in attached model state", () => {
    const editor = new InMemoryVimEditor("abcdef");
    const firstModel = new VimModelState();
    const secondModel = new VimModelState();
    const vim = new Vim(editor, {}, undefined, firstModel);

    runKeys(vim, ["4", "l", "i", "x", "<escape>", "0"]);
    expect(head(editor)).toEqual({ row: 0, column: 0 });

    vim.attachModelState(secondModel);
    runKeys(vim, ["g", "i", "y", "<escape>"]);
    expect(editor.getText()).toBe("yabcdxef");

    vim.attachModelState(firstModel);
    runKeys(vim, ["g", "i", "z", "<escape>"]);
    expect(editor.getText()).toBe("yabcdzxef");
  });

  it("keeps changelist entries in attached model state", () => {
    const editor = new InMemoryVimEditor("one\ntwo\nthree");
    const firstModel = new VimModelState();
    const secondModel = new VimModelState();
    const vim = new Vim(editor, {}, undefined, firstModel);

    runKeys(vim, ["j", "A", "x", "<escape>", "g", "g", "0"]);
    expect(head(editor)).toEqual({ row: 0, column: 0 });

    vim.attachModelState(secondModel);
    runKeys(vim, ["g", ";"]);
    expect(head(editor)).toEqual({ row: 0, column: 0 });

    vim.attachModelState(firstModel);
    runKeys(vim, ["g", ";"]);
    expect(head(editor)).toEqual({ row: 1, column: 3 });
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

  it("preserves target column goals when syncing from editor state", () => {
    const editor = new InMemoryVimEditor("abcdef\nx\nabcdef");
    const vim = new Vim(editor);

    editor.setSelections([{ ...charwiseSelection({ row: 1, column: 0 }), goal: { type: "modelColumn", column: 5 } }]);
    vim.syncFromEditorState();
    runKeys(vim, ["j"]);

    expect(head(editor)).toEqual({ row: 2, column: 5 });
  });

  it("preserves the target column across reveal-line chords", () => {
    const editor = new InMemoryVimEditor("abcdef\nx\nabcdef");
    const vim = new Vim(editor);

    runKeys(vim, ["5", "l", "j", "z", "z", "j"]);

    expect(head(editor)).toEqual({ row: 2, column: 5 });
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

  it("undoes and redoes a normal delete as one edit transaction", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    runKeys(vim, ["d", "w", "u"]);

    expect(editor.getText()).toBe("one two");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 0 });

    runKeys(vim, ["ctrl-r"]);

    expect(editor.getText()).toBe("two");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("undoes a change plus inserted text as one edit transaction", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    runKeys(vim, ["c", "w", "X", "<escape>", "u"]);

    expect(editor.getText()).toBe("one two");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 0 });

    runKeys(vim, ["ctrl-r"]);

    expect(editor.getText()).toBe("X two");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("undoes a visual change plus inserted text as one edit transaction", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    runKeys(vim, ["v", "e", "c", "X", "<escape>", "u"]);

    expect(editor.getText()).toBe("one two");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("undoes an insert session as one edit transaction", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);

    runKeys(vim, ["i", "a", "b", "c", "<escape>", "u"]);

    expect(editor.getText()).toBe("one");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
  });

  it("undoes visual-block append back to one normal cursor", () => {
    const editor = new InMemoryVimEditor("abc\ndef");
    const vim = new Vim(editor);

    runKeys(vim, ["l", "ctrl-v", "j", "A", "X", "<escape>", "u"]);

    expect(editor.getText()).toBe("abc\ndef");
    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 1 }, head: { row: 0, column: 1 } },
    ]);
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

  it("reads system clipboard registers asynchronously only when they are used", async () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);
    const clipboard = new FakeAsyncClipboard(" TWO");

    await runKeysAsync(vim, ["$", "\"", "+"], clipboard);
    expect(clipboard.readCount).toBe(0);

    await runKeysAsync(vim, ["p"], clipboard);

    expect(editor.getText()).toBe("one TWO");
    expect(clipboard.readCount).toBe(1);
  });

  it("uses the system clipboard for the default register when configured", async () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor, { useSystemClipboard: true });
    const clipboard = new FakeAsyncClipboard(" TWO");

    await runKeysAsync(vim, ["$", "p"], clipboard);

    expect(editor.getText()).toBe("one TWO");
    expect(clipboard.readCount).toBe(1);
  });

  it("writes default yanks to the system clipboard when configured", async () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor, { useSystemClipboard: true });
    const clipboard = new FakeAsyncClipboard("");

    await runKeysAsync(vim, ["y", "w"], clipboard);

    expect(clipboard.writes).toEqual(["one "]);
    expect(vim.readRegister(undefined)).toBe("one ");
  });

  it("keeps explicit named registers independent of useSystemClipboard", async () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor, { useSystemClipboard: true });
    const clipboard = new FakeAsyncClipboard("CLIP");

    await runKeysAsync(vim, ["\"", "a", "y", "w", "G", "$", "\"", "a", "p"], clipboard);

    expect(editor.getText()).toBe("one twoone ");
    expect(clipboard.readCount).toBe(0);
  });

  it("restores the full pasted text with visual p gv y clipboard-preserving remaps", async () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      visualModeKeyBindingsNonRecursive: [{ before: ["p"], after: ["p", "g", "v", "y"] }],
    });
    const clipboard = new FakeAsyncClipboard("defgh");

    await runKeysAsync(vim, ["v", "e", "p"], clipboard);

    expect(editor.getText()).toBe("defgh");
    expect(clipboard.writes).toEqual(["abc", "defgh"]);
  });

  it("does not fall back to the unnamed register when the system clipboard is empty", async () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);
    const clipboard = new FakeAsyncClipboard("");

    runKeys(vim, ["y", "w", "$", "\"", "+"]);
    await runKeysAsync(vim, ["p"], clipboard);

    expect(editor.getText()).toBe("one");
    expect(clipboard.readCount).toBe(1);
  });

  it("writes explicit system clipboard registers through the async clipboard context", async () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);
    const clipboard = new FakeAsyncClipboard("");

    await runKeysAsync(vim, ["\"", "+", "y", "w"], clipboard);

    expect(clipboard.writes).toEqual(["one "]);
    expect(vim.readRegister(undefined)).toBe("one ");
  });

  it("inserts from system clipboard registers in insert mode", async () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);
    const clipboard = new FakeAsyncClipboard(" two");

    await runKeysAsync(vim, ["A", "ctrl-r", "+", "<escape>"], clipboard);

    expect(editor.getText()).toBe("one two");
    expect(clipboard.readCount).toBe(1);
  });

  it("pastes from the system clipboard into search mode with ctrl-v and ctrl-y", async () => {
    const editor = new InMemoryVimEditor("foo bar baz");
    const vim = new Vim(editor);
    const clipboard = new FakeAsyncClipboard("ba");

    await runKeysAsync(vim, ["/", "r", "left", "ctrl-v", "enter"], clipboard);
    expect(head(editor)).toEqual({ row: 0, column: 4 });
    expect(clipboard.readCount).toBe(1);

    clipboard.text = "az";
    await runKeysAsync(vim, ["/", "b", "ctrl-y", "enter"], clipboard);
    expect(head(editor)).toEqual({ row: 0, column: 8 });
    expect(clipboard.readCount).toBe(2);
  });

  it("edits the pending search query with a single-line editor", () => {
    const editor = new InMemoryVimEditor("alpha beta gamma");
    const vim = new Vim(editor);

    runKeys(vim, ["/", "a", "l", "p", "x", "left"]);
    expect(vim.status.chord).toBe("/alp|x");

    runKeys(vim, ["delete", "h", "end", "space", "b", "e", "t", "a", "enter"]);

    expect(head(editor)).toEqual({ row: 0, column: 0 });
    expect(vim.readRegister("/")).toBe("alph beta");

    runKeys(vim, ["/", "a", "l", "p", "h", "space", "b", "e", "t", "a", "ctrl-left", "delete", "enter"]);

    expect(vim.readRegister("/")).toBe("alph eta");
  });

  it("reveals pending search matches before enter without moving the cursor", () => {
    const editor = new SearchTrackingEditor("one two one two");
    const vim = new Vim(editor);

    runKeys(vim, ["/"]);
    editor.revealedRanges = [];

    runKeys(vim, ["t"]);

    expect(head(editor)).toEqual({ row: 0, column: 0 });
    expect(editor.revealedRanges[editor.revealedRanges.length - 1]).toEqual({
      start: { row: 0, column: 4 },
      end: { row: 0, column: 5 },
    });

    runKeys(vim, ["w"]);

    expect(head(editor)).toEqual({ row: 0, column: 0 });
    expect(editor.revealedRanges[editor.revealedRanges.length - 1]).toEqual({
      start: { row: 0, column: 4 },
      end: { row: 0, column: 6 },
    });

    runKeys(vim, ["enter"]);

    expect(editor.searchPreviewStartCount).toBe(1);
    expect(editor.searchPreviewEndOptions).toEqual([{ restoreViewport: false }]);
  });

  it("keeps the original cursor and restores search preview viewport after escaping pending search", () => {
    const editor = new SearchTrackingEditor("one two one two");
    const vim = new Vim(editor);

    runKeys(vim, ["/", "t", "<escape>"]);

    expect(head(editor)).toEqual({ row: 0, column: 0 });
    expect(editor.clearSearchHighlightsCount).toBeGreaterThan(0);
    expect(editor.searchPreviewEndOptions).toContainEqual({ restoreViewport: true });
  });

  it("lets unknown ctrl chords fall through in search mode", () => {
    const editor = new InMemoryVimEditor("foo");
    const vim = new Vim(editor);

    runKeys(vim, ["/"]);

    expect(vim.shouldHandleKey("ctrl-a")).toBe(false);
    expect(vim.onKey("ctrl-a")).toBe("not-handled");
    expect(vim.status.chord).toBe("/|");
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

  it("includes both cursor characters for upward visual delete", () => {
    const editor = new InMemoryVimEditor("123\n456");
    const vim = new Vim(editor);

    runKeys(vim, ["j", "l", "v", "k", "d"]);

    expect(editor.getText()).toBe("16");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 1 });
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

  it("extends visual-line mode with ctrl-d", () => {
    const editor = new InMemoryVimEditor("one\ntwo\nthree\nfour\nfive\nsix");
    const vim = new Vim(editor);

    runKeys(vim, ["V", "ctrl-d"]);

    expect(vim.modeName).toBe("vim:visualLine");
    expect(editor.getSelections()).toEqual([
      { type: "linewise", anchorLine: 0, headLine: 3, cursor: { row: 3, column: 0 }, goal: { type: "modelColumn", column: 0 } },
    ]);
  });

  it("supports horizontal motions in visual-line mode", () => {
    const editor = new InMemoryVimEditor("alpha\nbeta\ngamma");
    const vim = new Vim(editor);

    runKeys(vim, ["l", "l", "V", "h", "j", "l", "<escape>"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 1, column: 2 });
  });

  it("keeps visual-line cursor on empty selected lines", () => {
    const editor = new InMemoryVimEditor("ab\n\ncd\nef");
    const vim = new Vim(editor);

    runKeys(vim, ["l", "V", "j"]);

    expect(vim.modeName).toBe("vim:visualLine");
    expect(editor.getSelections()[0]).toEqual({
      type: "linewise",
      anchorLine: 0,
      headLine: 1,
      cursor: { row: 1, column: 0 },
      goal: { type: "modelColumn", column: 1 },
    });

    runKeys(vim, ["j"]);

    expect(editor.getSelections()[0]).toEqual({
      type: "linewise",
      anchorLine: 0,
      headLine: 2,
      cursor: { row: 2, column: 1 },
      goal: { type: "modelColumn", column: 1 },
    });
  });

  it("can use VSCodeVim-style visual-line multiline insert", () => {
    const editor = new InMemoryVimEditor("one\n  two\nthree");
    const vim = new Vim(editor, { visualMultilineInsert: true });

    runKeys(vim, ["V", "j", "I", "x", "<escape>"]);

    expect(editor.getText()).toBe("xone\n  xtwo\nthree");
  });

  it("can use VSCodeVim-style multiline insert for line-spanning visual selections", () => {
    const editor = new InMemoryVimEditor("one\n  two\nthree");
    const vim = new Vim(editor, { visualMultilineInsert: true });

    runKeys(vim, ["v", "j", "I", "x", "<escape>"]);

    expect(editor.getText()).toBe("xone\n  xtwo\nthree");
  });

  it("can use VSCodeVim-style visual-line multiline append", () => {
    const editor = new InMemoryVimEditor("one\n  two\nthree");
    const vim = new Vim(editor, { visualMultilineInsert: true });

    runKeys(vim, ["V", "j", "A", "x", "<escape>"]);

    expect(editor.getText()).toBe("onex\n  twox\nthree");
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

  it("adds surrounds around a visual selection with shift-s", () => {
    const editor = new InMemoryVimEditor("The quick brown");
    const vim = new Vim(editor);

    runKeys(vim, ["w", "v", "e", "S", "b"]);

    expect(editor.getText()).toBe("The (quick) brown");
    expect(vim.modeName).toBe("vim:normal");
  });

  it("undoes visual surround back to normal mode", () => {
    const editor = new InMemoryVimEditor("The quick brown");
    const vim = new Vim(editor);

    runKeys(vim, ["w", "v", "e", "S", "b", "u"]);

    expect(editor.getText()).toBe("The quick brown");
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 4 });
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

  it("clears pending operators when external sync adopts visual mode", () => {
    const editor = new InMemoryVimEditor("abcdef");
    const vim = new Vim(editor);

    runKeys(vim, ["d"]);
    expect(vim.modeName).toBe("vim:normal+");

    editor.setSelections([{ type: "charwise", anchor: { row: 0, column: 1 }, head: { row: 0, column: 4 } }]);
    vim.syncFromEditorState({ render: false });

    expect(vim.modeName).toBe("vim:visual");
    runKeys(vim, ["w"]);
    expect(editor.getText()).toBe("abcdef");
  });

  it("uses exact external backward selection ranges for visual operations", () => {
    const editor = new InMemoryVimEditor("abcdef");
    const vim = new Vim(editor);

    editor.setSelections([{ type: "charwise", anchor: { row: 0, column: 4 }, head: { row: 0, column: 1 } }]);
    vim.syncFromEditorState({ render: false });
    runKeys(vim, ["S", "b"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getText()).toBe("a(bcd)ef");
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

  it("keeps slash search pending across external cursor sync", () => {
    const editor = new InMemoryVimEditor("foo");
    const vim = new Vim(editor);

    runKeys(vim, ["/"]);
    expect(vim.modeName).toBe("vim:search");

    vim.syncFromEditorState();
    expect(vim.modeName).toBe("vim:search");
  });

  it("uses command mode while collecting ex command input", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);

    runKeys(vim, [":"]);
    expect(vim.modeName).toBe("vim:command");

    runKeys(vim, ["w", "enter"]);
    expect(vim.modeName).toBe("vim:normal");
    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.files.save", args: [] },
    ]);
  });

  it("keeps pending operators across external cursor sync", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    runKeys(vim, ["d"]);
    expect(vim.modeName).toBe("vim:normal+");

    vim.syncFromEditorState();
    expect(vim.modeName).toBe("vim:normal+");

    runKeys(vim, ["w"]);
    expect(editor.getText()).toBe("two");
  });

  it("closes search highlights when slash search is cancelled", () => {
    const editor = new SearchTrackingEditor("foo");
    const vim = new Vim(editor);

    runKeys(vim, ["/", "f", "<escape>"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.clearSearchHighlightsCount).toBe(1);
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
