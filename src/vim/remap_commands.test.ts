import type { VimCommandMapping } from "./config.js";
import { InMemoryVimEditor } from "./editor.js";
import type { VimSystemClipboard } from "./registers.js";
import { charwiseSelection, selectionHead } from "./state.js";
import type { VimSelection } from "./state.js";
import { Vim } from "./vim.js";

class StaticClipboard implements VimSystemClipboard {
  async readText(): Promise<string> {
    return "";
  }

  writeText(_text: string): void {}
}

const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function commandArgs(command: VimCommandMapping): readonly unknown[] {
  if (typeof command === "string" || command.args === undefined) return [];
  return Array.isArray(command.args) ? command.args : [command.args];
}

function describeSelection(selection: VimSelection): string {
  if (selection.type !== "charwise") return selection.type;
  return `${selection.anchor.row},${selection.anchor.column}-${selection.head.row},${selection.head.column}`;
}

// A VSCode-like host: native commands complete asynchronously, change the
// selection without Vim seeing it, and can call back into Vim the way
// `vimcode.remap` and `runCommands` do.
function setup(commands: readonly VimCommandMapping[], { clipboard }: { clipboard: boolean }) {
  const editor = new InMemoryVimEditor("call(a,\n  b)\nend");
  editor.setSelections([charwiseSelection({ row: 1, column: 2 })]);
  const vim = new Vim(editor, { normalModeKeyBindings: [{ before: ["z", "C"], commands }] });
  const systemClipboard = clipboard ? new StaticClipboard() : undefined;
  const log: string[] = [];
  // VSCode runs the command handler synchronously inside `executeCommand`, so
  // the callback reaches Vim before the native command call returns.
  editor.nativeCommandHandlers.set("vimcode.remap", async args => {
    const remap = args[0] as { after: string[] };
    log.push(`remap ${remap.after.join("")}`);
    await vim.executeExternalRemap(remap, systemClipboard);
  });
  // Like `editor.createFoldingRangeFromSelection`: folds the selection, then
  // collapses it to the fold start.
  editor.nativeCommandHandlers.set("test.fold", async () => {
    await nextTask();
    const selection = editor.getSelections()[0];
    log.push(`fold ${vim.status.mode} ${describeSelection(selection)}`);
    const start = selection.type === "charwise" ? selection.anchor : selectionHead(selection);
    editor.setSelectionsExternally([charwiseSelection(start)]);
  });
  editor.nativeCommandHandlers.set("runCommands", async args => {
    for (const command of (args[0] as { commands: VimCommandMapping[] }).commands) {
      const id = typeof command === "string" ? command : command.command;
      await editor.executeNativeCommand(id, commandArgs(command), { awaitCompletion: true });
    }
  });
  const press = async (keys: readonly string[]) => {
    for (const key of keys) await vim.handleKey(key)?.run({ clipboard: systemClipboard });
  };
  return { editor, vim, log, press };
}

const foldEnclosingParens: readonly VimCommandMapping[] = [
  { command: "vimcode.remap", args: { after: ["[", "(", "v", "%"] } },
  { command: "test.fold" },
  { command: "vimcode.remap", args: { after: ["<escape>"] } },
];

describe("remap commands with asynchronous native commands", () => {
  for (const clipboard of [true, false]) {
    describe(clipboard ? "with a clipboard transaction" : "without a clipboard transaction", () => {
      it("runs each command after the previous one completes", async () => {
        const { editor, vim, log, press } = setup(foldEnclosingParens, { clipboard });

        await press(["z", "C"]);

        expect(log).toEqual(["remap [(v%", "fold visual 0,4-1,4", "remap <escape>"]);
        expect(vim.status.mode).toBe("normal");
        expect(selectionHead(editor.getSelections()[0])).toEqual({ row: 0, column: 4 });
      });

      it("adopts selection changes made inside runCommands before a nested remap", async () => {
        const { editor, vim, log, press } = setup(
          [{ command: "runCommands", args: { commands: foldEnclosingParens } }],
          { clipboard }
        );

        await press(["z", "C"]);

        expect(log).toEqual(["remap [(v%", "fold visual 0,4-1,4", "remap <escape>"]);
        // The fold collapsed the selection, so Vim leaves visual mode there;
        // the escape must not move the cursor back to the stale visual head.
        expect(vim.status.mode).toBe("normal");
        expect(selectionHead(editor.getSelections()[0])).toEqual({ row: 0, column: 4 });
      });
    });
  }

  it("keeps working when an unrelated remap overlaps a mapping's native command", async () => {
    // An unrelated `vim.remap` (a keybinding, a leaderkey item) that arrives
    // while a mapping waits on a slow command (format, save) cannot be told
    // apart from a callback, so it runs nested. If that nested remap is still
    // running when the slow command finishes, the mapping must not resume
    // underneath it.
    const editor = new InMemoryVimEditor("aaaa\nbbbb\ncccc\ndddd");
    const vim = new Vim(editor, { normalModeKeyBindings: [{ before: ["z", "S"], commands: [{ command: "test.save" }] }] });
    const clipboard = new StaticClipboard();
    const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    editor.nativeCommandHandlers.set("test.save", () => sleep(20));
    editor.nativeCommandHandlers.set("test.slow", () => sleep(40));

    const mapping = (async () => {
      for (const key of ["z", "S"]) await vim.handleKey(key)?.run({ clipboard });
    })();
    await sleep(5);
    const unrelated = vim.executeExternalRemap({ after: ["j"], commands: [{ command: "test.slow" }] }, clipboard);
    await Promise.all([mapping, unrelated]);
    await vim.handleKey("j")?.run({ clipboard });

    expect(vim.isAwaitingMappedCommand()).toBe(false);
    expect(selectionHead(editor.getSelections()[0])).toEqual({ row: 2, column: 0 });
  });

  it("lets a nested remap sharing the key job's clipboard transaction paste its yank", async () => {
    // The host hands a nested `vimcode.remap` the transaction of the key job it
    // runs in: that job's yank is still buffered there, not on the OS clipboard.
    class BufferedClipboard implements VimSystemClipboard {
      pending: string | undefined;
      constructor(private readonly osText: string) {}
      async readText(): Promise<string> {
        return this.pending ?? this.osText;
      }
      writeText(text: string): void {
        this.pending = text;
      }
    }
    const editor = new InMemoryVimEditor("foo bar");
    const vim = new Vim(editor, {
      useSystemClipboard: true,
      normalModeKeyBindings: [{
        before: ["z", "Y"],
        after: ["y", "i", "w"],
        commands: [{ command: "vimcode.remap", args: { after: ["P"] } }],
      }],
    });
    const clipboard = new BufferedClipboard("stale");
    editor.nativeCommandHandlers.set("vimcode.remap", async args => {
      await vim.executeExternalRemap(args[0] as { after: string[] }, clipboard);
    });

    for (const key of ["z", "Y"]) await vim.handleKey(key)?.run({ clipboard });

    expect(editor.getText()).toBe("foofoo bar");
  });

  it("runs a mapping's native command on each line of a ranged :normal", async () => {
    // `:normal` drains its keys' effects synchronously, so it cannot wait for
    // the mapping's asynchronous command.
    const editor = new InMemoryVimEditor("one\ntwo\nthree\nfour");
    const vim = new Vim(editor, { normalModeKeyBindings: [{ before: ["z", "c"], commands: ["test.comment"] }] });
    const rows: number[] = [];
    editor.nativeCommandHandlers.set("test.comment", async () => {
      rows.push(selectionHead(editor.getSelections()[0]).row);
    });

    for (const key of [":", "1", ",", "3", "n", "o", "r", "m", " ", "z", "c", "enter"]) {
      await vim.handleKey(key)?.run();
    }

    expect(rows).toEqual([0, 1, 2]);
  });

  it("runs keys typed after the mapping once its commands finish", async () => {
    const { editor, log, press } = setup(foldEnclosingParens, { clipboard: true });

    await press(["z", "C", "j"]);

    expect(log).toEqual(["remap [(v%", "fold visual 0,4-1,4", "remap <escape>"]);
    expect(selectionHead(editor.getSelections()[0])).toEqual({ row: 1, column: 3 });
  });
});
