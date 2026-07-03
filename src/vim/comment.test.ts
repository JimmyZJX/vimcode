// vim-commentary compat (`gc`/`gC`): the commenting itself is the host's
// native language-aware toggle, so there is no Neovim fixture for it; these
// tests pin the delegation contract — which command runs, the selection it
// runs over, and where the cursor lands afterwards.
import { InMemoryVimEditor } from "./editor.js";
import type { NativeCommandOptions } from "./editor.js";
import { selectionHead } from "./state.js";
import type { VimSelection } from "./state.js";
import { Vim, runKeys } from "./vim.js";

class RecordingEditor extends InMemoryVimEditor {
  readonly calls: { command: string; selections: readonly VimSelection[] }[] = [];

  override executeNativeCommand(command: string, args: readonly unknown[] = [], options: NativeCommandOptions = {}): void {
    this.calls.push({ command, selections: this.getSelections() });
    super.executeNativeCommand(command, args, options);
  }
}

function head(editor: InMemoryVimEditor) {
  return selectionHead(editor.getSelections()[0]);
}

describe("commentary gc/gC", () => {
  it("gcc toggles the current line and restores the cursor", () => {
    const editor = new RecordingEditor("alpha beta\ngamma delta");
    const vim = new Vim(editor);
    runKeys(vim, ["j", "l", "l", "g", "c", "c"]);
    expect(editor.calls).toEqual([
      {
        command: "editor.action.commentLine",
        selections: [{ type: "charwise", anchor: { row: 1, column: 0 }, head: { row: 1, column: 11 } }],
      },
    ]);
    expect(head(editor)).toEqual({ row: 1, column: 2 });
    expect(vim.modeName).toBe("vim:normal");
  });

  it("gc{motion} is linewise over the motion rows (gc2j, gcip)", () => {
    const editor = new RecordingEditor("one\ntwo\nthree\nfour");
    const vim = new Vim(editor);
    runKeys(vim, ["g", "c", "2", "j"]);
    expect(editor.calls[0].command).toBe("editor.action.commentLine");
    expect(editor.calls[0].selections).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 2, column: 5 } },
    ]);

    const paragraph = new RecordingEditor("first\nsecond\n\nother");
    const paragraphVim = new Vim(paragraph);
    runKeys(paragraphVim, ["g", "c", "i", "p"]);
    expect(paragraph.calls[0].selections).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 1, column: 6 } },
    ]);
  });

  it("gcgc doubles like gcc", () => {
    const editor = new RecordingEditor("only line");
    const vim = new Vim(editor);
    runKeys(vim, ["g", "c", "g", "c"]);
    expect(editor.calls[0].command).toBe("editor.action.commentLine");
    expect(editor.calls[0].selections).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 0, column: 9 } },
    ]);
  });

  it("gCi) block-comments the exact inner range", () => {
    const editor = new RecordingEditor("call(arg one, arg two) tail");
    const vim = new Vim(editor);
    runKeys(vim, ["f", "a", "g", "C", "i", ")"]);
    expect(editor.calls).toEqual([
      {
        command: "editor.action.blockComment",
        selections: [{ type: "charwise", anchor: { row: 0, column: 5 }, head: { row: 0, column: 21 } }],
      },
    ]);
  });

  it("dot-repeat replays gcc on the new line", () => {
    const editor = new RecordingEditor("one\ntwo");
    const vim = new Vim(editor);
    runKeys(vim, ["g", "c", "c", "j", "."]);
    expect(editor.calls.map(call => call.selections[0].type === "charwise" && call.selections[0].anchor.row)).toEqual([0, 1]);
  });

  it("visual gc comments the selected rows and exits visual", () => {
    const editor = new RecordingEditor("one\ntwo\nthree");
    const vim = new Vim(editor);
    runKeys(vim, ["V", "j", "g", "c"]);
    expect(editor.calls[0].command).toBe("editor.action.commentLine");
    expect(editor.calls[0].selections).toEqual([
      { type: "charwise", anchor: { row: 0, column: 0 }, head: { row: 1, column: 3 } },
    ]);
    expect(vim.modeName).toBe("vim:normal");
    expect(head(editor)).toEqual({ row: 0, column: 0 });
    // The visual session must be torn down: a later `v` starts fresh.
    runKeys(vim, ["v"]);
    expect(vim.modeName).toBe("vim:visual");
    expect(editor.getSelections()[0]).toMatchObject({ type: "charwise", anchor: { row: 0, column: 0 } });
  });

  it("visual gC block-comments the exact charwise selection", () => {
    const editor = new RecordingEditor("alpha beta gamma");
    const vim = new Vim(editor);
    runKeys(vim, ["w", "v", "e", "g", "C"]);
    expect(editor.calls[0].command).toBe("editor.action.blockComment");
    expect(editor.calls[0].selections).toEqual([
      { type: "charwise", anchor: { row: 0, column: 6 }, head: { row: 0, column: 10 } },
    ]);
    expect(head(editor)).toEqual({ row: 0, column: 6 });
  });
});
