// Undo granularity around insert text (deliberate design, see
// [Vim.compositeUndoTransaction] and [Vim.replayAsOneUndoUnit]):
// - Live insert sessions hold NO session-wide Vim undo transaction — typed
//   text keeps the host's native undo granularity (VSCode's word-boundary
//   stops), diverging from Vim's one-unit-per-insert-session.
// - Dot/macro replays ARE one undo unit: replayed typing runs through native
//   commands, and without an open transaction the host's word-boundary stops
//   would split a `.` repeat into several undo steps.
import { InMemoryVimEditor } from "./editor.js";
import type { VimSystemClipboard } from "./registers.js";
import { Vim, runKeys } from "./vim.js";

const clipboard: VimSystemClipboard = {
  readText: async () => "",
  writeText: () => {},
};

// The hosted key path: plans via [handleKey] with passthrough characters
// applied by the host (see clipboard_execution.test.ts).
async function pressThroughHost(vim: Vim, editor: InMemoryVimEditor, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    const plan = vim.handleKey(key);
    if (plan?.passthrough) editor.replayInsertKey(key);
    await plan?.run({ clipboard });
  }
}

describe("insert undo granularity", () => {
  it("a live insert session holds no vim undo transaction", async () => {
    const editor = new InMemoryVimEditor("start");
    const vim = new Vim(editor);
    await pressThroughHost(vim, editor, ["o"]);
    expect(editor.undoTransactionDepthForTest()).toBe(0);
    await pressThroughHost(vim, editor, ["a", "b", " ", "c", "d"]);
    expect(editor.undoTransactionDepthForTest()).toBe(0);
    await pressThroughHost(vim, editor, ["<escape>"]);
    expect(editor.undoTransactionDepthForTest()).toBe(0);
    expect(editor.getText()).toBe("start\nab cd");
  });

  it("dot-repeating an insert change is one undo unit and stays balanced", () => {
    const editor = new InMemoryVimEditor("start");
    const vim = new Vim(editor);
    runKeys(vim, ["o", "a", "b", " ", "c", "d", "<escape>"]);
    runKeys(vim, ["."]);
    expect(editor.undoTransactionDepthForTest()).toBe(0);
    expect(editor.getText()).toBe("start\nab cd\nab cd");
    runKeys(vim, ["u"]);
    expect(editor.getText()).toBe("start\nab cd");
    runKeys(vim, ["u"]);
    expect(editor.getText()).toBe("start");
  });

  it("a macro replay of an insert change stays balanced too", () => {
    const editor = new InMemoryVimEditor("start");
    const vim = new Vim(editor);
    runKeys(vim, ["q", "q", "o", "x", " ", "y", "<escape>", "q"]);
    runKeys(vim, ["@", "q"]);
    expect(editor.undoTransactionDepthForTest()).toBe(0);
    expect(editor.getText()).toBe("start\nx y\nx y");
  });
});
