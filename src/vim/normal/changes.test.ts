import { Editor } from "../../editorInterface.js";
import { withEditor } from "../../testUtils.js";
import { emptyEnv, Env, testKeys } from "../common.js";
import { fixNormalCursor } from "../modeUtil.js";
import { changes } from "./change.js";

export function testChangeKeys(
  editor: Editor,
  keys: string[],
  env?: Env
): void {
  testKeys({
    editor,
    keys,
    chords: { type: "impl", impl: { type: "keys", keys: changes } },
    getInput: () => editor.selections[0].active,
    onOutput: (pos) => {
      editor.cursor = { type: "block" };
      const p = fixNormalCursor(editor, pos);
      editor.selections = [{ anchor: p, active: p }];
    },
    env: env ?? emptyEnv(),
  });
}

it("delete", () => {
  withEditor(
    __filename,
    "abcde\n  fghij klmnopqrst\n",
    (editor, writeState) => {
      editor.selections = [{ anchor: { l: 0, c: 3 }, active: { l: 0, c: 3 } }];
      editor.cursor = { type: "block" };
      writeState("init");

      testChangeKeys(editor, ["D"]);
      writeState("D");

      editor.selections = [{ anchor: { l: 0, c: 1 }, active: { l: 0, c: 1 } }];
      editor.cursor = { type: "block" };
      writeState("reset");

      testChangeKeys(editor, ["r", "d"]);
      writeState("rd");

      testChangeKeys(editor, ["d", "d"]);
      writeState("dd");

      editor.editText(
        { anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } },
        "abc\n"
      );
      editor.selections = [{ anchor: { l: 1, c: 4 }, active: { l: 1, c: 4 } }];
      editor.cursor = { type: "block" };
      writeState("reset and move to line 2");
      testChangeKeys(editor, ["d", "e"]);
      writeState("de");

      editor.selections = [{ anchor: { l: 1, c: 7 }, active: { l: 1, c: 7 } }];
      editor.cursor = { type: "block" };
      writeState("move to line 2");
      testChangeKeys(editor, ["x"]);
      writeState("x");
      testChangeKeys(editor, ["X"]);
      writeState("X");

      editor.selections = [{ anchor: { l: 1, c: 7 }, active: { l: 1, c: 7 } }];
      editor.cursor = { type: "block" };
      writeState("move to line 2");
      testChangeKeys(editor, ["d", "b"]);
      writeState("db");

      editor.selections = [{ anchor: { l: 1, c: 6 }, active: { l: 1, c: 6 } }];
      editor.cursor = { type: "block" };
      writeState("move to line 2");
      testChangeKeys(editor, ["d", "w"]);
      writeState("dw");

      editor.selections = [{ anchor: { l: 1, c: 5 }, active: { l: 1, c: 5 } }];
      editor.cursor = { type: "block" };
      writeState("move to line 2");
      for (let i = 0; i < 4; i++) {
        testChangeKeys(editor, ["d", "d"]);
        writeState("dd");
      }

      testChangeKeys(editor, ["r", "a"]);
      writeState("ra");
    }
  );
});
