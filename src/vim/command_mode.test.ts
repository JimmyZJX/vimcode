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
