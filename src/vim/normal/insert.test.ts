import { withEditor } from "../../testUtils.js";
import { testInsertKeys } from "./insert.js";

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
