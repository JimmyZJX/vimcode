// Regression tests for the operator pipeline (operator_target.ts):
// operatorTarget / lineOperatorTarget / textObjectOperatorTarget /
// applyOperatorToTarget. These pin behaviors that the Neovim fixture suite
// does not cover; expectations marked as such were verified against
// `nvim --headless` (v0.7). See doc/operator-redesign.md.

import { InMemoryVimEditor } from "./editor.js";
import { Vim, VimModelState, runKeys } from "./vim.js";
import { VimGlobalState } from "./vim_state.js";
import { selectionHead } from "./state.js";

function probe(text: string, keys: readonly string[]) {
  const editor = new InMemoryVimEditor(text);
  const globalState = new VimGlobalState();
  const vim = new Vim(editor, {}, globalState, new VimModelState());
  runKeys(vim, keys);
  return {
    text: editor.getText(),
    cursor: selectionHead(editor.getSelections()[0]),
    unnamed: globalState.registers.read(undefined),
  };
}

const text = "alpha\nbravo\ncharlie\ndelta";

test("yj yanks two lines linewise and keeps cursor", () => {
  const result = probe(text, ["j", "l", "y", "j"]);
  expect(result.text).toBe(text);
  expect(result.unnamed).toBe("bravo\ncharlie\n");
  expect(result.cursor).toEqual({ row: 1, column: 1 });
});

test("yk yanks two lines linewise and moves cursor up", () => {
  const result = probe(text, ["j", "j", "l", "y", "k"]);
  expect(result.unnamed).toBe("bravo\ncharlie\n");
  expect(result.cursor).toEqual({ row: 1, column: 1 });
});

test("yj on last line is a no-op", () => {
  const result = probe(text, ["G", "y", "j"]);
  expect(result.unnamed).toBe("");
  expect(result.cursor).toEqual({ row: 3, column: 0 });
});

test("dj deletes two lines linewise", () => {
  const result = probe(text, ["j", "l", "d", "j"]);
  expect(result.text).toBe("alpha\ndelta");
  expect(result.unnamed).toBe("bravo\ncharlie\n");
  expect(result.cursor).toEqual({ row: 1, column: 1 });
});

test("yG yanks linewise to the last line (was a silent no-op stub)", () => {
  const result = probe(text, ["j", "y", "G"]);
  expect(result.text).toBe(text);
  expect(result.unnamed).toBe("bravo\ncharlie\ndelta\n");
  expect(result.cursor).toEqual({ row: 1, column: 0 });
});

test("dG deletes linewise to the last line", () => {
  const result = probe(text, ["j", "d", "G"]);
  expect(result.text).toBe("alpha");
  expect(result.unnamed).toBe("bravo\ncharlie\ndelta\n");
});

test("2yy yanks two lines", () => {
  const result = probe(text, ["2", "y", "y"]);
  expect(result.unnamed).toBe("alpha\nbravo\n");
  expect(result.cursor).toEqual({ row: 0, column: 0 });
});

// Phase 4 probes: convert/indent through the central keymap grammar.
// Expectations verified against `nvim --headless` (v0.7).

test("gu3w lowercases three words (count after operator)", () => {
  const result = probe("AAA BBB CCC DDD", ["g", "u", "3", "w"]);
  expect(result.text).toBe("aaa bbb ccc DDD");
  expect(result.cursor).toEqual({ row: 0, column: 0 });
});

test("gufX lowercases through the find target", () => {
  const result = probe("AAA XBB CCC", ["g", "u", "f", "X"]);
  expect(result.text).toBe("aaa xBB CCC");
  expect(result.cursor).toEqual({ row: 0, column: 0 });
});

test("gub moves the cursor to the range start", () => {
  const result = probe("heLLO WORLD", ["8", "l", "g", "u", "b"]);
  expect(result.text).toBe("heLLO woRLD");
  expect(result.cursor).toEqual({ row: 0, column: 6 });
});

test("guu lowercases the line; gugu doubles with a count", () => {
  const doubled = probe("AAA\nBBB\nCCC", ["g", "u", "u"]);
  expect(doubled.text).toBe("aaa\nBBB\nCCC");
  const counted = probe("AAA\nBBB\nCCC", ["2", "g", "u", "g", "u"]);
  expect(counted.text).toBe("aaa\nbbb\nCCC");
});

test("guG lowercases linewise to the last line", () => {
  const result = probe("AAA\nBBB\nCCC", ["j", "g", "u", "G"]);
  expect(result.text).toBe("AAA\nbbb\nccc");
});

test("guiw lowercases the inner word object", () => {
  const result = probe("AAA BBB CCC", ["5", "l", "g", "u", "i", "w"]);
  expect(result.text).toBe("AAA bbb CCC");
  expect(result.cursor).toEqual({ row: 0, column: 4 });
});

test("guj converts linewise and keeps the cursor column", () => {
  const result = probe("AAA\nBBB\nCCC", ["l", "l", "g", "u", "j"]);
  expect(result.text).toBe("aaa\nbbb\nCCC");
  expect(result.cursor).toEqual({ row: 0, column: 2 });
});

test("g?? rot13s the line (doubling shadows backward search)", () => {
  const result = probe("abc\nxyz", ["g", "?", "?"]);
  expect(result.text).toBe("nop\nxyz");
});

test(">> and 3>> indent whole lines", () => {
  expect(probe("aaa\nbbb\nccc", [">", ">"]).text).toBe("    aaa\nbbb\nccc");
  expect(probe("aaa\nbbb\nccc\nddd", ["3", ">", ">"]).text).toBe("    aaa\n    bbb\n    ccc\nddd");
});

test(">j indents two lines; >j on the last line fails", () => {
  expect(probe("aaa\nbbb\nccc", [">", "j"]).text).toBe("    aaa\n    bbb\nccc");
  expect(probe("aaa\nbbb", ["G", ">", "j"]).text).toBe("aaa\nbbb");
});

test(">ip indents the paragraph object", () => {
  const result = probe("aaa\nbbb\n\nccc", [">", "i", "p"]);
  expect(result.text).toBe("    aaa\n    bbb\n\nccc");
});

// Phase 5 probes: ys captures its range through the keymap grammar.

test("ys2w) wraps two words (count after ys)", () => {
  // vim-surround trims the motion's trailing space out of the wrap.
  const result = probe("aaa bbb ccc", ["y", "s", "2", "w", ")"]);
  expect(result.text).toBe("(aaa bbb) ccc");
});

test("yss) wraps the trimmed line", () => {
  const result = probe("  aaa bbb", ["y", "s", "s", ")"]);
  expect(result.text).toBe("  (aaa bbb)");
});

// Vim 'shiftwidth' follows the host's resolved indent size, so `>>`/`v>`/`:>`
// all shift by the same amount as the editor's own indent commands (2-space
// OCaml files shift by 2, not a hardcoded 4).
test("indent commands use the editor's indent width", () => {
  const editor = new InMemoryVimEditor("aa\nbb");
  editor.configureIndentWidthForTest(2);
  const vim = new Vim(editor);
  runKeys(vim, [">", ">"]);
  expect(editor.getText()).toBe("  aa\nbb");
  runKeys(vim, ["j", "v", ">"]);
  expect(editor.getText()).toBe("  aa\n  bb");
  runKeys(vim, [":", ">", "enter"]);
  expect(editor.getText()).toBe("  aa\n    bb");
  runKeys(vim, ["<", "<"]);
  expect(editor.getText()).toBe("  aa\n  bb");
});

// vim-surround: charwise wraps strip trailing whitespace — the space stays
// outside the closing delimiter.
test("ysw) leaves the w motion's trailing space outside the wrap", () => {
  const result = probe("foo bar", ["y", "s", "w", ")"]);
  expect(result.text).toBe("(foo) bar");
});

test("ysaw) leaves the object's trailing space outside the wrap", () => {
  const result = probe("foo bar", ["y", "s", "a", "w", ")"]);
  expect(result.text).toBe("(foo) bar");
});

test("ysiw) still wraps the inner word", () => {
  const result = probe("aaa bbb ccc", ["5", "l", "y", "s", "i", "w", ")"]);
  expect(result.text).toBe("aaa (bbb) ccc");
});

// Phase 6 probes: visual operators fold into the shared apply modules.

test("Vc preserves indentation like cc (nvim with autoindent)", () => {
  const visual = probe("    foo bar\nbaz", ["V", "c", "X"]);
  const normal = probe("    foo bar\nbaz", ["c", "c", "X"]);
  expect(visual.text).toBe("    X\nbaz");
  expect(visual.text).toBe(normal.text);
});

test("Vjy yanks linewise and parks the cursor at the start", () => {
  const result = probe("aaa\nbbb\nccc", ["j", "l", "V", "j", "y"]);
  expect(result.unnamed).toBe("bbb\nccc\n");
  expect(result.cursor).toEqual({ row: 1, column: 0 });
});

test("vU uppercases the inclusive selection and moves to its start", () => {
  const result = probe("aaa bbb", ["l", "v", "2", "l", "U"]);
  expect(result.text).toBe("aAA bbb");
  expect(result.cursor).toEqual({ row: 0, column: 1 });
});

test("cj changes two lines and enters insert", () => {
  const editor = new InMemoryVimEditor(text);
  const globalState = new VimGlobalState();
  const vim = new Vim(editor, {}, globalState, new VimModelState());
  runKeys(vim, ["j", "c", "j", "x"]);
  expect(editor.getText()).toBe("alpha\nx\ndelta");
  expect(globalState.registers.read(undefined)).toBe("bravo\ncharlie\n");
});
