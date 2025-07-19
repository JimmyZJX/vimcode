import { withEditor } from "../../testUtils.js";
import { testInsertKeys } from "./insert.test.js";

it("cut", () => {
  withEditor(
    __filename,
    "abcde\n  fghij klmnopqrst\n",
    (editor, writeState) => {
      editor.selections = [{ anchor: { l: 0, c: 3 }, active: { l: 0, c: 3 } }];
      editor.cursor = { type: "block" };
      writeState("init");

      testInsertKeys(editor, ["C"]);
      writeState("C");

      editor.selections = [{ anchor: { l: 0, c: 1 }, active: { l: 0, c: 1 } }];
      editor.cursor = { type: "block" };
      writeState("reset");
      testInsertKeys(editor, ["c", "c"]);
      writeState("cc");

      editor.selections = [{ anchor: { l: 1, c: 4 }, active: { l: 1, c: 4 } }];
      editor.cursor = { type: "block" };
      writeState("move to line 2");
      testInsertKeys(editor, ["c", "e"]);
      writeState("ce");

      editor.selections = [{ anchor: { l: 1, c: 7 }, active: { l: 1, c: 7 } }];
      editor.cursor = { type: "block" };
      writeState("move to line 2");
      testInsertKeys(editor, ["s"]);
      writeState("s");

      editor.selections = [{ anchor: { l: 1, c: 7 }, active: { l: 1, c: 7 } }];
      editor.cursor = { type: "block" };
      writeState("move to line 2");
      testInsertKeys(editor, ["c", "b"]);
      writeState("cb");

      editor.selections = [{ anchor: { l: 1, c: 6 }, active: { l: 1, c: 6 } }];
      editor.cursor = { type: "block" };
      writeState("move to line 2");
      testInsertKeys(editor, ["c", "w"]);
      writeState("cw");

      editor.selections = [{ anchor: { l: 1, c: 5 }, active: { l: 1, c: 5 } }];
      editor.cursor = { type: "block" };
      writeState("move to line 2");
      testInsertKeys(editor, ["c", "c"]);
      writeState("cc");
    }
  );
});
