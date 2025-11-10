import { withEditor } from "../testUtils.js";
import { emptyEnv } from "./common.js";
import { Vim } from "./vim.js";

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

it("visual demonstrations: comprehensive register operations", async () => {
  await withEditor(__filename, "foo bar baz\n", async (editor, writeState) => {
    const env = emptyEnv();
    let vim = new Vim(editor, env);

    // === Demo 1: Yank to register and paste ===
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("DEMO 1: Yank and paste - initial");

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

    // === Demo 2: Delete to register vs default register ===
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    vim.onKey("d");
    vim.onKey("G");
    editor.editText({ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }, "first second third\n");
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

    // Verify registers are isolated
    let regA = env.globalState.registers.registers["a"];
    let regDefault = env.globalState.registers.registers['"'];
    expect(regA?.type).toBe("text");
    expect(regDefault?.type).toBe("text");
    if (regA?.type === "text") expect(regA.content).toBe("first ");
    if (regDefault?.type === "text") expect(regDefault.content).toBe("second ");

    // === Demo 3: Visual mode delete to register ===
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    vim.onKey("d");
    vim.onKey("G");
    editor.editText({ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }, "ABCDEFGHIJ\n");
    vim = new Vim(editor, env);
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("DEMO 3: Visual mode delete - initial");

    // Visual select and delete to register 'z'
    vim.onKey("v");
    vim.onKey("l");
    vim.onKey("l");
    writeState("after vll - selected ABC");

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
    regDefault = env.globalState.registers.registers['"'];
    expect(regZ?.type).toBe("text");
    expect(regDefault?.type).toBe("text");
    if (regZ?.type === "text") expect(regZ.content).toBe("ABC");
    if (regDefault?.type === "text") expect(regDefault.content).toBe("DEF");

    // === Demo 4: Paste before from named register ===
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    vim.onKey("d");
    vim.onKey("G");
    editor.editText({ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }, "alpha beta gamma\n");
    vim = new Vim(editor, env);
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("DEMO 4: Paste before - initial");

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

    // === Demo 5: Multiple registers - yank, paste from different registers ===
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    vim.onKey("d");
    vim.onKey("G");
    editor.editText({ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }, "X Y Z\n");
    vim = new Vim(editor, env);
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("DEMO 5: Multiple registers - initial");

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

    // Paste from register 'x' again to show reusability
    vim.onKey('"');
    vim.onKey("x");
    vim.onKey("p");
    await new Promise(resolve => setTimeout(resolve, 10));
    writeState("after \"xp - pasted 'X ' again");

    // === Demo 6: Full line operations (yank and paste) ===
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    vim.onKey("d");
    vim.onKey("G");
    editor.editText({ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }, "AAA\nBBB\nCCC\n");
    vim = new Vim(editor, env);
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("DEMO 6: Full line operations - initial");

    // Yank first line to register 'a'
    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("y");
    vim.onKey("y");
    writeState("after \"ayy - yanked line AAA to register a");

    // Move to second line and paste after
    vim.onKey("j");
    writeState("on line BBB");

    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("p");
    await new Promise(resolve => setTimeout(resolve, 10));
    writeState("after \"ap - pasted line after BBB");

    // Move to last line and paste before
    vim.onKey("G");
    writeState("on last line CCC");

    vim.onKey('"');
    vim.onKey("a");
    vim.onKey("P");
    await new Promise(resolve => setTimeout(resolve, 10));
    writeState("after \"aP - pasted line before CCC");
  });
});
