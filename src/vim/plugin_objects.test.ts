// Plugin text objects (VSCodeVim compat): vim-indent-object (`ii`/`ai`/`aI`),
// targets.vim-style arguments (`ia`/`aa`), vim-textobj-entire (`ie`/`ae`).
// These are plugin emulations with no nvim --clean counterpart, so the
// documented plugin semantics are pinned here directly.
import { InMemoryVimEditor } from "./editor.js";
import { Vim, runKeys } from "./vim.js";

function edit(text: string, keys: readonly string[]): { text: string; mode: string; editor: InMemoryVimEditor; vim: Vim } {
  const editor = new InMemoryVimEditor(text);
  const vim = new Vim(editor);
  runKeys(vim, keys);
  return { text: editor.getText(), mode: vim.modeName, editor, vim };
}

const PY = [
  "def f():",      // 0
  "    a = 1",     // 1
  "",              // 2
  "    if b:",     // 3
  "        c()",   // 4
  "    d = 2",     // 5
  "after",         // 6
].join("\n");

describe("indent objects ii/ai/aI", () => {
  it("dii deletes the indentation block, blanks bridging, edges trimmed", () => {
    const result = edit(PY, ["j", "d", "i", "i"]);
    expect(result.text).toBe("def f():\nafter");
  });

  it("deeper-indented lines belong to the block", () => {
    // Cursor on "c()" (deeper): block is just that line.
    const result = edit(PY, ["4", "j", "d", "i", "i"]);
    expect(result.text.split("\n")[4]).toBe("    d = 2");
  });

  it("dai includes the header line above", () => {
    const result = edit(PY, ["j", "d", "a", "i"]);
    expect(result.text).toBe("after");
  });

  it("daI includes the lines above and below", () => {
    const body = ["head", "  a", "  b", "tail", "rest"].join("\n");
    const result = edit(body, ["j", "d", "a", "I"]);
    expect(result.text).toBe("rest");
  });

  it("a blank cursor line uses the nearest non-blank below as reference", () => {
    const result = edit(PY, ["2", "j", "d", "i", "i"]);
    expect(result.text).toBe("def f():\nafter");
  });

  it("cii is a linewise change (opens an indented replacement line)", () => {
    const result = edit(PY, ["j", "c", "i", "i"]);
    expect(result.mode).toBe("vim:insert");
    // Linewise change keeps the block's indentation (autoindent-style `cc`).
    expect(result.text).toBe("def f():\n    \nafter");
  });

  it("vii selects the block linewise", () => {
    const result = edit(PY, ["j", "v", "i", "i"]);
    expect(result.mode).toBe("vim:visualLine");
    runKeys(result.vim, ["d"]);
    expect(result.editor.getText()).toBe("def f():\nafter");
  });
});

describe("argument objects ia/aa", () => {
  it("cia changes the argument under the cursor, preserving separators", () => {
    const result = edit("call(one, two, three)", ["f", "t", "c", "i", "a", "X", "escape"]);
    expect(result.text).toBe("call(one, X, three)");
  });

  it("daa on a middle argument removes the trailing separator and space", () => {
    expect(edit("call(one, two, three)", ["f", "t", "d", "a", "a"]).text).toBe("call(one, three)");
  });

  it("daa on the first argument removes the trailing separator", () => {
    expect(edit("call(one, two)", ["f", "o", "d", "a", "a"]).text).toBe("call(two)");
  });

  it("daa on the last argument removes the leading separator", () => {
    expect(edit("call(one, two)", ["f", "t", "d", "a", "a"]).text).toBe("call(one)");
  });

  it("nested brackets and quoted separators do not split arguments", () => {
    expect(edit("f(g(a, b), 'x,y', last)", ["f", "'", "d", "a", "a"]).text).toBe("f(g(a, b), last)");
    expect(edit("f(g(a, b), tail)", ["f", "g", "d", "i", "a"]).text).toBe("f(, tail)");
  });

  it("works in square-bracket lists", () => {
    expect(edit("xs[alpha, beta]", ["f", "b", "d", "a", "a"]).text).toBe("xs[alpha]");
  });

  it("aa with a single argument deletes just the argument", () => {
    expect(edit("call(only)", ["f", "o", "d", "a", "a"]).text).toBe("call()");
  });

  it("cia outside any list fails without entering insert", () => {
    const result = edit("no brackets here", ["c", "i", "a"]);
    expect(result.mode).toBe("vim:normal");
    expect(result.text).toBe("no brackets here");
  });
});

describe("entire-buffer objects ie/ae", () => {
  const BODY = "\n\nfirst\nsecond\n\n";

  it("dae deletes the whole buffer", () => {
    expect(edit(BODY, ["d", "a", "e"]).text).toBe("");
  });

  it("die keeps the leading/trailing blank lines", () => {
    expect(edit(BODY, ["d", "i", "e"]).text).toBe("\n\n\n");
  });

  it("yie then paste duplicates the trimmed content", () => {
    const result = edit(BODY, ["y", "i", "e", "G", "p"]);
    expect(result.text).toBe("\n\nfirst\nsecond\n\n\nfirst\nsecond");
  });

  it("gUae uppercases everything", () => {
    expect(edit("one\ntwo", ["g", "U", "a", "e"]).text).toBe("ONE\nTWO");
  });
});
