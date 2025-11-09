import { withEditor } from "../../testUtils.js";
import { emptyEnv } from "../common.js";
import { testChangeKeys } from "./change.js";

it("multiline paste cursor position", async () => {
  withEditor(
    __filename,
    "hello world\n",
    async (editor, writeState) => {
      const env = emptyEnv();
      const testKeys = (keys: string[]) => testChangeKeys(editor, keys, env);

      // Test 1: Paste after with 'p'
      // Start at position (0, 6) - after "hello "
      editor.selections = [{ anchor: { l: 0, c: 6 }, active: { l: 0, c: 6 } }];
      editor.cursor = { type: "block" };
      writeState("init - paste after test");

      // Manually set register content to multi-line text "abc\ndef"
      env.globalState.registers.registers['"'] = {
        type: "text",
        isFullLine: false,
        content: "abc\ndef",
      };

      // Paste after cursor with 'p'
      // Expected: text becomes "hello wabc\ndeforld"
      // Cursor should be at (1, 3) - at the 'f' in "def"
      await testKeys(["p"]);
      writeState("after paste with p");

      // Check cursor position for paste after
      let { active } = editor.selections[0];
      if (active.l !== 1 || active.c !== 3) {
        throw new Error(
          `Paste after: Expected cursor at (1, 3), but got (${active.l}, ${active.c})`
        );
      }

      // Test 2: Paste before with 'P'
      // Reset editor for second test
      const lastLine = editor.getLines() - 1;
      const lastLineLen = editor.getLineLength(lastLine);
      editor.editText(
        { anchor: { l: 0, c: 0 }, active: { l: lastLine, c: lastLineLen } },
        "hello world"
      );
      editor.selections = [{ anchor: { l: 0, c: 6 }, active: { l: 0, c: 6 } }];
      editor.cursor = { type: "block" };
      writeState("init - paste before test");

      // Manually set register content to multi-line text "xyz\n123"
      env.globalState.registers.registers['"'] = {
        type: "text",
        isFullLine: false,
        content: "xyz\n123",
      };

      // Paste before cursor with 'P'
      // Expected: text becomes "hello xyz\n123world"
      // Cursor should be at (1, 3) - at the '3' in "123"
      await testKeys(["P"]);
      writeState("after paste with P");

      // Check cursor position for paste before
      active = editor.selections[0].active;
      if (active.l !== 1 || active.c !== 3) {
        throw new Error(
          `Paste before: Expected cursor at (1, 3), but got (${active.l}, ${active.c})`
        );
      }
    }
  );
});
