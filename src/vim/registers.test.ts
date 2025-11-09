import { withEditor } from "../testUtils.js";
import { emptyEnv } from "./common.js";
import { Vim } from "./vim.js";

it("register selection - basic yank to named register", () => {
  withEditor(__filename, "line1\nline2\nline3\n", (editor, writeState) => {
    const env = emptyEnv();
    const vim = new Vim(editor, env);

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("init");

    // Yank line to register 'a': "ayy
    vim.onKey('"');
    expect(vim.mode).toBe("normal+"); // Pending register selection
    vim.onKey("a");
    expect(vim.mode).toBe("normal"); // Back to normal after selecting register
    vim.onKey("y");
    expect(vim.mode).toBe("normal+"); // Pending motion
    vim.onKey("y");
    expect(vim.mode).toBe("normal"); // Operation complete

    // Check that register 'a' has the yanked content
    const regA = env.globalState.registers.registers["a"];
    expect(regA).toEqual({
      type: "text",
      isFullLine: true,
      content: "line1",
    });

    writeState("after 'a yy");

    // Next yank should use default register, not 'a'
    editor.selections = [{ anchor: { l: 1, c: 0 }, active: { l: 1, c: 0 } }];
    vim.onKey("y");
    vim.onKey("y");

    // Register 'a' should still have "line1"
    const regAAfter = env.globalState.registers.registers["a"];
    expect(regAAfter).toEqual({
      type: "text",
      isFullLine: true,
      content: "line1",
    });

    // Default register should have "line2"
    const regDefault = env.globalState.registers.registers['"'];
    expect(regDefault).toEqual({
      type: "text",
      isFullLine: true,
      content: "line2",
    });

    writeState("after yy (default register)");
  });
});

it("register selection - delete with motion", () => {
  withEditor(__filename, "hello world test\n", (editor, writeState) => {
    const env = emptyEnv();
    const vim = new Vim(editor, env);

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("init");

    // Delete word to register 'b': "bdw
    vim.onKey('"');
    vim.onKey("b");
    vim.onKey("d");
    expect(vim.mode).toBe("normal+"); // Pending motion
    vim.onKey("w");
    expect(vim.mode).toBe("normal"); // Operation complete

    writeState("after 'b dw");

    // Check that register 'b' has the deleted content
    const regB = env.globalState.registers.registers["b"];
    expect(regB).toEqual({
      type: "text",
      isFullLine: false,
      content: "hello ",
    });

    // Editor should have "world test" remaining
    expect(editor.getLine(0)).toBe("world test");
  });
});

it("register selection - visual mode delete", () => {
  withEditor(__filename, "abcdef\n", (editor, writeState) => {
    const env = emptyEnv();
    const vim = new Vim(editor, env);

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("init");

    // Enter visual mode and select 3 characters
    vim.onKey("v");
    vim.onKey("l");
    vim.onKey("l");
    writeState("after vll (visual)");

    // Delete to register 'c': "cd
    vim.onKey('"');
    expect(vim.mode).toBe("visual+"); // Pending register selection in visual
    vim.onKey("c");
    expect(vim.mode).toBe("visual"); // Back to visual after selecting register
    vim.onKey("d");
    expect(vim.mode).toBe("normal"); // Back to normal after delete

    writeState("after 'c d");

    // Check that register 'c' has the deleted content
    const regC = env.globalState.registers.registers["c"];
    expect(regC).toEqual({
      type: "text",
      isFullLine: false,
      content: "abc",
    });

    // Editor should have "def" remaining
    expect(editor.getLine(0)).toBe("def");
  });
});

it("register cleared after operation completes", () => {
  withEditor(__filename, "first second\n", (editor, writeState) => {
    const env = emptyEnv();
    const vim = new Vim(editor, env);

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];

    // Set register 'x' and yank first word
    vim.onKey('"');
    vim.onKey("x");
    vim.onKey("y");
    vim.onKey("w");

    // Check register is cleared after operation
    expect(env.globalState.registers.currentRegName).toBeUndefined();

    // Move to second word
    vim.onKey("w");

    // Next delete should use default register and delete second word
    vim.onKey("d");
    vim.onKey("w");

    const regDefault = env.globalState.registers.registers['"'];
    expect(regDefault).toBeDefined();
    expect(regDefault?.type).toBe("text");
    if (regDefault?.type === "text") {
      expect(regDefault.content).toBe("second");
    }

    const regX = env.globalState.registers.registers["x"];
    expect(regX).toBeDefined();
    expect(regX?.type === "text");
    if (regX?.type === "text") {
      expect(regX.content).toBe("first ");
    }
  });
});

it("multiple different register operations", () => {
  withEditor(__filename, "aaa\nbbb\nccc\n", (editor, writeState) => {
    const env = emptyEnv();
    const vim = new Vim(editor, env);

    // Yank line to register 'a'
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("y");
    vim.onKey("y");

    // Yank line to register 'b'
    editor.selections = [{ anchor: { l: 1, c: 0 }, active: { l: 1, c: 0 } }];
    vim.onKey('"');
    vim.onKey("b");
    vim.onKey("y");
    vim.onKey("y");

    // Verify both registers have different content
    const regA = env.globalState.registers.registers["a"];
    const regB = env.globalState.registers.registers["b"];

    expect(regA).toEqual({
      type: "text",
      isFullLine: true,
      content: "aaa",
    });

    expect(regB).toEqual({
      type: "text",
      isFullLine: true,
      content: "bbb",
    });

    writeState("after yanking to a and b");
  });
});

it("register cleared by motion - should not affect subsequent operation", () => {
  withEditor(__filename, "one two three\n", (editor, writeState) => {
    const env = emptyEnv();
    const vim = new Vim(editor, env);

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("init");

    // Select register 'a'
    vim.onKey('"');
    vim.onKey("a");

    // Move forward with motions (should clear register)
    vim.onKey("w");
    vim.onKey("w");

    writeState("after 'a ww (register cleared by motion)");

    // Register should be cleared now
    expect(env.globalState.registers.currentRegName).toBeUndefined();

    // Delete word - should use default register, not 'a'
    vim.onKey("d");
    vim.onKey("w");

    writeState("after dw (uses default register)");

    // Check that default register has the deleted content
    const regDefault = env.globalState.registers.registers['"'];
    expect(regDefault).toBeDefined();
    if (regDefault?.type === "text") {
      expect(regDefault.content).toBe("three");
    }

    // Register 'a' should be undefined (never used)
    const regA = env.globalState.registers.registers["a"];
    expect(regA).toBeUndefined();
  });
});

it("paste from named register - basic", async () => {
  await withEditor(__filename, "hello world\n", async (editor, writeState) => {
    const env = emptyEnv();
    const vim = new Vim(editor, env);

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("init");

    // Yank word to register 'a': "ayw
    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("y");
    vim.onKey("w");
    writeState("after \"ayw - yanked 'hello ' to register a");

    // Move to end of line
    vim.onKey("$");
    writeState("after $ - at end of line");

    // Paste from register 'a': "ap
    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("p");
    // Wait for async paste operation to complete
    await new Promise(resolve => setTimeout(resolve, 10));
    writeState("after \"ap - pasted 'hello ' from register a");

    expect(editor.getLine(0)).toBe("hello worldhello ");
  });
});

it("paste before from named register", async () => {
  await withEditor(__filename, "one two three\n", async (editor, writeState) => {
    const env = emptyEnv();
    const vim = new Vim(editor, env);

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("init");

    // Yank first word to register 'x'
    vim.onKey('"');
    vim.onKey("x");
    vim.onKey("y");
    vim.onKey("w");
    writeState("after \"xyw - yanked 'one ' to register x");

    // Move to 'three'
    vim.onKey("w");
    vim.onKey("w");
    writeState("after ww - at 'three'");

    // Paste before from register 'x': "xP
    vim.onKey('"');
    vim.onKey("x");
    vim.onKey("P");
    // Wait for async paste operation to complete
    await new Promise(resolve => setTimeout(resolve, 10));
    writeState("after \"xP - pasted 'one ' before cursor");

    expect(editor.getLine(0)).toBe("one two one three");
  });
});

it("paste from multiple different registers", async () => {
  await withEditor(__filename, "A B C\n", async (editor, writeState) => {
    const env = emptyEnv();
    const vim = new Vim(editor, env);

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("init");

    // Yank 'A ' to register 'a'
    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("y");
    vim.onKey("w");
    writeState("after \"ayw - yanked 'A ' to register a");

    // Move to 'B'
    vim.onKey("w");
    writeState("after w - moved to 'B'");

    // Yank 'B ' to register 'b'
    vim.onKey('"');
    vim.onKey("b");
    vim.onKey("y");
    vim.onKey("w");
    writeState("after \"byw - yanked 'B ' to register b");

    // Move to end
    vim.onKey("$");
    writeState("after $ - at end");

    // Paste from register 'a'
    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("p");
    await new Promise(resolve => setTimeout(resolve, 50));
    writeState("after \"ap - pasted from register a");

    // Paste from register 'b'
    vim.onKey('"');
    vim.onKey("b");
    vim.onKey("p");
    await new Promise(resolve => setTimeout(resolve, 50));
    writeState("after \"bp - pasted from register b");

    expect(editor.getLine(0)).toBe("A B CA B ");
  });
});

it("paste full line from register", async () => {
  await withEditor(__filename, "line1\nline2\nline3\n", async (editor, writeState) => {
    const env = emptyEnv();
    const vim = new Vim(editor, env);

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("init");

    // Yank full line to register 'a': "ayy
    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("y");
    vim.onKey("y");
    writeState("after \"ayy - yanked 'line1' to register a");

    // Move to line2
    vim.onKey("j");
    writeState("after j - on line2");

    // Paste line from register 'a': "ap
    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("p");
    await new Promise(resolve => setTimeout(resolve, 10));
    writeState("after \"ap - pasted full line from register a");

    expect(editor.getLine(0)).toBe("line1");
    expect(editor.getLine(1)).toBe("line2");
    expect(editor.getLine(2)).toBe("line1");
    expect(editor.getLine(3)).toBe("line3");
  });
});

it("visual demonstrations: register operations and isolation", () => {
  withEditor(__filename, "apple banana cherry\n", (editor, writeState) => {
    const env = emptyEnv();
    let vim = new Vim(editor, env);

    // === Demo 1: Yank to different registers ===
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("DEMO 1: Yank to multiple registers - initial");

    // Yank first word to register 'x'
    vim.onKey('"');
    vim.onKey("x");
    vim.onKey("y");
    vim.onKey("w");
    writeState("after \"xyw - yanked 'apple ' to register x");

    // Move to second word and yank to register 'y'
    vim.onKey("w");
    vim.onKey('"');
    vim.onKey("y");
    vim.onKey("y");
    vim.onKey("w");
    writeState("after \"yyw - yanked 'banana ' to register y");

    // Verify both registers are isolated
    let regX = env.globalState.registers.registers["x"];
    let regY = env.globalState.registers.registers["y"];
    expect(regX?.type).toBe("text");
    expect(regY?.type).toBe("text");
    if (regX?.type === "text") expect(regX.content).toBe("apple ");
    if (regY?.type === "text") expect(regY.content).toBe("banana ");

    // === Demo 2: Delete to register vs default register ===
    // Create new editor content by deleting all and inserting new text
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    vim.onKey("d");
    vim.onKey("G"); // Delete to end
    editor.editText({ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }, "first second third fourth\n");
    vim = new Vim(editor, env);
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("DEMO 2: Delete to register - initial");

    // Delete to register 'a'
    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("d");
    vim.onKey("w");
    writeState("after \"adw - deleted 'first ' to register a");

    // Delete to default register
    vim.onKey("d");
    vim.onKey("w");
    writeState("after dw - deleted 'second ' to default register");

    // Verify register isolation
    let regA = env.globalState.registers.registers["a"];
    let regDefault1 = env.globalState.registers.registers['"'];
    expect(regA?.type).toBe("text");
    expect(regDefault1?.type).toBe("text");
    if (regA?.type === "text") expect(regA.content).toBe("first ");
    if (regDefault1?.type === "text") expect(regDefault1.content).toBe("second ");
    expect(editor.getLine(0)).toBe("third fourth");

    // === Demo 3: Visual mode delete to register ===
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    vim.onKey("d");
    vim.onKey("G");
    editor.editText({ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }, "ABCDEFGHIJ\n");
    vim = new Vim(editor, env);
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("DEMO 3: Visual mode - initial");

    // Visual select and delete to register
    vim.onKey("v");
    vim.onKey("l");
    vim.onKey("l");
    writeState("selected 3 chars (ABC)");

    vim.onKey('"');
    vim.onKey("z");
    vim.onKey("d");
    writeState("after \"zd - deleted to register z");

    // Visual delete to default register
    vim.onKey("v");
    vim.onKey("l");
    vim.onKey("l");
    vim.onKey("d");
    writeState("after vld - deleted to default register");

    // Verify register 'z' still has original content
    let regZ = env.globalState.registers.registers["z"];
    let regDefault2 = env.globalState.registers.registers['"'];
    expect(regZ?.type).toBe("text");
    expect(regDefault2?.type).toBe("text");
    if (regZ?.type === "text") expect(regZ.content).toBe("ABC");
    if (regDefault2?.type === "text") expect(regDefault2.content).toBe("DEF");

    // === Demo 4: Multi-operation with many registers ===
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    vim.onKey("d");
    vim.onKey("G");
    editor.editText({ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }, "line1\nline2\nline3\nline4\n");
    vim = new Vim(editor, env);
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("DEMO 4: Multiple registers - initial");

    // Yank lines to different registers
    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("y");
    vim.onKey("y");
    writeState("after \"ayy - yanked line1 to register a");

    vim.onKey("j");
    vim.onKey('"');
    vim.onKey("b");
    vim.onKey("y");
    vim.onKey("y");
    writeState("after \"byy - yanked line2 to register b");

    vim.onKey("j");
    vim.onKey('"');
    vim.onKey("c");
    vim.onKey("d");
    vim.onKey("d");
    writeState("after \"cdd - deleted line3 to register c");

    vim.onKey("d");
    vim.onKey("d");
    writeState("after dd - deleted line4 to default register");

    // Verify all 4 registers have unique content
    regA = env.globalState.registers.registers["a"];
    let regB = env.globalState.registers.registers["b"];
    let regC = env.globalState.registers.registers["c"];
    let regDefault = env.globalState.registers.registers['"'];

    expect(regA?.type).toBe("text");
    expect(regB?.type).toBe("text");
    expect(regC?.type).toBe("text");
    expect(regDefault?.type).toBe("text");

    if (regA?.type === "text") expect(regA.content).toBe("line1");
    if (regB?.type === "text") expect(regB.content).toBe("line2");
    if (regC?.type === "text") expect(regC.content).toBe("line3");
    if (regDefault?.type === "text") expect(regDefault.content).toBe("line4");

    writeState("final - all 4 registers verified");
  });
});

it("visual demonstrations: paste from registers", async () => {
  await withEditor(__filename, "foo bar baz\n", async (editor, writeState) => {
    const env = emptyEnv();
    let vim = new Vim(editor, env);

    // === Demo 1: Paste after from named register ===
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("DEMO 1: Paste after - initial");

    // Yank 'foo ' to register 'f'
    vim.onKey('"');
    vim.onKey("f");
    vim.onKey("y");
    vim.onKey("w");
    writeState("after \"fyw - yanked 'foo ' to register f");

    // Move to end and paste
    vim.onKey("$");
    writeState("at end of line");

    vim.onKey('"');
    vim.onKey("f");
    vim.onKey("p");
    await new Promise(resolve => setTimeout(resolve, 10));
    writeState("after \"fp - pasted 'foo ' after cursor");

    // === Demo 2: Paste before from named register ===
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    vim.onKey("d");
    vim.onKey("G");
    editor.editText({ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }, "alpha beta gamma\n");
    vim = new Vim(editor, env);
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("DEMO 2: Paste before - initial");

    // Yank 'alpha ' to register 'a'
    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("y");
    vim.onKey("w");
    writeState("after \"ayw - yanked 'alpha ' to register a");

    // Move to 'gamma' and paste before
    vim.onKey("w");
    vim.onKey("w");
    writeState("at 'gamma'");

    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("P");
    await new Promise(resolve => setTimeout(resolve, 10));
    writeState("after \"aP - pasted 'alpha ' before cursor");

    // === Demo 3: Paste from multiple registers ===
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    vim.onKey("d");
    vim.onKey("G");
    editor.editText({ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }, "X Y Z\n");
    vim = new Vim(editor, env);
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("DEMO 3: Multiple paste - initial");

    // Yank 'X ' to register 'x'
    vim.onKey('"');
    vim.onKey("x");
    vim.onKey("y");
    vim.onKey("w");
    writeState("after \"xyw - yanked 'X ' to register x");

    // Yank 'Y ' to register 'y'
    vim.onKey('"');
    vim.onKey("y");
    vim.onKey("y");
    vim.onKey("w");
    writeState("after \"yyw - yanked 'Y ' to register y");

    // Move to end
    vim.onKey("$");
    writeState("at end of line");

    // Paste from register 'x'
    vim.onKey('"');
    vim.onKey("x");
    vim.onKey("p");
    await new Promise(resolve => setTimeout(resolve, 10));
    writeState("after \"xp - pasted 'X '");

    // Paste from register 'y'
    vim.onKey('"');
    vim.onKey("y");
    vim.onKey("p");
    await new Promise(resolve => setTimeout(resolve, 10));
    writeState("after \"yp - pasted 'Y '");

    // Paste from register 'x' again
    vim.onKey('"');
    vim.onKey("x");
    vim.onKey("p");
    await new Promise(resolve => setTimeout(resolve, 10));
    writeState("after \"xp - pasted 'X ' again");

    // === Demo 4: Paste full lines ===
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    vim.onKey("d");
    vim.onKey("G");
    editor.editText({ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }, "AAA\nBBB\nCCC\n");
    vim = new Vim(editor, env);
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("DEMO 4: Paste full lines - initial");

    // Yank first line to register 'a'
    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("y");
    vim.onKey("y");
    writeState("after \"ayy - yanked line AAA");

    // Move to second line
    vim.onKey("j");
    writeState("on line BBB");

    // Paste line from register 'a'
    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("p");
    await new Promise(resolve => setTimeout(resolve, 10));
    writeState("after \"ap - pasted line after BBB");

    // Move to last line
    vim.onKey("G");
    writeState("on last line");

    // Paste before
    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("P");
    await new Promise(resolve => setTimeout(resolve, 10));
    writeState("after \"aP - pasted line before CCC");
  });
});
