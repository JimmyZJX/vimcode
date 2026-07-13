// Grapheme-cluster character cells for sequences where vimcode deliberately
// diverges from Neovim: nvim treats a regional-indicator pair (🇬🇧, four
// UTF-16 units) as TWO cells, but VSCode renders it as one glyph and a cursor
// parked between the indicators is invisible — vimcode follows the host and
// treats the whole cluster as one cell (see grapheme.ts; the nvim-agreeing
// cases é/😀 are pinned by the recorded test_multibyte fixture).
import { InMemoryVimEditor } from "./editor.js";
import { setGraphemeProvider } from "./grapheme.js";
import { selectionHead } from "./state.js";
import { Vim, runKeys } from "./vim.js";

const FLAG = "🇬🇧"; // two regional indicators, 4 UTF-16 units

function edit(text: string, keys: readonly string[]): { text: string; editor: InMemoryVimEditor; vim: Vim } {
  const editor = new InMemoryVimEditor(text);
  const vim = new Vim(editor);
  runKeys(vim, keys);
  return { text: editor.getText(), editor, vim };
}

function column(editor: InMemoryVimEditor): number {
  return selectionHead(editor.getSelections()[0]).column;
}

describe("flag emoji as one character cell (VSCode-faithful)", () => {
  it("l steps over the whole flag; h steps back onto it", () => {
    const result = edit(`${FLAG}abc`, ["l"]);
    expect(column(result.editor)).toBe(4);
    runKeys(result.vim, ["h"]);
    expect(column(result.editor)).toBe(0);
  });

  it("x deletes the whole flag into the register", () => {
    const result = edit(`${FLAG}abc`, ["x", "$", "p"]);
    expect(result.text).toBe(`abc${FLAG}`);
  });

  it("yl yanks the whole flag", () => {
    const result = edit(`${FLAG}abc`, ["y", "l", "$", "p"]);
    expect(result.text).toBe(`${FLAG}abc${FLAG}`);
  });

  it("visual v l d deletes the flag and the following character", () => {
    const result = edit(`a${FLAG}b`, ["l", "v", "l", "d"]);
    expect(result.text).toBe("a");
  });

  it("r replaces the whole flag with one character", () => {
    expect(edit(`${FLAG}abc`, ["r", "Z"]).text).toBe("Zabc");
  });

  it("$ lands on the flag's start when it is the last cell", () => {
    const result = edit(`ab${FLAG}`, ["$"]);
    expect(column(result.editor)).toBe(2);
  });

  it("dl deletes the whole flag", () => {
    const result = edit(`${FLAG}abc`, ["d", "l"]);
    expect(result.text).toBe("abc");
  });

  it("visual v r replaces the whole flag with one character", () => {
    // nvim writes one char per screen cell (two for a flag); one glyph is one
    // cell here. The nvim-agreeing v_r cases (😀, decomposed é) are pinned by
    // the recorded test_visual_replace_multibyte fixture.
    expect(edit(`${FLAG}abc`, ["v", "r", "x"]).text).toBe("xabc");
  });

  it("blockwise ctrl-v r replaces one emoji cell per row", () => {
    // Terminal nvim fills the block's *screen* width (😀 spans two terminal
    // cells → xx per row); vimcode's block is one glyph cell wide.
    expect(edit("😀ab\n😀cd", ["ctrl-v", "j", "r", "x"]).text).toBe("xab\nxcd");
  });

  it("blockwise ctrl-v d deletes whole emoji cells, never surrogate halves", () => {
    expect(edit("a😀b\na😀b", ["l", "ctrl-v", "j", "d"]).text).toBe("ab\nab");
  });

  it("yl p on a flag pastes after the whole flag cell", () => {
    // nvim treats the flag as two characters (yl would yank half of it);
    // vimcode's cell covers the whole cluster.
    expect(edit(`a${FLAG}b`, ["l", "y", "l", "p"]).text).toBe(`a${FLAG}${FLAG}b`);
  });
});

describe("grapheme provider seam", () => {
  it("an installed provider drives cell stepping and cluster snapping", () => {
    // A deliberately odd provider that treats every pair of code units as one
    // cell — if the host registers its own column mapping, motions, deletes,
    // and cursor snapping must all follow it.
    setGraphemeProvider({
      nextBoundary: (text, column) => Math.min(text.length, column + 2),
      previousBoundary: (_text, column) => Math.max(0, column - 2),
      clusterStart: (text, column) => (column >= text.length ? column : column - (column % 2)),
    });
    try {
      const editor = new InMemoryVimEditor("abcdef");
      const vim = new Vim(editor);
      runKeys(vim, ["l"]);
      expect(column(editor)).toBe(2);
      runKeys(vim, ["x"]);
      expect(editor.getText()).toBe("abef");
      runKeys(vim, ["$"]);
      expect(column(editor)).toBe(2);
    } finally {
      setGraphemeProvider(undefined);
    }
  });

  it("resetting restores the segmenter default", () => {
    const editor = new InMemoryVimEditor(`${FLAG}abc`);
    const vim = new Vim(editor);
    runKeys(vim, ["l"]);
    expect(column(editor)).toBe(4);
  });
});
