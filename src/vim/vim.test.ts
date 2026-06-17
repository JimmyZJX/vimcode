import { RemapTimeoutKey, layeredConfigValue, normalizeKey } from "./config.js";
import type { VimKeyRemapping } from "./config.js";
import { InMemoryVimEditor } from "./editor.js";
import type { HostRevealTarget } from "./editor.js";
import { Vim, VimModelState, runKeys } from "./vim.js";
import type { VimSystemClipboard } from "./registers.js";
import type { SearchDirection, SearchOptions } from "./search.js";
import { TextRange, charwiseSelection, selectionHead } from "./state.js";

function head(editor: InMemoryVimEditor) {
  return selectionHead(editor.getSelections()[0]);
}

async function runKeysAsync(vim: Vim, keys: readonly string[], clipboard: VimSystemClipboard): Promise<void> {
  for (const key of keys) {
    await vim.handleKey(key)?.run({ clipboard });
  }
}

async function runKeysWithWhen(vim: Vim, keys: readonly string[], activeWhen: string): Promise<void> {
  for (const key of keys) {
    await vim.handleKey(key, { remapWhen: when => when === undefined || when === activeWhen })?.run();
  }
}

function exKeys(command: string): string[] {
  return [":", ...[...command].map(key => key === " " ? "space" : key), "enter"];
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

class ActionTrackingEditor extends InMemoryVimEditor {
  revealCurrentLineTargets: string[] = [];

  override revealCurrentLine(target: HostRevealTarget): void {
    this.revealCurrentLineTargets.push(target);
  }
}

class SearchTrackingEditor extends InMemoryVimEditor {
  clearSearchHighlightsCount = 0;
  revealPrimaryCursorCount = 0;
  searchPreviewStartCount = 0;
  searchPreviewEndOptions: { restoreViewport?: boolean }[] = [];
  revealedRanges: TextRange[] = [];
  searchUpdates: { query: string; reveal: boolean | undefined }[] = [];

  override updateSearch(query: string, direction: SearchDirection, options: SearchOptions = {}): void {
    this.searchUpdates.push({ query, reveal: options.reveal });
    super.updateSearch(query, direction, options);
  }

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

    expect(vim.wouldHandleKeyForTest("ctrl-d")).toBe(false);
    expect(vim.wouldHandleKeyForTest("ctrl-h")).toBe(false);
  });

  // Drives the shrinking pending-cursor presentation: depth is the size of
  // the pending input stack, not the number of typed characters — a count is
  // one entry no matter how many digits, and `2d` folds the count into the
  // pending operator.
  it("reports the pending-stack depth", () => {
    const editor = new InMemoryVimEditor("one two three\nfour");
    const vim = new Vim(editor);

    expect(vim.status.pendingDepth).toBe(0);
    runKeys(vim, ["2"]);
    expect(vim.status.pendingDepth).toBe(1);
    runKeys(vim, ["1"]);
    expect(vim.status.pendingDepth).toBe(1);
    runKeys(vim, ["d"]);
    expect(vim.status.pendingDepth).toBe(1);
    runKeys(vim, ["3"]);
    expect(vim.status.pendingDepth).toBe(2);
    runKeys(vim, ["i"]);
    expect(vim.status.pendingDepth).toBe(3);
    runKeys(vim, ["<escape>"]);
    expect(vim.status.pendingDepth).toBe(0);

    runKeys(vim, ["d", "w"]);
    expect(vim.status.pendingDepth).toBe(0);

    runKeys(vim, ["g"]);
    expect(vim.status.pendingDepth).toBe(1);
    runKeys(vim, ["g"]);
    expect(vim.status.pendingDepth).toBe(0);

    // `"` awaiting the register name and the selected register afterwards are
    // both one level; a pending operator stacks on top.
    runKeys(vim, ["\""]);
    expect(vim.status.pendingDepth).toBe(1);
    runKeys(vim, ["a"]);
    expect(vim.status.pendingDepth).toBe(1);
    runKeys(vim, ["d"]);
    expect(vim.status.pendingDepth).toBe(2);
    runKeys(vim, ["<escape>"]);
    expect(vim.status.pendingDepth).toBe(0);
  });

  // Insert mode delegates plain typing to the host editor unless Vim needs to
  // capture the key stream for macro recording; replace mode must own text
  // keys because native typing inserts instead of overwriting.
  it("owns plain text keys in insert mode only while recording", () => {
    const editor = new InMemoryVimEditor("abcdef");
    const vim = new Vim(editor);

    runKeys(vim, ["i"]);
    expect(vim.wouldHandleKeyForTest("x")).toBe(false);
    expect(vim.wouldHandleKeyForTest("backspace")).toBe(false);

    runKeys(vim, ["<escape>", "q", "q", "a"]);
    expect(vim.modeName).toBe("vim:insert");
    expect(vim.wouldHandleKeyForTest("x")).toBe(true);
    expect(vim.wouldHandleKeyForTest("space")).toBe(true);
    expect(vim.wouldHandleKeyForTest("enter")).toBe(true);
    expect(vim.wouldHandleKeyForTest("backspace")).toBe(false);
    runKeys(vim, ["<escape>", "q"]);

    runKeys(vim, ["R"]);
    expect(vim.wouldHandleKeyForTest("x")).toBe(true);
    expect(vim.wouldHandleKeyForTest("space")).toBe(true);
    expect(vim.wouldHandleKeyForTest("enter")).toBe(true);
    expect(vim.wouldHandleKeyForTest("backspace")).toBe(true);

    const plan = vim.handleKey("x");
    expect(plan).not.toBeNull();
  });

  it("delegates unsupported insert-mode Ctrl keys to VSCode", () => {
    const vim = new Vim(new InMemoryVimEditor("abcdef"));

    runKeys(vim, ["i"]);

    expect(vim.wouldHandleKeyForTest("ctrl-n")).toBe(false);
    expect(vim.wouldHandleKeyForTest("ctrl-p")).toBe(false);
    expect(vim.wouldHandleKeyForTest("ctrl-w")).toBe(true);
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

    expect(vim.wouldHandleKeyForTest("ctrl-d")).toBe(true);
  });

  it("handles mapped Ctrl keys even when they are not built-in Vim commands", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {
      useCtrlKeys: false,
      normalModeKeyBindingsNonRecursive: [{ before: ["<C-h>"], after: ["l"] }],
    });

    expect(vim.wouldHandleKeyForTest("ctrl-h")).toBe(true);
    runKeys(vim, ["ctrl-h"]);

    expect(head(editor)).toEqual({ row: 0, column: 1 });
  });

  it("does not handle unmapped unsupported Ctrl keys by default", () => {
    const vim = new Vim(new InMemoryVimEditor("abc"));

    expect(vim.wouldHandleKeyForTest("ctrl-h")).toBe(false);
  });

  it("delegates Zed-style normal-mode multicursor bindings to VSCode actions", () => {
    const editor = new InMemoryVimEditor("one one one");
    const vim = new Vim(editor);

    expect(vim.wouldHandleKeyForTest("ctrl-n")).toBe(true);
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

  it("delegates basic VSCodeVim ctrl-w window commands to VSCode actions", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    runKeys(vim, [
      "ctrl-w", "h",
      "ctrl-w", "ctrl-l",
      "ctrl-w", "j",
      "ctrl-w", "up",
      "ctrl-w", "w",
      "ctrl-w", "ctrl-w",
      "ctrl-w", "v",
      "ctrl-w", "ctrl-s",
      "ctrl-w", "=",
      "ctrl-w", ">",
      "ctrl-w", "<",
      "ctrl-w", "+",
      "ctrl-w", "-",
      "ctrl-w", "q",
      "ctrl-w", "ctrl-c",
      "ctrl-w", "o",
    ]);

    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.navigateLeft", args: [] },
      { command: "workbench.action.navigateRight", args: [] },
      { command: "workbench.action.navigateDown", args: [] },
      { command: "workbench.action.navigateUp", args: [] },
      { command: "workbench.action.navigateEditorGroups", args: [] },
      { command: "workbench.action.navigateEditorGroups", args: [] },
      { command: "workbench.action.splitEditor", args: [] },
      { command: "workbench.action.splitEditorOrthogonal", args: [] },
      { command: "workbench.action.evenEditorWidths", args: [] },
      { command: "workbench.action.increaseViewWidth", args: [] },
      { command: "workbench.action.decreaseViewWidth", args: [] },
      { command: "workbench.action.increaseViewHeight", args: [] },
      { command: "workbench.action.decreaseViewHeight", args: [] },
      { command: "workbench.action.closeActiveEditor", args: [] },
      { command: "workbench.action.closeActiveEditor", args: [] },
      { command: "workbench.action.maximizeEditor", args: [] },
    ]);
  });

  it("supports VSCodeVim z scroll chords in visual modes", () => {
    const visualEditor = new ActionTrackingEditor("one\ntwo\nthree");
    const visualVim = new Vim(visualEditor);
    runKeys(visualVim, ["v", "j", "z", "z", "z", "t", "z", "b"]);
    expect(visualVim.modeName).toBe("vim:visual");
    expect(visualEditor.revealCurrentLineTargets).toEqual(["center", "top", "bottom"]);

    const lineEditor = new ActionTrackingEditor("one\ntwo\nthree");
    const lineVim = new Vim(lineEditor);
    runKeys(lineVim, ["V", "z", "z"]);
    expect(lineVim.modeName).toBe("vim:visualLine");
    expect(lineEditor.revealCurrentLineTargets).toEqual(["center"]);

    const blockEditor = new ActionTrackingEditor("one\ntwo\nthree");
    const blockVim = new Vim(blockEditor);
    runKeys(blockVim, ["ctrl-v", "j", "z", "z"]);
    expect(blockVim.modeName).toBe("vim:visualBlock");
    expect(blockEditor.revealCurrentLineTargets).toEqual(["center"]);
  });

  it("delegates VSCodeVim tab navigation keys to VSCode actions", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    runKeys(vim, [
      "g", "t",
      "g", "T",
      "ctrl-pagedown",
      "ctrl-pageup",
      "2", "g", "t",
      "3", "g", "T",
    ]);

    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.nextEditorInGroup", args: [] },
      { command: "workbench.action.previousEditorInGroup", args: [] },
      { command: "workbench.action.nextEditorInGroup", args: [] },
      { command: "workbench.action.previousEditorInGroup", args: [] },
      { command: "workbench.action.openEditorAtIndex", args: [1] },
      { command: "workbench.action.previousEditorInGroup", args: [] },
      { command: "workbench.action.previousEditorInGroup", args: [] },
      { command: "workbench.action.previousEditorInGroup", args: [] },
    ]);
  });

  it("runs EasyMotion word jumps with VSCodeVim leader bindings", () => {
    const editor = new InMemoryVimEditor("one two three");
    const vim = new Vim(editor, { easymotion: true });

    runKeys(vim, ["\\", "\\", "w"]);

    expect(editor.easyMotionMarkers).toEqual([
      { label: "h", position: { row: 0, column: 4 } },
      { label: "k", position: { row: 0, column: 8 } },
    ]);
    expect(vim.status.pending).toBe(true);

    runKeys(vim, ["h"]);

    expect(head(editor)).toEqual({ row: 0, column: 4 });
    expect(editor.easyMotionMarkers).toEqual([]);
    expect(vim.status.pending).toBe(false);
  });


  it("runs EasyMotion character searches", () => {
    const editor = new InMemoryVimEditor("foo bar foo");
    const vim = new Vim(editor, { easymotion: true, easymotionKeys: "abcdef" });

    runKeys(vim, ["\\", "\\", "f", "o"]);

    expect(editor.easyMotionMarkers.slice(0, 2)).toEqual([
      { label: "a", position: { row: 0, column: 1 } },
      { label: "b", position: { row: 0, column: 2 } },
    ]);

    runKeys(vim, ["a"]);

    expect(head(editor)).toEqual({ row: 0, column: 1 });
    expect(editor.easyMotionMarkers).toEqual([]);
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
    vim.syncFromUndoRedoState();

    expect(vim.modeName).toBe("vim:visual");
    // The external selections are already canonical-equivalent, so adoption
    // leaves the editor state untouched (preserving native gesture state).
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 3 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 3 } },
    ]);
  });

  it("canonicalizes synced native multicursor visual selections into Vim-owned selections", () => {
    const editor = new InMemoryVimEditor("one\ntwo");
    const vim = new Vim(editor);

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 3 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 3 } },
    ]);
    vim.syncFromEditorState({ canonicalizeVisualSelection: true });

    expect(vim.modeName).toBe("vim:visual");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 3 }, cursor: { row: 0, column: 2 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 3 }, cursor: { row: 1, column: 2 } },
    ]);

    runKeys(vim, ["<escape>"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 2 }, head: { row: 0, column: 2 } },
      { type: "charwise", anchor: { row: 1, column: 2 }, head: { row: 1, column: 2 } },
    ]);
  });

  it("does not handle escape in plain normal mode", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);

    expect(vim.wouldHandleKeyForTest("<escape>")).toBe(false);
    expect(vim.onKey("<escape>")).toBe("native");
    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 0 } },
    ]);
  });

  it("uses escape to cancel pending normal-mode operators", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);

    runKeys(vim, ["d"]);
    expect(vim.wouldHandleKeyForTest("<escape>")).toBe(true);
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
    vim.syncFromEditorState();
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
    vim.syncFromEditorState();
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
    vim.syncFromEditorState();
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
    vim.syncFromEditorState();
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

  it("lets unrelated insert keys fall through even when insert remaps exist", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor, {
      insertModeKeyBindingsNonRecursive: [{ before: ["f", "d"], after: ["<Esc>"] }],
    });

    runKeys(vim, ["A"]);

    expect(vim.wouldHandleKeyForTest("backspace")).toBe(false);
    expect(vim.wouldHandleKeyForTest("left")).toBe(false);
    expect(vim.wouldHandleKeyForTest("tab")).toBe(false);
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

  it("activates insert remaps only when their when clause matches", async () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor, {
      insertModeKeyBindingsNonRecursive: [{ before: ["x", "y"], after: ["Z"], when: "vimcode.test" }],
    });

    runKeys(vim, ["A"]);

    expect(vim.handleKey("x", { remapWhen: when => when !== "vimcode.test" })).toBeNull();

    await runKeysWithWhen(vim, ["x", "y"], "vimcode.test");

    expect(vim.modeName).toBe("vim:insert");
    expect(editor.getText()).toBe("oneZ");
  });

  it("recognizes normal-mode chord remaps only when their when clause matches", async () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: [{ before: ["!", "r"], after: ["l"], when: "vimcode.test" }],
    });

    expect(vim.hasActiveRemapStartingWithOrPending("!", when => when !== "vimcode.test")).toBe(false);
    expect(vim.hasActiveRemapStartingWithOrPending("!", when => when === "vimcode.test")).toBe(true);

    await runKeysWithWhen(vim, ["!", "r"], "vimcode.test");

    expect(head(editor)).toEqual({ row: 0, column: 1 });
  });

  it("supports VSCodeVim-style visual remaps", () => {
    const editor = new InMemoryVimEditor("abc def");
    const vim = new Vim(editor, {
      visualModeKeyBindingsNonRecursive: [{ before: ["q"], after: ["g", "U"] }],
    });

    runKeys(vim, ["v", "w", "q"]);

    expect(editor.getText()).toBe("ABC Def");
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

  it("runs VSCodeVim-compatible vim.remap command args", () => {
    const editor = new InMemoryVimEditor("one\ntwo");
    const vim = new Vim(editor);

    vim.executeExternalRemap({
      after: ["j"],
      commands: [":1", { command: "workbench.action.openSettings", args: ["vim.enabled"] }],
    });

    expect(head(editor)).toEqual({ row: 0, column: 0 });
    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.openSettings", args: ["vim.enabled"] },
    ]);
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

  it("supports quit ex commands", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);

    runKeys(vim, [":", "q", "enter"]);

    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.closeActiveEditor", args: [] },
    ]);
  });

  it("supports bang quit ex commands", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);

    runKeys(vim, [":", "q", "!", "enter", ":", "q", "u", "!", "enter"]);

    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.revertAndCloseActiveEditor", args: [] },
      { command: "workbench.action.revertAndCloseActiveEditor", args: [] },
    ]);
  });

  it("supports Vim-style abbreviated ex commands", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);

    runKeys(vim, [":", "w", "r", "enter", ":", "q", "u", "enter"]);

    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.files.save", args: [] },
      { command: "workbench.action.closeActiveEditor", args: [] },
    ]);
  });

  it("supports basic VSCodeVim buffer and tab ex commands", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);

    runKeys(vim, [
      ":", "b", "n", "enter",
      ":", "b", "N", "enter",
      ":", "b", "p", "enter",
      ":", "t", "a", "b", "n", "enter",
      ":", "t", "a", "b", "N", "enter",
      ":", "t", "a", "b", "p", "enter",
      ":", "b", "d", "enter",
      ":", "b", "d", "!", "enter",
    ]);

    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.nextEditorInGroup", args: [] },
      { command: "workbench.action.previousEditorInGroup", args: [] },
      { command: "workbench.action.previousEditorInGroup", args: [] },
      { command: "workbench.action.nextEditorInGroup", args: [] },
      { command: "workbench.action.previousEditorInGroup", args: [] },
      { command: "workbench.action.previousEditorInGroup", args: [] },
      { command: "workbench.action.closeActiveEditor", args: [] },
      { command: "workbench.action.revertAndCloseActiveEditor", args: [] },
    ]);
  });

  it("supports more VSCodeVim window, tab, and save ex commands", () => {
    const editor = new InMemoryVimEditor("one");
    const vim = new Vim(editor);

    runKeys(vim, [
      ...exKeys("vsplit"),
      ...exKeys("split"),
      ...exKeys("vnew"),
      ...exKeys("new"),
      ...exKeys("enew"),
      ...exKeys("only"),
      ...exKeys("qa"),
      ...exKeys("quitall"),
      ...exKeys("wq"),
      ...exKeys("xit"),
      ...exKeys("wa"),
      ...exKeys("wqall"),
      ...exKeys("xall"),
      ...exKeys("edit!"),
      ...exKeys("close"),
      ...exKeys("bfirst"),
      ...exKeys("brewind"),
      ...exKeys("blast"),
      ...exKeys("tabnew"),
      ...exKeys("tabedit"),
      ...exKeys("tabclose"),
      ...exKeys("tabonly"),
      ...exKeys("tabfirst"),
      ...exKeys("tabrewind"),
      ...exKeys("tablast"),
      ...exKeys("terminal"),
      ...exKeys("cclose"),
      ...exKeys("copen"),
      ...exKeys("cwindow"),
      ...exKeys("cnext"),
      ...exKeys("cnfile"),
      ...exKeys("cprevious"),
      ...exKeys("cpfile"),
      ...exKeys("lclose"),
      ...exKeys("lopen"),
      ...exKeys("lwindow"),
      ...exKeys("lnext"),
      ...exKeys("lprevious"),
      ...exKeys("ls"),
      ...exKeys("vscode workbench.action.toggleSidebarVisibility"),
    ]);

    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.splitEditor", args: [] },
      { command: "workbench.action.splitEditorOrthogonal", args: [] },
      { command: "workbench.action.splitEditor", args: [] },
      { command: "workbench.action.files.newUntitledFile", args: [] },
      { command: "workbench.action.splitEditorOrthogonal", args: [] },
      { command: "workbench.action.files.newUntitledFile", args: [] },
      { command: "workbench.action.files.newUntitledFile", args: [] },
      { command: "workbench.action.maximizeEditor", args: [] },
      { command: "workbench.action.closeAllEditors", args: [] },
      { command: "workbench.action.closeAllEditors", args: [] },
      { command: "workbench.action.files.save", args: [] },
      { command: "workbench.action.closeActiveEditor", args: [] },
      { command: "workbench.action.files.save", args: [] },
      { command: "workbench.action.closeActiveEditor", args: [] },
      { command: "workbench.action.files.saveAll", args: [] },
      { command: "workbench.action.files.saveAll", args: [] },
      { command: "workbench.action.closeAllEditors", args: [] },
      { command: "workbench.action.files.saveAll", args: [] },
      { command: "workbench.action.closeAllEditors", args: [] },
      { command: "workbench.action.files.revert", args: [] },
      { command: "workbench.action.closeActiveEditor", args: [] },
      { command: "workbench.action.firstEditorInGroup", args: [] },
      { command: "workbench.action.firstEditorInGroup", args: [] },
      { command: "workbench.action.lastEditorInGroup", args: [] },
      { command: "workbench.action.files.newUntitledFile", args: [] },
      { command: "workbench.action.files.newUntitledFile", args: [] },
      { command: "workbench.action.closeActiveEditor", args: [] },
      { command: "workbench.action.closeOtherEditors", args: [] },
      { command: "workbench.action.firstEditorInGroup", args: [] },
      { command: "workbench.action.firstEditorInGroup", args: [] },
      { command: "workbench.action.lastEditorInGroup", args: [] },
      { command: "workbench.action.createTerminalEditor", args: [] },
      { command: "workbench.action.closePanel", args: [] },
      { command: "workbench.panel.markers.view.focus", args: [] },
      { command: "workbench.panel.markers.view.focus", args: [] },
      { command: "editor.action.marker.nextInFiles", args: [] },
      { command: "editor.action.marker.nextInFiles", args: [] },
      { command: "editor.action.marker.prevInFiles", args: [] },
      { command: "editor.action.marker.prevInFiles", args: [] },
      { command: "workbench.action.closePanel", args: [] },
      { command: "workbench.action.focusCommentsPanel", args: [] },
      { command: "workbench.action.focusCommentsPanel", args: [] },
      { command: "editor.action.nextCommentThreadAction", args: [] },
      { command: "editor.action.previousCommentThreadAction", args: [] },
      { command: "workbench.action.quickOpenLeastRecentlyUsedEditorInGroup", args: [] },
      { command: "workbench.action.toggleSidebarVisibility", args: [] },
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
      cursor: { row: 0, column: 4 },
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

    expect(editor.getText()).toBe("ABC Def");
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

  it("supports insert-mode ctrl-w across line boundaries", () => {
    const bolEditor = new InMemoryVimEditor("hello\nworld");
    const bolVim = new Vim(bolEditor);

    runKeys(bolVim, ["j", "I", "ctrl-w", "<escape>"]);

    expect(bolEditor.getText()).toBe("world");
    expect(head(bolEditor)).toEqual({ row: 0, column: 0 });

    const indentedEditor = new InMemoryVimEditor("hello  \n  world");
    const indentedVim = new Vim(indentedEditor);

    runKeys(indentedVim, ["j", "I", "ctrl-w", "<escape>"]);

    expect(indentedEditor.getText()).toBe("world");
    expect(head(indentedEditor)).toEqual({ row: 0, column: 0 });
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

  it("shows macro recording status with the target register and recorded keys", () => {
    const editor = new InMemoryVimEditor("abqc");
    const vim = new Vim(editor);

    runKeys(vim, ["q", "q"]);
    expect(vim.status.macroRecording).toEqual({ register: "q", keys: [] });
    expect(vim.status.text).toBe("NORMAL recording @q");

    runKeys(vim, ["f"]);
    expect(vim.status.text).toBe("NORMAL f recording @q: f");

    runKeys(vim, ["q"]);
    expect(vim.status.macroRecording).toEqual({ register: "q", keys: ["f", "q"] });
    expect(vim.status.text).toBe("NORMAL recording @q: fq");

    runKeys(vim, ["x"]);
    expect(editor.getText()).toBe("abc");
    expect(vim.status.macroRecording).toEqual({ register: "q", keys: ["f", "q", "x"] });
    expect(vim.status.text).toBe("NORMAL recording @q: fqx");

    runKeys(vim, ["q"]);
    expect(vim.status.macroRecording).toBeUndefined();
    expect(vim.status.text).toBe("NORMAL");
  });

  it("records insert-mode text keys into macros through the handled-key path", async () => {
    const editor = new InMemoryVimEditor("");
    const vim = new Vim(editor);

    for (const key of ["q", "q", "a", "a", "b", "c", "<escape>", "q"]) {
      await vim.handleKey(key)?.run();
    }

    expect(editor.getText()).toBe("abc");

    for (const key of ["@", "q"]) {
      await vim.handleKey(key)?.run();
    }

    expect(editor.getText()).toBe("abcabc");
  });

  it("records waiting-input keys into macros", () => {
    // Regression: keys consumed by waiting input (find targets, search input,
    // register names, mark names) must be macro-recorded so replays work.
    const findEditor = new InMemoryVimEditor("axbxc\naxbxc");
    const findVim = new Vim(findEditor);
    runKeys(findVim, ["q", "q", "f", "x", "x", "q", "j", "0", "@", "q"]);
    expect(findEditor.getText()).toBe("abxc\nabxc");

    const searchEditor = new InMemoryVimEditor("one two\none two");
    const searchVim = new Vim(searchEditor);
    runKeys(searchVim, ["q", "q", "/", "t", "w", "o", "enter", "x", "q", "j", "0", "@", "q"]);
    expect(searchEditor.getText()).toBe("one wo\none wo");

    const registerEditor = new InMemoryVimEditor("abc\ndef");
    const registerVim = new Vim(registerEditor);
    runKeys(registerVim, ["q", "q", "\"", "z", "y", "y", "q", "j", "@", "q"]);
    expect(registerVim.readRegister("z")).toBe("def\n");
  });

  it("lets waiting input win over macro control keys", () => {
    // Regression: while recording, `f q` finds the character q and `m q` sets
    // mark q; the recording-stop key only applies when nothing is waiting.
    const findEditor = new InMemoryVimEditor("abqc");
    const findVim = new Vim(findEditor);
    runKeys(findVim, ["q", "q", "f", "q", "x", "q"]);
    expect(findEditor.getText()).toBe("abc");

    const markEditor = new InMemoryVimEditor("abc");
    const markVim = new Vim(markEditor);
    runKeys(markVim, ["q", "q", "m", "q", "q", "l", "l", "`", "q"]);
    expect(head(markEditor)).toEqual({ row: 0, column: 0 });
  });

  it("does not record the macro-stop key into the macro", () => {
    const editor = new InMemoryVimEditor("aaa");
    const vim = new Vim(editor);
    runKeys(vim, ["q", "q", "x", "q", "@", "q"]);
    expect(editor.getText()).toBe("a");
  });

  it("undoes each macro replay as one edit transaction", () => {
    const editor = new InMemoryVimEditor("abcdefghijklmnop");
    const vim = new Vim(editor);

    runKeys(vim, ["q", "x", "x", "x", "x", "q", "@", "x", "@", "x"]);
    expect(editor.getText()).toBe("jklmnop");

    runKeys(vim, ["u"]);
    expect(editor.getText()).toBe("ghijklmnop");

    runKeys(vim, ["u"]);
    expect(editor.getText()).toBe("defghijklmnop");
  });

  it("dot-repeats a delete with a jump-motion target", () => {
    // Regression: the `'` and mark keys of `d'a` are repeat-recorded, so `.`
    // replays the full change (recording is positionally uniform now).
    const editor = new InMemoryVimEditor("one\ntwo\nthree\nfour\nfive");
    const vim = new Vim(editor);
    runKeys(vim, ["j", "m", "a", "k", "d", "'", "a", "j", "m", "a", "k", "."]);
    expect(editor.getText()).toBe("three\nfour\nfive");
  });

  it("deletes inner single-quote and backtick objects", () => {
    // Regression: a pending text object owns the quote/backtick key; it must
    // not be stolen by the `'`/`` ` `` jump bindings (`d'a` still jumps).
    const editor = new InMemoryVimEditor("say 'hello world' now");
    const vim = new Vim(editor);

    runKeys(vim, ["f", "h", "d", "i", "'"]);
    expect(editor.getText()).toBe("say '' now");
    expect(vim.status.pending).toBe(false);

    const backtickEditor = new InMemoryVimEditor("say `hello` now");
    const backtickVim = new Vim(backtickEditor);
    runKeys(backtickVim, ["f", "h", "d", "a", "`"]);
    expect(backtickEditor.getText()).toBe("say now");
  });

  it("deletes to a mark with a jump motion", () => {
    const editor = new InMemoryVimEditor("one\ntwo\nthree");
    const vim = new Vim(editor);

    runKeys(vim, ["j", "m", "a", "k", "d", "'", "a"]);
    // The jump binding still wins over the quote object when an edit operator
    // is pending without an object selector. (Full linewise `d'` semantics are
    // a separate known gap; this locks in the current motion behavior.)
    expect(editor.getText()).toBe("two\nthree");
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

  it("applies operators to text objects through the pending stack", () => {
    const editor = new InMemoryVimEditor("one two three");
    const vim = new Vim(editor);

    runKeys(vim, ["w", "d", "i", "w"]);

    expect(editor.getText()).toBe("one  three");
    expect(vim.readRegister(undefined)).toBe("two");
  });

  it("applies convert and indent text objects through the pending stack", () => {
    const convertEditor = new InMemoryVimEditor("one two three");
    const convertVim = new Vim(convertEditor);

    runKeys(convertVim, ["w", "g", "U", "i", "w"]);
    expect(convertEditor.getText()).toBe("one TWO three");

    const indentEditor = new InMemoryVimEditor("one\n  two");
    const indentVim = new Vim(indentEditor);

    runKeys(indentVim, ["j", ">", "i", "w"]);
    expect(indentEditor.getText()).toBe("one\n      two");
  });

  it("applies surround operations through the pending stack", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    runKeys(vim, ["w", "y", "s", "i", "w", ")"]);
    expect(editor.getText()).toBe("one (two)");

    runKeys(vim, ["d", "s", ")"]);
    expect(editor.getText()).toBe("one two");
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

  it("distributes multicursor yanks across matching paste cursors", () => {
    const editor = new InMemoryVimEditor("one two\nred blue\nA\nB");
    const vim = new Vim(editor);

    editor.setSelections([
      charwiseSelection({ row: 0, column: 0 }),
      charwiseSelection({ row: 1, column: 0 }),
    ]);
    runKeys(vim, ["y", "w"]);

    expect(vim.readRegister(undefined)).toBe("one \nred ");

    editor.setSelections([
      charwiseSelection({ row: 2, column: 0 }),
      charwiseSelection({ row: 3, column: 0 }),
    ]);
    runKeys(vim, ["p"]);

    expect(editor.getText()).toBe("one two\nred blue\nAone \nBred ");
  });

  it("does not include multicursor yank separators in distributed paste parts", () => {
    const editor = new InMemoryVimEditor("abc001def\nabc001def");
    const vim = new Vim(editor);

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 3 }, head: { row: 0, column: 5 } },
      { type: "charwise", anchor: { row: 1, column: 3 }, head: { row: 1, column: 5 } },
    ]);
    vim.syncFromEditorState();
    runKeys(vim, ["y"]);

    editor.setSelections([
      charwiseSelection({ row: 0, column: 7 }),
      charwiseSelection({ row: 1, column: 7 }),
    ]);
    runKeys(vim, ["p"]);

    expect(editor.getText()).toBe("abc001de00f\nabc001de00f");
  });

  it("normalizes CRLF separators when distributing plain clipboard text", async () => {
    const editor = new InMemoryVimEditor("abc001def\nabc001def");
    const vim = new Vim(editor);
    const clipboard = new FakeAsyncClipboard("00\r\n00");

    editor.setSelections([
      charwiseSelection({ row: 0, column: 7 }),
      charwiseSelection({ row: 1, column: 7 }),
    ]);
    await runKeysAsync(vim, ["\"", "+", "p"], clipboard);

    expect(editor.getText()).toBe("abc001de00f\nabc001de00f");
  });

  it("distributes plain newline clipboard text across matching paste cursors", async () => {
    const editor = new InMemoryVimEditor("A\nB");
    const vim = new Vim(editor);
    const clipboard = new FakeAsyncClipboard("one\nred");

    editor.setSelections([
      charwiseSelection({ row: 0, column: 0 }),
      charwiseSelection({ row: 1, column: 0 }),
    ]);
    await runKeysAsync(vim, ["\"", "+", "p"], clipboard);

    expect(editor.getText()).toBe("Aone\nBred");
  });

  it("distributes multicursor visual yanks across matching visual paste selections", () => {
    const editor = new InMemoryVimEditor("one two\nred blue\nA\nB");
    const vim = new Vim(editor);

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 3 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 3 } },
    ]);
    vim.syncFromEditorState();
    runKeys(vim, ["y"]);

    expect(vim.readRegister(undefined)).toBe("one\nred");

    editor.setSelections([
      { type: "charwise", anchor: { row: 2, column: 0 }, head: { row: 2, column: 1 } },
      { type: "charwise", anchor: { row: 3, column: 0 }, head: { row: 3, column: 1 } },
    ]);
    vim.syncFromEditorState();
    runKeys(vim, ["p"]);

    expect(editor.getText()).toBe("one two\nred blue\none\nred");
  });

  it("distributes plain newline clipboard text across matching visual paste selections", async () => {
    const editor = new InMemoryVimEditor("A\nB");
    const vim = new Vim(editor);
    const clipboard = new FakeAsyncClipboard("one\nred");

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 1 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 1 } },
    ]);
    vim.syncFromEditorState();
    await runKeysAsync(vim, ["\"", "+", "p"], clipboard);

    expect(editor.getText()).toBe("one\nred");
  });

  it("distributes linewise-classified plain clipboard text across matching visual paste selections", async () => {
    const editor = new InMemoryVimEditor("seed\nA\nB");
    const vim = new Vim(editor, { useSystemClipboard: true });
    const clipboard = new FakeAsyncClipboard("");

    await runKeysAsync(vim, ["y", "y"], clipboard);
    clipboard.text = "one\nred";

    editor.setSelections([
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 1 } },
      { type: "charwise", anchor: { row: 2, column: 0 }, head: { row: 2, column: 1 } },
    ]);
    vim.syncFromEditorState();
    await runKeysAsync(vim, ["p"], clipboard);

    expect(editor.getText()).toBe("seed\none\nred");
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

  it("seeds the last search on empty input without moving the viewport", () => {
    const editor = new SearchTrackingEditor("one two\nthree\ntwo");
    const vim = new Vim(editor);

    runKeys(vim, ["/", "t", "w", "o", "enter"]);
    expect(head(editor)).toEqual({ row: 0, column: 4 });
    editor.revealedRanges = [];
    editor.searchUpdates = [];

    // `/` with nothing typed: the last query's matches are highlighted, but
    // the viewport and cursor stay put.
    runKeys(vim, ["/"]);
    expect(editor.revealedRanges).toEqual([]);
    expect(head(editor)).toEqual({ row: 0, column: 4 });
    expect(editor.searchUpdates).toEqual([{ query: "two", reveal: false }]);

    // Typing resumes incremental reveal; deleting back to empty stops it again.
    runKeys(vim, ["t"]);
    expect(editor.revealedRanges.length).toBe(1);
    runKeys(vim, ["backspace"]);
    expect(editor.revealedRanges.length).toBe(1);
    expect(editor.searchUpdates[editor.searchUpdates.length - 1]).toEqual({ query: "two", reveal: false });

    runKeys(vim, ["<escape>"]);
    expect(head(editor)).toEqual({ row: 0, column: 4 });
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

    expect(vim.wouldHandleKeyForTest("ctrl-a")).toBe(false);
    expect(vim.onKey("ctrl-a")).toBe("native");
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

  it("shows unfinished chords through the async key plan used by VSCode", async () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor);

    await vim.handleKey("d")?.run();
    expect(vim.status.chord).toBe("d");
    expect(vim.status.text).toBe("NORMAL d");

    await vim.handleKey("i")?.run();
    expect(vim.status.chord).toBe("di");
    expect(vim.status.text).toBe("NORMAL di");
  });

  it("shows register-prefixed chords without leaking chords of previous commands", () => {
    const editor = new InMemoryVimEditor("one two three four");
    const vim = new Vim(editor);

    runKeys(vim, ["\"", "a", "d", "w"]);
    expect(editor.getText()).toBe("two three four");
    expect(vim.status.chord).toBe("");

    runKeys(vim, ["\"", "a"]);
    expect(vim.status.chord).toBe("\"a");

    runKeys(vim, ["d"]);
    expect(vim.status.chord).toBe("\"ad");

    runKeys(vim, ["w"]);
    expect(editor.getText()).toBe("three four");
    expect(vim.status.chord).toBe("");
  });

  it("shows pending chords in the order they were typed", () => {
    const editor = new InMemoryVimEditor("one two three four");
    const vim = new Vim(editor);

    runKeys(vim, ["2", "\"", "a", "d"]);
    expect(vim.status.chord).toBe("2\"ad");

    runKeys(vim, ["escape", "d", "f"]);
    expect(vim.status.chord).toBe("df");

    runKeys(vim, ["t"]);
    expect(editor.getText()).toBe("wo three four");
    expect(vim.status.chord).toBe("");
  });

  it("shows remapped pending chords as typed rather than as their expansion", () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: [{ before: ["x"], after: ["d"] }],
    });

    runKeys(vim, ["x"]);
    expect(vim.status.chord).toBe("x");

    runKeys(vim, ["w"]);
    expect(editor.getText()).toBe("two");
    expect(vim.status.chord).toBe("");
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

  it("keeps visual w cursor on the next word start", () => {
    const editor = new InMemoryVimEditor("one two three");
    const vim = new Vim(editor);

    runKeys(vim, ["v", "w"]);

    expect(editor.getSelections()).toEqual([
      {
        type: "charwise",
        anchor: { row: 0, column: 0 },
        head: { row: 0, column: 5 },
        cursor: { row: 0, column: 4 },
        goal: { type: "modelColumn", column: 4 },
      },
    ]);

    runKeys(vim, ["w"]);

    expect(editor.getSelections()).toEqual([
      {
        type: "charwise",
        anchor: { row: 0, column: 0 },
        head: { row: 0, column: 9 },
        cursor: { row: 0, column: 8 },
        goal: { type: "modelColumn", column: 8 },
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

  // Verified against Neovim: with the whole 9-line document visible, `M` is
  // row 4, `dM` from row 6 deletes rows 4..6, and the same-row case deletes
  // one line.
  it("deletes linewise to the window line with dH/dM/dL", () => {
    const text = Array.from({ length: 9 }, (_, i) => `line${i}`).join("\n");
    const run = (keys: readonly string[]) => {
      const editor = new InMemoryVimEditor(text);
      const vim = new Vim(editor);
      runKeys(vim, keys);
      return editor;
    };

    const afterMiddleDelete = run(["6", "j", "d", "M"]);
    expect(afterMiddleDelete.getText()).toBe("line0\nline1\nline2\nline3\nline7\nline8");
    expect(head(afterMiddleDelete)).toEqual({ row: 4, column: 0 });

    expect(run(["4", "j", "d", "M"]).getText())
      .toBe("line0\nline1\nline2\nline3\nline5\nline6\nline7\nline8");
    expect(run(["6", "j", "d", "H"]).getText()).toBe("line7\nline8");
    expect(run(["j", "d", "L"]).getText()).toBe("line0");
    expect(run(["j", "2", "d", "H"]).getText())
      .toBe("line0\nline2\nline3\nline4\nline5\nline6\nline7\nline8");
  });

  it("extends visual-line mode with ctrl-d", () => {
    const editor = new InMemoryVimEditor("one\ntwo\nthree\nfour\nfive\nsix");
    const vim = new Vim(editor);

    runKeys(vim, ["V", "ctrl-d"]);

    expect(vim.modeName).toBe("vim:visualLine");
    expect(editor.getSelections()).toEqual([
      { type: "linewise", anchorLine: 0, anchorColumn: 0, headLine: 3, cursor: { row: 3, column: 0 }, goal: { type: "modelColumn", column: 0 } },
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
      anchorColumn: 1,
      headLine: 1,
      cursor: { row: 1, column: 0 },
      goal: { type: "modelColumn", column: 1 },
    });

    runKeys(vim, ["j"]);

    expect(editor.getSelections()[0]).toEqual({
      type: "linewise",
      anchorLine: 0,
      anchorColumn: 1,
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

  it("can use VSCodeVim-style visual insert for multicursor charwise selections", () => {
    const editor = new InMemoryVimEditor("one two\nthree four");
    const vim = new Vim(editor, { visualMultilineInsert: true });

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 3 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 5 } },
    ]);
    vim.syncFromEditorState({ canonicalizeVisualSelection: true });

    runKeys(vim, ["I", "x", "<escape>"]);

    expect(editor.getText()).toBe("xone two\nxthree four");
  });

  it("can use VSCodeVim-style visual append for multicursor charwise selections", () => {
    const editor = new InMemoryVimEditor("one two\nthree four");
    const vim = new Vim(editor, { visualMultilineInsert: true });

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 3 } },
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 5 } },
    ]);
    vim.syncFromEditorState({ canonicalizeVisualSelection: true });

    runKeys(vim, ["A", "x", "<escape>"]);

    expect(editor.getText()).toBe("onex two\nthreex four");
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
    vim.syncFromEditorState();

    expect(vim.modeName).toBe("vim:visual");
    expect(editor.getSelections()).toEqual([externalSelection]);
  });

  it("does not rewrite a backward external selection when adopting it", () => {
    // Like Neovim, anchor and active are not swapped unless the selection is
    // actually extended; adoption must not disturb native drag anchors.
    const editor = new InMemoryVimEditor("abcdef");
    const vim = new Vim(editor);
    const backwardSelection = { type: "charwise" as const, anchor: { row: 0, column: 4 }, head: { row: 0, column: 1 } };

    editor.setSelections([backwardSelection]);
    vim.syncFromEditorState();

    expect(vim.modeName).toBe("vim:visual");
    expect(editor.getSelections()).toEqual([backwardSelection]);
  });

  it("does not rewrite a full-line external selection ending at the next line start", () => {
    // A triple-click line selection ends at column 0 of the next line. That
    // boundary encoding raises to the same Vim geometry as ending at the end of
    // the line, so adoption must keep the native shape (and the native line-drag
    // anchor) untouched.
    const editor = new InMemoryVimEditor("abc\nxy");
    const vim = new Vim(editor);
    const lineSelection = { type: "charwise" as const, anchor: { row: 0, column: 0 }, head: { row: 1, column: 0 } };

    editor.setSelections([lineSelection]);
    vim.syncFromEditorState();

    expect(vim.modeName).toBe("vim:visual");
    expect(editor.getSelections()).toEqual([lineSelection]);
  });

  it("rewrites external selections whose canonicalization changes the Vim meaning", () => {
    // A backward selection anchored just past an empty line cannot be
    // represented exactly; adoption normalizes it to the canonical equivalent.
    const editor = new InMemoryVimEditor("abc\n\nxy");
    const vim = new Vim(editor);

    editor.setSelections([{ type: "charwise", anchor: { row: 2, column: 0 }, head: { row: 0, column: 0 } }]);
    vim.syncFromEditorState();

    expect(vim.modeName).toBe("vim:visual");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 0, column: 0 }, cursor: { row: 0, column: 0 }, goal: undefined },
    ]);
  });

  it("places the normal cursor at the clicked cell after a drag-shrunk visual selection", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor);

    // Mouse drag from 'b' over 'c'...
    editor.setSelections([{ type: "charwise", anchor: { row: 0, column: 1 }, head: { row: 0, column: 3 } }]);
    vim.syncFromEditorState();
    expect(vim.modeName).toBe("vim:visual");

    // ...then back so only 'b' stays selected. Adoption keeps the canonical
    // native shape untouched.
    editor.setSelections([{ type: "charwise", anchor: { row: 0, column: 1 }, head: { row: 0, column: 2 } }]);
    vim.syncFromEditorState();
    expect(vim.modeName).toBe("vim:visual");
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 1 }, head: { row: 0, column: 2 } },
    ]);

    // A click on 'a' (cell-floored mouse position) collapses to a normal cursor
    // exactly on the clicked cell, with no stale visual state surviving.
    editor.setSelections([charwiseSelection({ row: 0, column: 0 })]);
    vim.syncFromEditorState();
    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getSelections()).toEqual([charwiseSelection({ row: 0, column: 0 })]);
  });

  it("collapses a single one-character external selection onto the selected character", () => {
    const editor = new InMemoryVimEditor("abcdef");
    const vim = new Vim(editor);

    editor.setSelections([{ type: "charwise", anchor: { row: 0, column: 1 }, head: { row: 0, column: 2 } }]);
    vim.syncFromEditorState();

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getSelections()).toEqual([charwiseSelection({ row: 0, column: 1 })]);
  });

  it("can adopt a one-character external selection as visual for mouse word selection", () => {
    const editor = new InMemoryVimEditor("a b");
    const vim = new Vim(editor);
    const mouseSelection = { type: "charwise" as const, anchor: { row: 0, column: 0 }, head: { row: 0, column: 1 } };

    editor.setSelections([mouseSelection]);
    vim.syncFromEditorState({ oneCharacterSelection: "visual" });

    expect(vim.modeName).toBe("vim:visual");
    expect(editor.getSelections()).toEqual([mouseSelection]);
  });

  it("collapses a backward one-character external selection onto the selected character", () => {
    const editor = new InMemoryVimEditor("abcdef");
    const vim = new Vim(editor);

    editor.setSelections([{ type: "charwise", anchor: { row: 0, column: 2 }, head: { row: 0, column: 1 } }]);
    vim.syncFromEditorState();

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getSelections()).toEqual([charwiseSelection({ row: 0, column: 1 })]);
  });

  it("keeps one-character selections visual when already in visual mode", () => {
    const editor = new InMemoryVimEditor("abcdef");
    const vim = new Vim(editor);

    runKeys(vim, ["v"]);
    editor.setSelections([{ type: "charwise", anchor: { row: 0, column: 1 }, head: { row: 0, column: 2 } }]);
    vim.syncFromEditorState();

    expect(vim.modeName).toBe("vim:visual");
  });

  it("keeps multicursor one-character external selections visual", () => {
    const editor = new InMemoryVimEditor("abc\ndef");
    const vim = new Vim(editor);

    editor.setSelections([
      { type: "charwise", anchor: { row: 0, column: 1 }, head: { row: 0, column: 2 } },
      { type: "charwise", anchor: { row: 1, column: 1 }, head: { row: 1, column: 2 } },
    ]);
    vim.syncFromEditorState();

    expect(vim.modeName).toBe("vim:visual");
  });

  it("clears pending operators when external sync adopts visual mode", () => {
    const editor = new InMemoryVimEditor("abcdef");
    const vim = new Vim(editor);

    runKeys(vim, ["d"]);
    expect(vim.modeName).toBe("vim:normal+");

    editor.setSelections([{ type: "charwise", anchor: { row: 0, column: 1 }, head: { row: 0, column: 4 } }]);
    vim.syncFromEditorState();

    expect(vim.modeName).toBe("vim:visual");
    runKeys(vim, ["w"]);
    expect(editor.getText()).toBe("abcdef");
  });

  it("uses exact external backward selection ranges for visual operations", () => {
    const editor = new InMemoryVimEditor("abcdef");
    const vim = new Vim(editor);

    editor.setSelections([{ type: "charwise", anchor: { row: 0, column: 4 }, head: { row: 0, column: 1 } }]);
    vim.syncFromEditorState();
    runKeys(vim, ["S", "b"]);

    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getText()).toBe("a(bcd)ef");
  });

  it("keeps an externally-adopted visual selection shape and applies Vim motions from it", () => {
    const editor = new InMemoryVimEditor("abcdef");
    const vim = new Vim(editor);

    editor.setSelections([{ type: "charwise", anchor: { row: 0, column: 1 }, head: { row: 0, column: 4 } }]);
    vim.syncFromEditorState();

    expect(vim.modeName).toBe("vim:visual");
    // Adoption leaves the canonical-equivalent native shape untouched; the
    // adopted Vim state still drives subsequent motions from the cursor cell.
    expect(editor.getSelections()).toEqual([
      { type: "charwise", anchor: { row: 0, column: 1 }, head: { row: 0, column: 4 } },
    ]);

    runKeys(vim, ["l"]);
    expect(editor.getSelections()).toEqual([
      {
        type: "charwise",
        anchor: { row: 0, column: 1 },
        head: { row: 0, column: 5 },
        cursor: { row: 0, column: 4 },
        goal: undefined,
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
