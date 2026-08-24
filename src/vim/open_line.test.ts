// `o`/`O` host delegation: when the editor provides [openLineNatively]
// (production VSCode), the insert entry runs the host's language-aware line
// insertion instead of the model-buffer edit. Without the capability the
// fallback opens an unindented line — that model-buffer behavior is pinned by
// the Neovim fixtures (test_o / test_insert_line_above).
import { InMemoryVimEditor } from "./editor.js";
import { charwiseSelection, selectionHead } from "./state.js";
import { Vim, runKeys } from "./vim.js";

// Simulates a host whose native line insertion applies a fixed two-space
// language indent (the in-memory editor has no language configuration).
class NativeOpenLineEditor extends InMemoryVimEditor {
  readonly nativeOpenCalls: { above: boolean }[] = [];

  openLineNatively({ above }: { above: boolean }): boolean {
    this.nativeOpenCalls.push({ above });
    const indent = "  ";
    const row = selectionHead(this.getSelections()[0]).row;
    const insertAt = above ? { row, column: 0 } : { row, column: this.lineLength(row) };
    this.applyEdits(
      [{ range: { start: insertAt, end: insertAt }, text: above ? `${indent}\n` : `\n${indent}` }],
      [charwiseSelection({ row: above ? row : row + 1, column: indent.length })]
    );
    return true;
  }
}

function head(editor: InMemoryVimEditor) {
  return selectionHead(editor.getSelections()[0]);
}

describe("o/O delegate to the host's native line insertion when available", () => {
  it("o opens below with the host indent and enters insert after it", () => {
    const editor = new NativeOpenLineEditor("hello");
    const vim = new Vim(editor);

    runKeys(vim, ["o"]);

    expect(editor.nativeOpenCalls).toEqual([{ above: false }]);
    expect(editor.getText()).toBe("hello\n  ");
    expect(head(editor)).toEqual({ row: 1, column: 2 });
    expect(vim.modeName).toBe("vim:insert");
  });

  it("O opens above with the host indent", () => {
    const editor = new NativeOpenLineEditor("hello");
    const vim = new Vim(editor);

    runKeys(vim, ["O"]);

    expect(editor.nativeOpenCalls).toEqual([{ above: true }]);
    expect(editor.getText()).toBe("  \nhello");
    expect(head(editor)).toEqual({ row: 0, column: 2 });
    expect(vim.modeName).toBe("vim:insert");
  });

  it("typed text continues after the host indent", () => {
    const editor = new NativeOpenLineEditor("hello");
    const vim = new Vim(editor);

    runKeys(vim, ["o", "x", "escape"]);

    expect(editor.getText()).toBe("hello\n  x");
    expect(vim.modeName).toBe("vim:normal");
  });

  it("without the capability the fallback copies the current line's indent (autoindent)", () => {
    const editor = new InMemoryVimEditor("  hello");
    const vim = new Vim(editor);

    runKeys(vim, ["o"]);

    expect(editor.getText()).toBe("  hello\n  ");
    expect(head(editor)).toEqual({ row: 1, column: 2 });
    expect(vim.modeName).toBe("vim:insert");
  });

  it("the fallback O also copies the current line's indent", () => {
    const editor = new InMemoryVimEditor("\thello");
    const vim = new Vim(editor);

    runKeys(vim, ["O"]);

    expect(editor.getText()).toBe("\t\n\thello");
    expect(head(editor)).toEqual({ row: 0, column: 1 });
    expect(vim.modeName).toBe("vim:insert");
  });

  it("the fallback o uses the current line's indent, not the following line's (nvim autoindent)", () => {
    const editor = new InMemoryVimEditor("  body\n}");
    const vim = new Vim(editor);

    runKeys(vim, ["o"]);

    expect(editor.getText()).toBe("  body\n  \n}");
    expect(head(editor)).toEqual({ row: 1, column: 2 });
  });
});
