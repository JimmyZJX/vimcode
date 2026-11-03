// Host hooks a non-VSCode host (twr's CodeMirror editor) uses: ex commands it runs
// itself ([VimEditorCapabilities.executeHostExCommand]) and dropping a half-typed
// command without leaving the mode ([Vim.clearPending]). Also the `:` and `/` lines'
// Vim keys twr's users lean on: Backspace on an empty line, Ctrl+U.
import { InMemoryVimEditor, VimEditorCapabilities } from "./editor.js";
import { Vim, runKeys } from "./vim.js";

function cmd(text: string): string[] {
  return [":", ...[...text].map((c) => (c === " " ? "space" : c)), "enter"];
}

describe("executeHostExCommand", () => {
  it("sees the command line after its range and replaces the built-in command", () => {
    const editor = new InMemoryVimEditor("a\nb\nc");
    const seen: string[] = [];
    (editor as VimEditorCapabilities).executeHostExCommand = (command: string) => {
      seen.push(command);
      return command.startsWith("w") || command.startsWith("e ");
    };
    const vim = new Vim(editor);
    runKeys(vim, cmd("w!"));
    runKeys(vim, cmd("e app/b.ml"));
    expect(editor.nativeCommands).toEqual([]);
    // Declined: the built-in command runs.
    runKeys(vim, cmd("2,3d"));
    expect(seen).toEqual(["w!", "e app/b.ml", "d"]);
    expect(editor.getText()).toBe("a");
  });

  it("gets the typed range, if any", () => {
    const editor = new InMemoryVimEditor("a\nb\nc\nd");
    const seen: unknown[] = [];
    (editor as VimEditorCapabilities).executeHostExCommand = (command, range) => {
      seen.push([command, range]);
      return true;
    };
    const vim = new Vim(editor);
    runKeys(vim, cmd("w"));
    runKeys(vim, cmd("2,3w"));
    runKeys(vim, cmd("%w"));
    runKeys(vim, ["j", "V", "j", ...cmd("w")]);
    expect(seen).toEqual([
      ["w", undefined],
      ["w", { startRow: 1, endRowInclusive: 2 }],
      ["w", { startRow: 0, endRowInclusive: 3 }],
      ["w", { startRow: 1, endRowInclusive: 2 }],
    ]);
  });
});

describe("clearPending", () => {
  it("drops a count without leaving visual mode", () => {
    const editor = new InMemoryVimEditor("abc def ghi");
    const vim = new Vim(editor);
    runKeys(vim, ["v", "3"]);
    expect(vim.status.pending).toBe(true);
    vim.clearPending();
    expect(vim.status.pending).toBe(false);
    expect(vim.mode).toBe("visual");
    runKeys(vim, ["l"]);
    // One cell, not three: the count is gone.
    expect(vim.status.chord).toBe("");
  });

  it("abandons an open : prompt", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor);
    runKeys(vim, [":", "x"]);
    vim.clearPending();
    expect(vim.mode).toBe("normal");
  });

  it("drops a pending operator", () => {
    const editor = new InMemoryVimEditor("abc def");
    const vim = new Vim(editor);
    runKeys(vim, ["2", "d"]);
    vim.clearPending();
    runKeys(vim, ["w"]);
    expect(editor.getText()).toBe("abc def");
    expect(vim.mode).toBe("normal");
  });
});

describe("prompt line keys", () => {
  it("backspace on an empty : or / line leaves it", () => {
    const editor = new InMemoryVimEditor("abc\ndef");
    const vim = new Vim(editor);
    runKeys(vim, [":", "x", "backspace"]);
    expect(vim.mode).toBe("command");
    runKeys(vim, ["backspace"]);
    expect(vim.mode).toBe("normal");
    runKeys(vim, ["j"]);
    expect(editor.getText()).toBe("abc\ndef");
    runKeys(vim, ["/", "backspace"]);
    expect(vim.mode).toBe("normal");
  });

  it("backspace on an empty d/ line drops the operator", () => {
    const editor = new InMemoryVimEditor("abc def");
    const vim = new Vim(editor);
    runKeys(vim, ["d", "/", "backspace"]);
    expect(vim.status.pending).toBe(false);
    runKeys(vim, ["w", "x"]);
    expect(editor.getText()).toBe("abc ef");
  });

  it("ctrl-u clears the : line before the cursor", () => {
    const editor = new InMemoryVimEditor("abc\ndef");
    const vim = new Vim(editor);
    runKeys(vim, [":", "f", "o", "o", "ctrl-u", "2", "d", "enter"]);
    expect(editor.getText()).toBe("abc");
  });
});
