// `:` command mode driven through the typed key-handler framework
// (command_handler.ts). These clean-context cases (normal-mode `:` and a
// `v`-entered visual `:`) exercise the framework path specifically: the Neovim
// command fixtures (`test_normal_command` etc.) mostly use Put-restored
// (externally-adopted) visual selections, which still fall to the legacy
// dispatcher, so they do not cover the framework path on their own. The
// `:normal` case pins the re-entrancy contract (command execution runs its keys
// synchronously, after the executor's effect queue drains).
import { InMemoryVimEditor } from "./editor.js";
import { Vim, runKeys } from "./vim.js";
import { VimGlobalState } from "./vim_state.js";
import { selectionHead } from "./state.js";

function head(editor: InMemoryVimEditor) {
  return selectionHead(editor.getSelections()[0]);
}

function cmd(text: string): string[] {
  return [":", ...[...text].map((c) => (c === " " ? "space" : c)), "enter"];
}

describe("command mode via framework (clean contexts)", () => {
  it("normal-mode : goto line moves the cursor and returns to normal", () => {
    const editor = new InMemoryVimEditor("a\nb\nc\nd");
    const vim = new Vim(editor);
    runKeys(vim, cmd("3"));
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 2, column: 0 });
  });

  it("normal-mode :d deletes the current line", () => {
    const editor = new InMemoryVimEditor("abc\ndef\nghi");
    const vim = new Vim(editor);
    runKeys(vim, cmd("d"));
    expect(editor.getText()).toBe("def\nghi");
  });

  it("visual : prefills the '<,'> range so a range command applies to the selection", () => {
    const editor = new InMemoryVimEditor("a\nb\nc\nd");
    const vim = new Vim(editor);
    // Select rows 0-1 with V j, then :d deletes the '<,'> range.
    runKeys(vim, ["V", "j"]);
    expect(vim.modeName).toBe("vim:visualLine");
    runKeys(vim, cmd("d"));
    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getText()).toBe("c\nd");
  });

  it(":normal re-enters the key pipeline and runs keys synchronously", () => {
    const editor = new InMemoryVimEditor("xyz\nqrs");
    const vim = new Vim(editor);
    runKeys(vim, cmd("normal Iab"));
    expect(editor.getText()).toBe("abxyz\nqrs");
    expect(vim.modeName).toBe("vim:normal");
  });

  it("escape cancels the command line without executing", () => {
    const editor = new InMemoryVimEditor("abc\ndef\nghi");
    const vim = new Vim(editor);
    runKeys(vim, [":", "d"]);
    expect(vim.modeName).toBe("vim:command");
    runKeys(vim, ["<escape>"]);
    expect(vim.modeName).toBe("vim:normal");
    expect(editor.getText()).toBe("abc\ndef\nghi");
  });

  it("backspace edits the command line", () => {
    const editor = new InMemoryVimEditor("a\nb\nc\nd");
    const vim = new Vim(editor);
    // Type ":4", backspace to ":", then "3", enter -> goto line 3.
    runKeys(vim, [":", "4", "backspace", "3", "enter"]);
    expect(head(editor)).toEqual({ row: 2, column: 0 });
  });

  it(":v! is rejected (Vim E477) and :g rejects alphanumeric delimiters", () => {
    const editor = new InMemoryVimEditor("a1\nb1\na2");
    const vim = new Vim(editor);
    runKeys(vim, cmd("v!/a/d"));
    expect(editor.getText()).toBe("a1\nb1\na2");
    runKeys(vim, cmd("gxaxd"));
    expect(editor.getText()).toBe("a1\nb1\na2");
  });

  it(":g// and :s// without a previous search pattern do nothing (Vim E35)", () => {
    const editor = new InMemoryVimEditor("a1\nb1\na2");
    const vim = new Vim(editor);
    runKeys(vim, cmd("g//d"));
    runKeys(vim, cmd("s//X/"));
    expect(editor.getText()).toBe("a1\nb1\na2");
  });

  it(":g/:s pattern writes do not touch the search highlight", () => {
    // `:g/pat/s//X/` + undo must not leave the pattern glowing: the editing
    // command sets `@/` (n follows it) but never the visible highlight.
    const editor = new InMemoryVimEditor("foo a\nbar\nfoo b");
    const vim = new Vim(editor);
    runKeys(vim, cmd("g/foo/s//X/"));
    expect(editor.getText()).toBe("X a\nbar\nX b");
    expect(vim.readRegister("/")).toBe("foo");
    expect(editor.lastSearchHighlightQuery).toBeUndefined();
    // A real search still updates the highlight.
    runKeys(vim, ["/", "b", "a", "r", "enter"]);
    expect(editor.lastSearchHighlightQuery).toBe("bar");
  });

  it("a nested :g is not executed (Vim global_busy)", () => {
    const editor = new InMemoryVimEditor("a\nb");
    const vim = new Vim(editor);
    runKeys(vim, cmd("g/a/g/b/d"));
    expect(editor.getText()).toBe("a\nb");
  });

  it("reports ex-command outcomes in the status (Vim 'report' messages)", () => {
    // Deleting more than 'report' (2) lines.
    const vim = new Vim(new InMemoryVimEditor("a1\nb\na2\nc\na3"));
    runKeys(vim, cmd("g/a/d"));
    expect(vim.status.commandStatus).toEqual({ kind: "info", message: "3 fewer lines" });
    expect(vim.status.commandStatusRemainingMs).toBeGreaterThan(0);

    // A single-line delete stays silent.
    const quietVim = new Vim(new InMemoryVimEditor("a\nb"));
    runKeys(quietVim, cmd("d"));
    expect(quietVim.status.commandStatus).toBeUndefined();

    // Substitution totals aggregate across a :g run.
    const subVim = new Vim(new InMemoryVimEditor("foo foo\nfoo\nbar"));
    runKeys(subVim, cmd("%s/foo/X/g"));
    expect(subVim.status.commandStatus).toEqual({ kind: "info", message: "3 substitutions on 2 lines" });

    // The n flag counts without editing and always reports.
    const countEditor = new InMemoryVimEditor("foo foo\nfoo\nbar");
    const countVim = new Vim(countEditor);
    runKeys(countVim, cmd("%s/foo/X/gn"));
    expect(countVim.status.commandStatus).toEqual({ kind: "info", message: "3 matches on 2 lines" });
    expect(countEditor.getText()).toBe("foo foo\nfoo\nbar");

    // E486 and E35 surface as errors.
    const notFoundVim = new Vim(new InMemoryVimEditor("a\nb"));
    runKeys(notFoundVim, cmd("g/zzz/d"));
    expect(notFoundVim.status.commandStatus).toEqual({ kind: "error", message: "Pattern not found: zzz" });
    const subMissVim = new Vim(new InMemoryVimEditor("a"));
    runKeys(subMissVim, cmd("s/zzz/x/"));
    expect(subMissVim.status.commandStatus).toEqual({ kind: "error", message: "Pattern not found: zzz" });
    const noPatternVim = new Vim(new InMemoryVimEditor("a"));
    runKeys(noPatternVim, cmd("s//X/"));
    expect(noPatternVim.status.commandStatus).toEqual({ kind: "error", message: "No previous regular expression" });

    // Yanks report their line count past the threshold.
    const yankVim = new Vim(new InMemoryVimEditor("a\nb\nc\nd"));
    runKeys(yankVim, cmd("%y"));
    expect(yankVim.status.commandStatus).toEqual({ kind: "info", message: "4 lines yanked" });
  });

  it(":g dispatches :pu per marked line", () => {
    const editor = new InMemoryVimEditor("P\nx1\na\nx2");
    const vim = new Vim(editor);
    // yy fills the unnamed register with "P\n" (linewise).
    runKeys(vim, ["y", "y"]);
    runKeys(vim, cmd("g/x/pu"));
    expect(editor.getText()).toBe("P\nx1\nP\na\nx2\nP");
  });
});

// `:s` replacement specials and JS capture groups (the pattern language is
// JS regex, so `(...)`-group scenarios cannot be pinned against Neovim —
// see test_vim_regex for the shared `\<`/`\>`/`\c`/`\C`/`&`/`\r` subset).
describe(":s capture groups and replacement escapes", () => {
  function run(text: string, command: string): { text: string } {
    const editor = new InMemoryVimEditor(text);
    const vim = new Vim(editor);
    runKeys(vim, [":", ...command.split("").map(key => (key === " " ? "space" : key)), "enter"]);
    return { text: editor.getText() };
  }

  it("reorders capture groups", () => {
    expect(run("alpha-beta", "s/(\\w+)-(\\w+)/\\2_\\1/").text).toBe("beta_alpha");
  });

  it("expands an unmatched group to the empty string", () => {
    expect(run("abc", "s/a(x)?(b)/\\1\\2/").text).toBe("bc");
  });

  it("inserts a literal ampersand with \\&", () => {
    expect(run("one and two", "s/and/\\&/").text).toBe("one & two");
  });

  it("inserts a tab with \\t", () => {
    expect(run("a b", "s/ /\\t/").text).toBe("a\tb");
  });

  it("case-forces the pattern with \\c", () => {
    expect(run("keep FOO", "s/foo\\c/bar/").text).toBe("keep bar");
  });
});

describe("compound host commands run in sequence", () => {
  // Native commands are asynchronous: if `:wq` fired save and close as two
  // independent commands, the close would race the in-flight save and VSCode
  // would still see a dirty editor (and ask for confirmation). The follow-up
  // command must be chained after the first one completes.
  it(":wq chains the close after the save", () => {
    const editor = new InMemoryVimEditor("a");
    const vim = new Vim(editor);
    runKeys(vim, cmd("wq"));
    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.files.save", args: [] },
      { command: "workbench.action.closeActiveEditor", args: [] },
    ]);
    expect(editor.chainedNativeCommands).toEqual(["workbench.action.closeActiveEditor"]);
  });

  it(":wqa and :x chain, and split+new chains too", () => {
    const editor = new InMemoryVimEditor("a");
    const vim = new Vim(editor);
    runKeys(vim, [...cmd("wqa"), ...cmd("x"), ...cmd("new")]);
    expect(editor.chainedNativeCommands).toEqual([
      "workbench.action.closeAllEditors",
      "workbench.action.closeActiveEditor",
      "workbench.action.files.newUntitledFile",
    ]);
  });
});

describe("@: repeats the last command-line", () => {
  it("repeats a substitution, and @@ repeats it again", () => {
    const editor = new InMemoryVimEditor("foo foo foo");
    const vim = new Vim(editor);
    runKeys(vim, cmd("s/foo/bar"));
    expect(editor.getText()).toBe("bar foo foo");
    runKeys(vim, ["@", ":"]);
    expect(editor.getText()).toBe("bar bar foo");
    runKeys(vim, ["@", "@"]);
    expect(editor.getText()).toBe("bar bar bar");
  });

  it("runs [count] times", () => {
    const editor = new InMemoryVimEditor("a a a a");
    const vim = new Vim(editor);
    runKeys(vim, [...cmd("s/a/b"), "3", "@", ":"]);
    expect(editor.getText()).toBe("b b b b");
  });

  it("repeats the last executed command, not one abandoned with escape", () => {
    const editor = new InMemoryVimEditor("foo foo");
    const vim = new Vim(editor);
    runKeys(vim, [...cmd("s/foo/bar"), ":", "q", "escape", "@", ":"]);
    expect(editor.getText()).toBe("bar bar");
  });

  it("reports E30 when no command line was ever executed", () => {
    const editor = new InMemoryVimEditor("foo");
    const vim = new Vim(editor);
    runKeys(vim, ["@", ":"]);
    expect(editor.getText()).toBe("foo");
    expect(vim.status.commandStatus).toEqual({ kind: "error", message: "E30: No previous command line" });
  });

  it("a failing @: still makes @@ retry the command line, not the last macro (nvim-verified)", () => {
    // Neovim's `do_execreg` updates `execreg_lastc` before the empty-command-
    // line check, so `@@` after an E30 `@:` errors again instead of re-running
    // the previously replayed register.
    const editor = new InMemoryVimEditor("x1\nx2\nx3");
    const vim = new Vim(editor);
    runKeys(vim, ["q", "a", "d", "d", "q", "@", "a"]);
    expect(editor.getText()).toBe("x3");
    runKeys(vim, ["@", ":"]);
    expect(vim.status.commandStatus).toEqual({ kind: "error", message: "E30: No previous command line" });
    runKeys(vim, ["@", "@"]);
    expect(editor.getText()).toBe("x3");
    expect(vim.status.commandStatus).toEqual({ kind: "error", message: "E30: No previous command line" });
  });

  it("q: does not start a recording into the : register", () => {
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor);
    runKeys(vim, ["q", ":"]);
    expect(vim.status.macroRecording).toBeUndefined();
    expect(vim.modeName).toBe("vim:normal");
    // The rejected chord must not swallow the next key.
    runKeys(vim, ["x"]);
    expect(editor.getText()).toBe("bc");
  });

  it("repeats across editors sharing the global state (another file)", () => {
    const globalState = new VimGlobalState();
    const firstEditor = new InMemoryVimEditor("foo");
    const firstVim = new Vim(firstEditor, {}, globalState);
    runKeys(firstVim, cmd("s/foo/bar"));
    expect(firstEditor.getText()).toBe("bar");

    const secondEditor = new InMemoryVimEditor("foo qux");
    const secondVim = new Vim(secondEditor, {}, globalState);
    runKeys(secondVim, ["@", ":"]);
    expect(secondEditor.getText()).toBe("bar qux");
  });
});

describe(":b buffer switching", () => {
  function bufferVim() {
    const editor = new InMemoryVimEditor("a");
    return { editor, vim: new Vim(editor) };
  }

  it(":b1 jumps to the first tab in the group", () => {
    const { editor, vim } = bufferVim();
    runKeys(vim, cmd("b1"));
    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.openEditorAtIndex", args: [0] },
    ]);
  });

  it("abbreviations, spaced counts, and the bang all resolve to the tab index", () => {
    const { editor, vim } = bufferVim();
    runKeys(vim, [...cmd("buffer 3"), ...cmd("bu2"), ...cmd("b! 4")]);
    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.openEditorAtIndex", args: [2] },
      { command: "workbench.action.openEditorAtIndex", args: [1] },
      { command: "workbench.action.openEditorAtIndex", args: [3] },
    ]);
  });

  it(":b# switches to the alternate (most recently used) tab", () => {
    const { editor, vim } = bufferVim();
    runKeys(vim, cmd("b#"));
    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.openPreviousRecentlyUsedEditorInGroup", args: [] },
    ]);
  });

  it(":b name opens quick-open filtered by the name", () => {
    const { editor, vim } = bufferVim();
    runKeys(vim, cmd("b main.ts"));
    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.quickOpen", args: ["main.ts"] },
    ]);
  });

  it(":b0 reports E939 and runs nothing", () => {
    const { editor, vim } = bufferVim();
    runKeys(vim, cmd("b0"));
    expect(editor.nativeCommands).toEqual([]);
    expect(vim.status.commandStatus).toEqual({ kind: "error", message: "E939: Positive count required" });
  });

  it("bare :b is a no-op and :bn stays bnext", () => {
    const { editor, vim } = bufferVim();
    runKeys(vim, [...cmd("b"), ...cmd("bn")]);
    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.nextEditorInGroup", args: [] },
    ]);
  });
});

describe(":w does not hold the key pipeline", () => {
  // The save's completion promise must not join the awaited selection syncs
  // (that froze typing under slow save participants); it reconciles in the
  // background instead. Undo/redo keep the blocking sync — the next key
  // depends on the restored state.
  it(":w saves with a background sync", () => {
    const editor = new InMemoryVimEditor("a");
    const vim = new Vim(editor);
    runKeys(vim, cmd("w"));
    expect(editor.nativeCommands).toEqual([
      { command: "workbench.action.files.save", args: [] },
    ]);
    expect(editor.backgroundSyncNativeCommands).toEqual(["workbench.action.files.save"]);
  });
});
