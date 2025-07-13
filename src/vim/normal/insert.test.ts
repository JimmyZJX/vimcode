import { Editor } from "../../editorInterface";
import { withEditor } from "../../testUtils";
import { emptyEnv, Env, testKeys } from "../common";
import { inserts } from "./insert";

export function testInsertKeys(
  editor: Editor,
  keys: string[],
  env?: Env
): void {
  testKeys({
    editor,
    keys,
    chords: { keys: inserts },
    getInput: () => editor.selections[0].active,
    onOutput: (pos) => {
      editor.cursor = { type: "line" };
      editor.selections = [{ anchor: pos, active: pos }];
    },
    env: env ?? emptyEnv(),
  });
}

it("insert", () => {
  withEditor(__filename, "abc\n  def\nghi\n", (editor, writeState) => {
    editor.selections = [{ anchor: { l: 1, c: 3 }, active: { l: 1, c: 3 } }];
    editor.cursor = { type: "block" };
    writeState("init");

    testInsertKeys(editor, ["i"]);
    writeState("i");

    editor.selections = [{ anchor: { l: 1, c: 3 }, active: { l: 1, c: 3 } }];
    editor.cursor = { type: "block" };
    testInsertKeys(editor, ["a"]);
    writeState("a");

    testInsertKeys(editor, ["I"]);
    writeState("I");

    testInsertKeys(editor, ["A"]);
    writeState("A");

    editor.selections = [{ anchor: { l: 3, c: 0 }, active: { l: 3, c: 0 } }];
    editor.cursor = { type: "block" };
    writeState("move to line 4");
    testInsertKeys(editor, ["a"]);
    writeState("a");

    editor.selections = [{ anchor: { l: 1, c: 3 }, active: { l: 1, c: 3 } }];
    editor.cursor = { type: "block" };
    writeState("move to line 4");
    testInsertKeys(editor, ["o"]);
    writeState("o");

    editor.selections = [{ anchor: { l: 1, c: 3 }, active: { l: 1, c: 3 } }];
    editor.cursor = { type: "block" };
    writeState("move to line 4");
    testInsertKeys(editor, ["O"]);
    writeState("O");

    const ll = editor.getLines() - 1;
    editor.selections = [{ anchor: { l: ll, c: 0 }, active: { l: ll, c: 0 } }];
    editor.cursor = { type: "block" };
    writeState("move to last line");
    testInsertKeys(editor, ["o"]);
    writeState("o");

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    editor.cursor = { type: "block" };
    writeState("move to first line");
    testInsertKeys(editor, ["O"]);
    writeState("O");
  });
});
