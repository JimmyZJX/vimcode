import { RemapTimeoutKey } from "./config.js";
import { InMemoryVimEditor } from "./editor.js";
import { Registers } from "./registers.js";
import type { VimSystemClipboard } from "./registers.js";
import { charwiseSelection, selectionHead } from "./state.js";
import { Vim, VimGlobalState, runKeys } from "./vim.js";

class RejectingClipboard implements VimSystemClipboard {
  readText(): Promise<string> {
    return Promise.reject(new Error("clipboard unavailable"));
  }

  writeText(_text: string): void {}
}

class DeferredClipboard implements VimSystemClipboard {
  private resolveRead: ((text: string) => void) | undefined;
  readonly read = new Promise<string>(resolve => {
    this.resolveRead = resolve;
  });

  readText(): Promise<string> {
    return this.read;
  }

  writeText(_text: string): void {}

  resolve(text: string): void {
    this.resolveRead?.(text);
  }
}

class MutableClipboard implements VimSystemClipboard {
  reads = 0;
  writes: string[] = [];

  constructor(public text: string) {}

  async readText(): Promise<string> {
    this.reads++;
    return this.text;
  }

  writeText(text: string): void {
    this.text = text;
    this.writes.push(text);
  }
}

async function press(vim: Vim, keys: readonly string[], clipboard: VimSystemClipboard): Promise<void> {
  for (const key of keys) await vim.handleKey(key)?.run({ clipboard });
}

async function pressThroughHost(
  vim: Vim,
  editor: InMemoryVimEditor,
  keys: readonly string[],
  clipboard: VimSystemClipboard
): Promise<void> {
  for (const key of keys) {
    const plan = vim.handleKey(key);
    if (plan?.passthrough) editor.replayInsertKey(key);
    await plan?.run({ clipboard });
  }
}

function head(editor: InMemoryVimEditor) {
  return selectionHead(editor.getSelections()[0]);
}

describe("execution-time clipboard register reads", () => {
  it("isolates concurrent editor clipboard transactions sharing global registers", async () => {
    const globalState = new VimGlobalState();
    const editorA = new InMemoryVimEditor("x");
    const editorB = new InMemoryVimEditor("x");
    const vimA = new Vim(editorA, { useSystemClipboard: true }, globalState);
    const vimB = new Vim(editorB, { useSystemClipboard: true }, globalState);
    const clipboardA = new DeferredClipboard();
    const clipboardB = new DeferredClipboard();

    const planA = vimA.handleKey("p");
    const planB = vimB.handleKey("p");
    const runA = planA?.run({ clipboard: clipboardA });
    const runB = planB?.run({ clipboard: clipboardB });
    clipboardA.resolve("A");
    clipboardB.resolve("B");
    await Promise.all([runA, runB]);

    expect(editorA.getText()).toBe("xA");
    expect(editorB.getText()).toBe("xB");
  });

  it("restores an outer transaction snapshot after a nested clipboard context", async () => {
    const registers = new Registers().scoped();
    registers.setUseSystemClipboard(true);
    const outer = new MutableClipboard("A");
    const inner = new MutableClipboard("B");

    await registers.withSystemClipboard(outer, async () => {
      await registers.refreshSystemClipboardRegister(undefined);
      expect(registers.read(undefined)).toBe("A");
      await registers.withSystemClipboard(inner, async () => {
        await registers.refreshSystemClipboardRegister(undefined);
        expect(registers.read(undefined)).toBe("B");
      });
      expect(registers.read(undefined)).toBe("A");
    });
  });

  it("completes hosted macro replay when no clipboard read is needed", async () => {
    const editor = new InMemoryVimEditor("abcde");
    const vim = new Vim(editor);
    runKeys(vim, ["q", "a", "x", "x", "q"]);
    const clipboard = new MutableClipboard("unused");

    await press(vim, ["@", "a"], clipboard);

    expect(editor.getText()).toBe("e");
  });

  it("refreshes paste during macro replay", async () => {
    const editor = new InMemoryVimEditor("x");
    const vim = new Vim(editor, { useSystemClipboard: true });
    runKeys(vim, ["q", "a", "p", "p", "q"]);
    const clipboard = new MutableClipboard("B");

    await press(vim, ["@", "a"], clipboard);

    expect(editor.getText()).toBe("xBB");
    expect(clipboard.reads).toBe(1);
  });

  it("refreshes paste during dot replay", async () => {
    const editor = new InMemoryVimEditor("x");
    const vim = new Vim(editor, { useSystemClipboard: true });
    const clipboard = new MutableClipboard("A");

    await press(vim, ["p"], clipboard);
    clipboard.text = "B";
    await press(vim, ["."], clipboard);

    expect(editor.getText()).toBe("xAB");
    expect(clipboard.reads).toBe(2);
  });

  it("serializes remap-emitted keys around an asynchronous paste", async () => {
    const editor = new InMemoryVimEditor("a\nb");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [{ before: ["z"], after: ["p", "j"] }],
    });
    const clipboard = new MutableClipboard("X");

    await press(vim, ["z"], clipboard);

    expect(editor.getText()).toBe("aX\nb");
    expect(head(editor)).toEqual({ row: 1, column: 0 });
    expect(clipboard.reads).toBe(1);
  });

  it("records async remap edits in the change list", async () => {
    const editor = new InMemoryVimEditor("a\nb");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [{ before: ["z"], after: ["p", "j"] }],
    });
    const clipboard = new MutableClipboard("X");

    await press(vim, ["z", "g", ";"], clipboard);

    expect(head(editor)).toEqual({ row: 0, column: 1 });
  });

  it("finishes dot replay requested by an async remap before the root key completes", async () => {
    const editor = new InMemoryVimEditor("a");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [{ before: ["z"], after: ["p", "."] }],
    });
    const clipboard = new MutableClipboard("X");

    await press(vim, ["z"], clipboard);

    expect(editor.getText()).toBe("aXX");
  });

  it("preserves the originating when context across async remap expansion", async () => {
    const editor = new InMemoryVimEditor("ab");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [
        { before: ["q"], after: ["p", "x"] },
        { before: ["x"], after: ["l"], when: "inactive-here" },
      ],
    });
    const clipboard = new MutableClipboard("X");
    const plan = vim.handleKey("q", {
      whenEvaluator: when => when === undefined || when !== "inactive-here",
    });

    await plan?.run({ clipboard });

    expect(editor.getText()).toBe("ab");
  });

  it("finishes async remaps before returning from insert ctrl-o", async () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [{ before: ["z"], after: ["p"] }],
    });
    const clipboard = new MutableClipboard("X");

    await press(vim, ["i", "ctrl-o", "z"], clipboard);
    await pressThroughHost(vim, editor, ["Q"], clipboard);

    expect(editor.getText()).toBe("aXQbc");
    expect(vim.modeName).toBe("vim:insert");
  });

  it("finishes command-only async remaps before returning from insert ctrl-o", async () => {
    const editor = new InMemoryVimEditor("a");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [{ before: ["z"], commands: [{ command: ":put" }] }],
    });
    const clipboard = new MutableClipboard("X");

    await press(vim, ["i", "ctrl-o", "z"], clipboard);

    expect(editor.getText()).toBe("a\nX");
    expect(vim.modeName).toBe("vim:insert");
  });

  it("serializes mode-changing macro replay after an async remap leaf", async () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [{ before: ["z"], after: ["p", "@", "a"] }],
    });
    runKeys(vim, ["q", "a", "i", "Z", "<escape>", "q"]);
    editor.resetForTest("abc", [charwiseSelection({ row: 0, column: 0 })]);
    const clipboard = new MutableClipboard("X");

    await press(vim, ["z"], clipboard);

    expect(editor.getText()).toBe("aZXbc");
    expect(vim.modeName).toBe("vim:normal");
  });

  it("finishes macro replay requested after an async remap leaf", async () => {
    const editor = new InMemoryVimEditor("abcd");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [{ before: ["z"], after: ["p", "@", "a"] }],
    });
    runKeys(vim, ["q", "a", "x", "q"]);
    const clipboard = new MutableClipboard("P");

    await press(vim, ["z"], clipboard);

    expect(editor.getText()).toBe("bcd");
    expect(vim.modeName).toBe("vim:normal");
  });

  it("orders conflict suffixes after accepted async remaps and groups undo", async () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [
        { before: ["a"], after: ["p", "l"] },
        { before: ["a", "b", "c"], after: ["h"] },
      ],
    });
    const clipboard = new MutableClipboard("X");

    await press(vim, ["a", "x"], clipboard);
    expect(editor.getText()).toBe("aXc");
    await press(vim, ["u"], clipboard);
    expect(editor.getText()).toBe("abc");

    const timeoutEditor = new InMemoryVimEditor("abc");
    const timeoutVim = new Vim(timeoutEditor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [
        { before: ["a"], after: ["x", "x"] },
        { before: ["a", "b"], after: ["h"] },
      ],
    });
    await press(timeoutVim, ["a", RemapTimeoutKey], clipboard);
    expect(timeoutEditor.getText()).toBe("c");
    await press(timeoutVim, ["u"], clipboard);
    expect(timeoutEditor.getText()).toBe("abc");
  });

  it("replays timeout-buffered suffixes after the complete async accepted mapping", async () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [
        { before: ["a"], after: ["p", "l"] },
        { before: ["a", "x", "y"], after: ["h"] },
      ],
    });
    const clipboard = new MutableClipboard("X");

    await press(vim, ["a", "x", RemapTimeoutKey], clipboard);

    expect(editor.getText()).toBe("aXc");
  });

  it("preserves the originating when context when a remap timeout is accepted", async () => {
    const editor = new InMemoryVimEditor("ab");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [
        { before: ["a"], after: ["p", "x"] },
        { before: ["a", "b"], after: ["h"] },
        { before: ["x"], after: ["l"], when: "inactive-here" },
      ],
    });
    const clipboard = new MutableClipboard("X");
    const first = vim.handleKey("a", {
      whenEvaluator: when => when === undefined || when !== "inactive-here",
    });
    await first?.run({ clipboard });
    await press(vim, [RemapTimeoutKey], clipboard);

    expect(editor.getText()).toBe("ab");
  });

  it("runs replay requests before later remap suffix keys", async () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [{ before: ["z"], after: ["@", "a", "p"] }],
    });
    runKeys(vim, ["q", "a", "x", "q"]);
    editor.resetForTest("abc", [charwiseSelection({ row: 0, column: 0 })]);
    const clipboard = new MutableClipboard("X");

    await press(vim, ["z"], clipboard);

    expect(editor.getText()).toBe("bac");
  });

  it("runs visual remaps after refreshing their register dependency", async () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      visualModeKeyBindingsNonRecursive: [{ before: ["q"], after: ["p"] }],
    });
    const clipboard = new MutableClipboard("X");

    await press(vim, ["v", "i", "w", "q"], clipboard);

    expect(editor.getText()).toBe("X two");
    expect(vim.modeName).toBe("vim:normal");
  });

  it("groups remap expansions into one undo unit", async () => {
    const editor = new InMemoryVimEditor("abcde");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: [{ before: ["z"], after: ["x", "x"] }],
    });
    const clipboard = new MutableClipboard("unused");

    await press(vim, ["z"], clipboard);
    expect(editor.getText()).toBe("cde");
    await press(vim, ["u"], clipboard);
    expect(editor.getText()).toBe("abcde");
  });

  it("keeps remap change operators and their insert session in one undo unit", async () => {
    const editor = new InMemoryVimEditor("one two");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: [{ before: ["z"], after: ["c", "w"] }],
    });
    const clipboard = new MutableClipboard("unused");

    await pressThroughHost(vim, editor, ["z", "X", "<escape>"], clipboard);
    expect(editor.getText()).toBe("X two");
    await press(vim, ["u"], clipboard);
    expect(editor.getText()).toBe("one two");
  });

  it("runs external vim.remap commands inside a clipboard transaction", async () => {
    const editor = new InMemoryVimEditor("a");
    const vim = new Vim(editor, { useSystemClipboard: true });
    const clipboard = new MutableClipboard("X");

    await vim.executeExternalRemap({ after: ["p"] }, clipboard);

    expect(editor.getText()).toBe("aX");
    expect(clipboard.reads).toBe(1);

    const undoEditor = new InMemoryVimEditor("abcde");
    const undoVim = new Vim(undoEditor);
    await undoVim.executeExternalRemap({ after: ["x", "x"] }, clipboard);
    expect(undoEditor.getText()).toBe("cde");
    await press(undoVim, ["u"], clipboard);
    expect(undoEditor.getText()).toBe("abcde");

    const changeEditor = new InMemoryVimEditor("one two");
    const changeVim = new Vim(changeEditor);
    await changeVim.executeExternalRemap({ after: ["c", "w"] }, clipboard);
    await pressThroughHost(changeVim, changeEditor, ["X", "<escape>"], clipboard);
    await press(changeVim, ["u"], clipboard);
    expect(changeEditor.getText()).toBe("one two");
  });

  it("propagates clipboard failures, resets pending state, and drops remap suffixes", async () => {
    const directEditor = new InMemoryVimEditor("a");
    const directVim = new Vim(directEditor, { useSystemClipboard: true });
    await expect(directVim.handleKey("p")?.run({ clipboard: new RejectingClipboard() }))
      .rejects.toThrow("clipboard unavailable");
    expect(directEditor.getText()).toBe("a");
    expect(directVim.status.pending).toBe(false);

    const remapEditor = new InMemoryVimEditor("a\nb");
    const remapVim = new Vim(remapEditor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [{ before: ["z"], after: ["p", "j"] }],
    });
    await expect(remapVim.handleKey("z")?.run({ clipboard: new RejectingClipboard() }))
      .rejects.toThrow("clipboard unavailable");
    expect(remapEditor.getText()).toBe("a\nb");
    expect(head(remapEditor)).toEqual({ row: 0, column: 0 });

    const temporaryEditor = new InMemoryVimEditor("a");
    const temporaryVim = new Vim(temporaryEditor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [{ before: ["z"], after: ["p"] }],
    });
    await press(temporaryVim, ["i", "ctrl-o"], new MutableClipboard("unused"));
    await expect(temporaryVim.handleKey("z")?.run({ clipboard: new RejectingClipboard() }))
      .rejects.toThrow("clipboard unavailable");
    expect(temporaryVim.modeName).toBe("vim:insert");

    const externalEditor = new InMemoryVimEditor("a");
    const externalVim = new Vim(externalEditor, { useSystemClipboard: true });
    await expect(externalVim.executeExternalRemap({
      after: ["d"],
      commands: [{ command: ":put" }],
    }, new RejectingClipboard())).rejects.toThrow("clipboard unavailable");
    expect(externalVim.status.pending).toBe(false);
  });

  it("refreshes insert ctrl-r while explicit unnamed remains local", async () => {
    const insertEditor = new InMemoryVimEditor("");
    const insertVim = new Vim(insertEditor, { useSystemClipboard: true });
    const clipboard = new MutableClipboard("inserted");

    await press(insertVim, ["i", "ctrl-r", "+", "<escape>"], clipboard);
    expect(insertEditor.getText()).toBe("inserted");

    const pasteEditor = new InMemoryVimEditor("x local");
    const pasteVim = new Vim(pasteEditor, { useSystemClipboard: true });
    clipboard.text = "P";
    const readsBefore = clipboard.reads;
    await press(pasteVim, ["\"", "\"", "y", "i", "w", "w", "\"", "\"", "p"], clipboard);
    expect(pasteEditor.getText()).toBe("x lxocal");
    expect(clipboard.reads).toBe(readsBefore);
  });

  it("reparses Enter after delayed operator-search clipboard input", async () => {
    const editor = new InMemoryVimEditor("x foo y");
    const vim = new Vim(editor);
    const clipboard = new DeferredClipboard();

    await vim.handleKey("d")?.run({ clipboard });
    await vim.handleKey("/")?.run({ clipboard });
    const pastePlan = vim.handleKey("ctrl-v");
    const pasteRun = pastePlan?.run({ clipboard });
    const enterPlan = vim.handleKey("enter");
    clipboard.resolve("foo");
    await pasteRun;
    await enterPlan?.run({ clipboard });

    expect(editor.getText()).toBe("foo y");
  });

  it("refreshes search input, operator search, and :put", async () => {
    const searchEditor = new InMemoryVimEditor("x foo");
    const searchVim = new Vim(searchEditor);
    const clipboard = new MutableClipboard("foo");
    await press(searchVim, ["/", "ctrl-v", "enter"], clipboard);
    expect(head(searchEditor)).toEqual({ row: 0, column: 2 });

    const operatorEditor = new InMemoryVimEditor("x foo y");
    const operatorVim = new Vim(operatorEditor);
    await press(operatorVim, ["d", "/", "ctrl-v", "enter"], clipboard);
    expect(operatorEditor.getText()).toBe("foo y");

    const putEditor = new InMemoryVimEditor("a");
    const putVim = new Vim(putEditor, { useSystemClipboard: true });
    clipboard.text = "b";
    await press(putVim, [":", "p", "u", "t", "enter"], clipboard);
    expect(putEditor.getText()).toBe("a\nb");

    const normalEditor = new InMemoryVimEditor("a");
    const normalVim = new Vim(normalEditor, { useSystemClipboard: true });
    clipboard.text = "c";
    await press(normalVim, [":", "n", "o", "r", "m", "space", "p", "enter"], clipboard);
    expect(normalEditor.getText()).toBe("ac");
  });

  it("serializes mapped ranged :normal keys against each target row", async () => {
    const editor = new InMemoryVimEditor("abc\ndef");
    const vim = new Vim(editor, {
      normalModeKeyBindingsNonRecursive: [{
        before: ["z"],
        commands: [{ command: ":1,2normal x" }],
      }],
    });
    const clipboard = new MutableClipboard("unused");

    await press(vim, ["z"], clipboard);

    expect(editor.getText()).toBe("bc\nef");
  });

  it("refreshes clipboard registers for mapped Ex command objects", async () => {
    const editor = new InMemoryVimEditor("a");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      normalModeKeyBindingsNonRecursive: [{
        before: ["z"],
        commands: [{ command: ":put" }],
      }],
    });
    const clipboard = new MutableClipboard("b");

    await press(vim, ["z"], clipboard);

    expect(editor.getText()).toBe("a\nb");
    expect(clipboard.reads).toBe(1);
  });

  it("refreshes visual ReplaceWithRegister dot replay", async () => {
    const editor = new InMemoryVimEditor("one two abc");
    const vim = new Vim(editor, { replaceWithRegister: true, useSystemClipboard: true });
    const clipboard = new MutableClipboard("X");

    await press(vim, ["v", "i", "w", "g", "r"], clipboard);
    clipboard.text = "Y";
    await press(vim, ["w", "."], clipboard);

    expect(editor.getText()).toBe("X Y abc");
  });

  it("writes implicit unnamed yanks to the system clipboard but keeps explicit unnamed local", async () => {
    const editor = new InMemoryVimEditor("word");
    editor.setSelections([charwiseSelection({ row: 0, column: 0 })]);
    const vim = new Vim(editor, { useSystemClipboard: true });
    const clipboard = new MutableClipboard("");

    await press(vim, ["y", "i", "w"], clipboard);
    expect(clipboard.writes).toEqual(["word"]);

    const explicitEditor = new InMemoryVimEditor("local");
    const explicitVim = new Vim(explicitEditor, { useSystemClipboard: true });
    clipboard.writes = [];
    await press(explicitVim, ["\"", "\"", "y", "i", "w"], clipboard);
    expect(clipboard.writes).toEqual([]);
  });
});
