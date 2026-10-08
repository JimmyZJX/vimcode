import { InMemoryVimEditor } from "./editor.js";
import { InsertEdit, TrackedSpan, diffInsertEdit } from "./native_insert_edit.js";
import { rangeOfSelection, selectionHead } from "./state.js";
import { Vim, runKeys } from "./vim.js";

const cursor = (offset: number) => ({ anchor: offset, head: offset });

// The host's native handling of a key: VSCode edits the buffer itself (the
// in-memory editor stands in for it here).
function applyNatively(editor: InMemoryVimEditor, edit: InsertEdit): void {
  const range = rangeOfSelection(editor.getSelections()[0]);
  const from = { row: range.start.row, column: range.start.column + edit.from };
  const to = { row: range.end.row, column: range.end.column + edit.to };
  const at = (offset: number) => {
    const lines = edit.text.slice(0, offset).split("\n");
    return lines.length === 1
      ? { row: from.row, column: from.column + offset }
      : { row: from.row + lines.length - 1, column: lines[lines.length - 1].length };
  };
  editor.applyEdits([{ range: { start: from, end: to }, text: edit.text }], [{ type: "charwise", anchor: at(edit.anchor), head: at(edit.head) }], { undoStopAfter: false });
}

// A key Vim declines (e.g. `tab`): VSCode handles it, the host reports the effect.
function nativeKey(editor: InMemoryVimEditor, vim: Vim, key: string, edit: InsertEdit): void {
  applyNatively(editor, edit);
  vim.recordNativeInsertEdit(key, edit, { supersedesTyped: false });
}

// A passthrough key: Vim records it as typed, VSCode handles it, and the host
// then reports the effect in its place, in the order the host's key queue runs.
async function passthroughKey(editor: InMemoryVimEditor, vim: Vim, key: string, edit: InsertEdit): Promise<void> {
  const plan = vim.handleKey(key);
  expect(plan?.passthrough).toBe(true);
  applyNatively(editor, edit);
  await plan?.run();
  vim.recordNativeInsertEdit(key, edit, { supersedesTyped: true });
}

describe("diffInsertEdit", () => {
  it("records a snippet expansion as text plus the placeholder selection", () => {
    expect(diffInsertEdit({
      before: "  Expe",
      after: "  expect(actual).toBe()",
      selectionBefore: cursor(6),
      selectionAfter: { anchor: 9, head: 15 },
      allowCursorOnly: false,
    })).toEqual({ from: -4, to: 0, text: "expect(actual).toBe()", anchor: 7, head: 13 });
  });

  it("keeps the replaced range around the cursor when the diff is ambiguous", () => {
    expect(diffInsertEdit({ before: "aa", after: "aaa", selectionBefore: cursor(1), selectionAfter: cursor(2), allowCursorOnly: false }))
      .toEqual({ from: 0, to: 0, text: "a", anchor: 1, head: 1 });
  });

  it("drops a cursor-only effect unless allowed", () => {
    const snapshot = { before: "f(a, b)", after: "f(a, b)", selectionBefore: { anchor: 2, head: 3 }, selectionAfter: { anchor: 5, head: 6 } };
    expect(diffInsertEdit({ ...snapshot, allowCursorOnly: false })).toBeUndefined();
    expect(diffInsertEdit({ ...snapshot, allowCursorOnly: true })).toEqual({ from: 0, to: 0, text: "a", anchor: 3, head: 4 });
  });

  it("collapses a selection that left the span to the end of the text", () => {
    expect(diffInsertEdit({ before: "x", after: "xy", selectionBefore: cursor(1), selectionAfter: cursor(10), allowCursorOnly: false }))
      .toEqual({ from: 0, to: 0, text: "y", anchor: 1, head: 1 });
  });
});

describe("TrackedSpan", () => {
  it("shifts for edits before it, grows for touching edits, ignores edits after it", () => {
    const span = new TrackedSpan(10, 20);
    span.applyChange(0, 0, 12); // auto-import at the top
    expect([span.start, span.end]).toEqual([22, 32]);
    span.applyChange(32, 0, 3); // typed at the end
    expect([span.start, span.end]).toEqual([22, 35]);
    span.applyChange(25, 4, 1); // reindent inside
    expect([span.start, span.end]).toEqual([22, 32]);
    span.applyChange(40, 2, 0);
    expect([span.start, span.end]).toEqual([22, 32]);
  });
});

describe("native insert edits in recordings", () => {
  const snippet: InsertEdit = { from: -4, to: 0, text: "expect()", anchor: 7, head: 7 };

  it("dot-repeats a snippet a native tab expanded", () => {
    const editor = new InMemoryVimEditor("a");
    const vim = new Vim(editor);
    runKeys(vim, ["o", "e", "x", "p", "e"]);
    nativeKey(editor, vim, "tab", snippet);
    runKeys(vim, ["1", "<escape>", "."]);
    expect(editor.getText()).toBe("a\nexpect(1)\nexpect(1)");
    expect(selectionHead(editor.getSelections()[0])).toEqual({ row: 2, column: 7 });
  });

  it("replays a snippet in a macro", () => {
    const editor = new InMemoryVimEditor("a");
    const vim = new Vim(editor);
    runKeys(vim, ["q", "q", "o", "e", "x", "p", "e"]);
    nativeKey(editor, vim, "tab", snippet);
    runKeys(vim, ["<escape>", "q", "@", "q"]);
    expect(editor.getText()).toBe("a\nexpect()\nexpect()");
  });

  it("dot-repeats the last change of a macro that contains a native edit", () => {
    const editor = new InMemoryVimEditor("a");
    const vim = new Vim(editor);
    runKeys(vim, ["q", "q", "o", "e", "x", "p", "e"]);
    nativeKey(editor, vim, "tab", snippet);
    runKeys(vim, ["<escape>", "q", "@", "q", "."]);
    expect(editor.getText()).toBe("a\nexpect()\nexpect()\nexpect()");
  });

  it("replaces the typed entry of a passthrough key with its native effect", async () => {
    const editor = new InMemoryVimEditor("");
    const vim = new Vim(editor);
    runKeys(vim, ["A", "e", "x", "p"]);
    // `enter` accepts the selected suggestion instead of breaking the line.
    await passthroughKey(editor, vim, "enter", { from: -3, to: 0, text: "expect", anchor: 6, head: 6 });
    runKeys(vim, ["<escape>", "."]);
    expect(editor.getText()).toBe("expectexpect");
  });

  it("count-repeats the whole chunk, including text after the cursor", () => {
    const editor = new InMemoryVimEditor("");
    const vim = new Vim(editor);
    runKeys(vim, ["3", "i"]);
    // A snippet that leaves the cursor between its brackets.
    nativeKey(editor, vim, "tab", { from: 0, to: 0, text: "()", anchor: 1, head: 1 });
    runKeys(vim, ["<escape>"]);
    expect(editor.getText()).toBe("()()()");
  });

  it("replays a cursor-only tabstop jump relative to the inserted text", async () => {
    const editor = new InMemoryVimEditor("");
    const vim = new Vim(editor);
    runKeys(vim, ["o", "f"]);
    nativeKey(editor, vim, "tab", { from: -1, to: 0, text: "f(a, b)", anchor: 2, head: 3 });
    // Tabstop 2: `b` selected, nothing edited.
    nativeKey(editor, vim, "tab", { from: 0, to: 0, text: "a", anchor: 3, head: 4 });
    await passthroughKey(editor, vim, "y", { from: 0, to: 0, text: "y", anchor: 1, head: 1 });
    runKeys(vim, ["<escape>", "."]);
    expect(editor.getText()).toBe("\nf(a, y)\nf(a, y)");
  });
});
