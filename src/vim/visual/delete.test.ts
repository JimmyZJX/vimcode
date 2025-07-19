import { Editor } from "../../editorInterface.js";
import { withEditor } from "../../testUtils.js";
import { emptyEnv, Env, testKeys } from "../common.js";
import { fixNormalCursor } from "../modeUtil.js";
import { visualDelete } from "./delete.js";

export function testVisualDeleteKeys(
  editor: Editor,
  keys: string[],
  env?: Env
): void {
  testKeys({
    editor,
    keys,
    chords: { type: "impl", impl: { type: "keys", keys: visualDelete } },
    getInput: () => editor.selections[0],
    onOutput: (pos) => {
      editor.cursor = { type: "block" };
      const p = fixNormalCursor(editor, pos);
      editor.selections = [{ anchor: p, active: p }];
    },
    env: env ?? emptyEnv(),
  });
}

it("delete", () => {
  withEditor(__filename, "abcdefghij\n  klmnopqrst\n", (editor, writeState) => {
    editor.selections = [{ anchor: { l: 0, c: 2 }, active: { l: 0, c: 3 } }];
    editor.cursor = { type: "block" };
    writeState("init");

    testVisualDeleteKeys(editor, ["d"]);
    writeState("d");

    editor.selections = [{ anchor: { l: 0, c: 2 }, active: { l: 0, c: 3 } }];
    writeState("reset");

    testVisualDeleteKeys(editor, ["x"]);
    writeState("x");

    editor.selections = [{ anchor: { l: 0, c: 2 }, active: { l: 0, c: 3 } }];
    writeState("reset");

    testVisualDeleteKeys(editor, ["r", "d"]);
    writeState("rd");

    editor.selections = [{ anchor: { l: 0, c: 2 }, active: { l: 0, c: 3 } }];
    writeState("reset");

    testVisualDeleteKeys(editor, ["D"]);
    writeState("D");
  });
});
