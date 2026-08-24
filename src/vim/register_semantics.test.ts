import { InMemoryVimEditor } from "./editor.js";
import { Registers } from "./registers.js";
import { MacroState, RepeatState } from "./normal/repeat.js";
import { charwiseSelection } from "./state.js";
import { Vim, VimGlobalState, runKeys } from "./vim.js";

describe("register semantics", () => {
  it("cleans up replay state after synchronous exceptions", () => {
    const repeat = new RepeatState();
    repeat.beginRecording("normal");
    repeat.recordKey("x");
    repeat.maybeFinish({ mode: "normal", isPending: false });
    expect(() => repeat.replay(undefined, {
      runKey: () => {
        throw new Error("repeat failed");
      },
      runVisualAction: () => {},
    })).toThrow("repeat failed");
    expect(repeat.isReplaying()).toBe(false);

    const macro = new MacroState();
    macro.startRecording("a");
    macro.recordKey("x");
    macro.stopRecording();
    expect(() => macro.replayRegisterKey("a", 1, () => {
      throw new Error("macro failed");
    }, () => {})).toThrow("macro failed");
    expect(macro.isReplaying()).toBe(false);
  });

  it("preserves registers for failed yanks and no-op deletes", () => {
    const globalState = new VimGlobalState();
    globalState.registers.write("a", "KEEP");
    const editor = new InMemoryVimEditor("abc");
    const vim = new Vim(editor, {}, globalState);

    runKeys(vim, ["\"", "a", "y", "i", "("]);
    expect(vim.readRegister("a")).toBe("KEEP");

    const emptyEditor = new InMemoryVimEditor("");
    const emptyVim = new Vim(emptyEditor, {}, globalState);
    runKeys(emptyVim, ["x"]);
    expect(emptyVim.readRegister("a")).toBe("KEEP");
  });

  it("rotates line deletes even with named and explicit unnamed destinations", () => {
    const namedEditor = new InMemoryVimEditor("one\ntwo");
    const namedVim = new Vim(namedEditor);
    runKeys(namedVim, ["\"", "a", "d", "d"]);
    expect(namedVim.readRegister("a")).toBe("one\n");
    expect(namedVim.readRegister("1")).toBe("one\n");

    const unnamedEditor = new InMemoryVimEditor("one\ntwo");
    const unnamedVim = new Vim(unnamedEditor);
    runKeys(unnamedVim, ["\"", "\"", "d", "d"]);
    expect(unnamedVim.readRegister("0")).toBe("one\n");
    expect(unnamedVim.readRegister("1")).toBe("one\n");
  });

  it("clears stale numbered slots during sparse rotation", () => {
    const registers = new Registers();
    registers.writeYank("9", "stale");
    registers.writeDelete(undefined, "line\n", "linewise");

    expect(registers.read("1")).toBe("line\n");
    expect(registers.read("9")).toBe("");
  });

  it("uses delete-register semantics for visual p while visual P preserves the source", () => {
    const pEditor = new InMemoryVimEditor("one two");
    const pVim = new Vim(pEditor);
    runKeys(pVim, ["\"", "a", "y", "i", "w", "w", "v", "i", "w", "\"", "a", "p"]);
    expect(pEditor.getText()).toBe("one one");
    expect(pVim.readRegister("a")).toBe("one");
    expect(pVim.readRegister(undefined)).toBe("two");

    const bigPEditor = new InMemoryVimEditor("one two");
    const bigPVim = new Vim(bigPEditor);
    runKeys(bigPVim, ["y", "i", "w", "w", "v", "i", "w", "P"]);
    expect(bigPEditor.getText()).toBe("one one");
    expect(bigPVim.readRegister(undefined)).toBe("one");
    expect(bigPVim.readRegister("-")).toBe("two");
  });

  it("preserves multicursor parts when appending uppercase named registers", () => {
    const editor = new InMemoryVimEditor("one two\nred blue\nAAA BBB\nCCC DDD");
    editor.setSelections([
      charwiseSelection({ row: 0, column: 0 }),
      charwiseSelection({ row: 1, column: 0 }),
    ]);
    const vim = new Vim(editor, { replaceWithRegister: true });

    runKeys(vim, ["\"", "a", "y", "i", "w", "w", "\"", "A", "y", "i", "w"]);
    expect(vim.readRegister("a")).toBe("onetwo\nredblue");
    editor.setSelections([
      charwiseSelection({ row: 2, column: 0 }),
      charwiseSelection({ row: 3, column: 0 }),
    ]);
    runKeys(vim, ["\"", "a", "g", "r", "i", "w"]);

    expect(editor.getText()).toBe("one two\nred blue\nonetwo BBB\nredblue DDD");
  });
});

describe("delete-history register routing (Neovim-verified)", () => {
  function probe(keys: readonly string[], regs: readonly ("\"" | "-" | "0" | "1" | "a")[]): Record<string, string> {
    const globalState = new VimGlobalState();
    for (const r of ["-", "0", "1", "a"] as const) globalState.registers.write(r, "INIT");
    const editor = new InMemoryVimEditor("alpha one\nbravo two");
    const vim = new Vim(editor, {}, globalState);
    runKeys(vim, keys);
    const out: Record<string, string> = {};
    for (const r of regs) out[r] = vim.readRegister(r);
    return out;
  }

  it("an unspecified-register small delete writes \"-", () => {
    expect(probe(["d", "w"], ["-", "1"])).toEqual({ "-": "alpha ", "1": "INIT" });
  });

  it("explicit-register small deletes leave \"- untouched", () => {
    // :h quote-: `"-` is written "except when the command specifies a register".
    expect(probe(["\"", "a", "d", "w"], ["-", "1", "a"]))
      .toEqual({ "-": "INIT", "1": "INIT", "a": "alpha " });
    expect(probe(["\"", "a", "x"], ["-", "a"])).toEqual({ "-": "INIT", "a": "a" });
    // Explicit `""` counts as a specified register for `"-` but also fills `"0`.
    expect(probe(["\"", "\"", "d", "w"], ["-", "0", "1"]))
      .toEqual({ "-": "INIT", "0": "alpha ", "1": "INIT" });
  });

  it("named-register line deletes still rotate into \"1", () => {
    // :h quote1: the rotation happens even when the delete names a register.
    expect(probe(["\"", "a", "d", "d"], ["-", "1", "a"]))
      .toEqual({ "-": "INIT", "1": "alpha one\n", "a": "alpha one\n" });
  });

  it("visual put with a named register still records the replaced text in \"-", () => {
    const globalState = new VimGlobalState();
    globalState.registers.write("a", "foo");
    globalState.registers.write("-", "INIT");
    const editor = new InMemoryVimEditor("alpha one\nbravo two");
    const vim = new Vim(editor, {}, globalState);
    runKeys(vim, ["v", "i", "w", "\"", "a", "p"]);
    expect(editor.line(0)).toBe("foo one");
    expect(vim.readRegister("-")).toBe("alpha");
    expect(vim.readRegister("a")).toBe("foo");
  });
});
