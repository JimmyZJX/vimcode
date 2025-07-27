import { Editor } from "../../editorInterface.js";
import { withEditor } from "../../testUtils.js";
import { emptyEnv, Env, testKeys } from "../common.js";
import { visualInsert } from "./insert.js";

export function testVisualInsertKeys(
  editor: Editor,
  keys: string[],
  env?: Env
): void {
  testKeys({
    editor,
    keys,
    chords: { type: "impl", impl: { type: "keys", keys: visualInsert } },
    getInput: () => editor.selections[0],
    onOutput: (p) => {
      editor.cursor = { type: "line" };
      editor.selections = [{ anchor: p, active: p }];
    },
    env: env ?? emptyEnv(),
  });
}

it("visual insert", () => {
  withEditor(__filename, "abcdefghij\n  klmnopqrst\n", (editor, writeState) => {
    editor.selections = [{ anchor: { l: 0, c: 2 }, active: { l: 0, c: 4 } }];
    editor.cursor = { type: "block" };
    writeState("init");

    testVisualInsertKeys(editor, ["I"]);
    writeState("I");

    editor.selections = [{ anchor: { l: 0, c: 2 }, active: { l: 0, c: 4 } }];
    editor.cursor = { type: "block" };
    writeState("reset");

    testVisualInsertKeys(editor, ["A"]);
    writeState("A");

    editor.selections = [{ anchor: { l: 0, c: 2 }, active: { l: 0, c: 4 } }];
    editor.cursor = { type: "block" };
    writeState("reset");

    testVisualInsertKeys(editor, ["s"]);
    writeState("s");
  });
});
