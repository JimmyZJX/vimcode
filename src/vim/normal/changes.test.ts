import { withEditor } from "../../testUtils.js";
import { emptyEnv } from "../common.js";
import { testChangeKeys } from "./change.js";

it("change", () => {
  withEditor(
    __filename,
    "abcde\n  fghij klmnopqrst\n",
    (editor, writeState) => {
      const env = emptyEnv();
      const testKeys = (keys: string[]) => testChangeKeys(editor, keys, env);

      editor.selections = [{ anchor: { l: 0, c: 3 }, active: { l: 0, c: 3 } }];
      editor.cursor = { type: "block" };
      writeState("init");

      testKeys(["D"]);
      writeState("D");

      editor.selections = [{ anchor: { l: 0, c: 1 }, active: { l: 0, c: 1 } }];
      editor.cursor = { type: "block" };
      writeState("reset");

      testKeys(["r", "d"]);
      writeState("rd");

      testKeys(["d", "d"]);
      writeState("dd");

      editor.editText(
        { anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } },
        "abc\n"
      );
      editor.selections = [{ anchor: { l: 1, c: 4 }, active: { l: 1, c: 4 } }];
      editor.cursor = { type: "block" };
      writeState("reset and move to line 2");
      testKeys(["d", "e"]);
      writeState("de");

      editor.selections = [{ anchor: { l: 1, c: 7 }, active: { l: 1, c: 7 } }];
      editor.cursor = { type: "block" };
      writeState("move to line 2");
      testKeys(["x"]);
      writeState("x");
      testKeys(["X"]);
      writeState("X");

      editor.selections = [{ anchor: { l: 1, c: 7 }, active: { l: 1, c: 7 } }];
      editor.cursor = { type: "block" };
      writeState("move to line 2");
      testKeys(["d", "b"]);
      writeState("db");

      editor.selections = [{ anchor: { l: 1, c: 6 }, active: { l: 1, c: 6 } }];
      editor.cursor = { type: "block" };
      writeState("move to line 2");
      testKeys(["d", "w"]);
      writeState("dw");

      editor.selections = [{ anchor: { l: 1, c: 5 }, active: { l: 1, c: 5 } }];
      editor.cursor = { type: "block" };
      writeState("move to line 2");
      for (let i = 0; i < 4; i++) {
        testKeys(["d", "d"]);
        writeState("dd");
      }

      testKeys(["r", "a"]);
      writeState("ra");
    }
  );
});
