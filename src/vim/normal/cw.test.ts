import { withEditor } from "../../testUtils.js";
import { testInsertKeys } from "./insert.js";

it("dw", () => {
  withEditor(__filename, "abc def ghi\n  j klm\n", (editor, writeState) => {
    editor.selections = [{ anchor: { l: 0, c: 3 }, active: { l: 0, c: 3 } }];
    editor.cursor = { type: "block" };
    writeState("init");

    for (let i = 0; i < 4; i++) {
      testInsertKeys(editor, ["c", "w"]);
      writeState("cw");

      editor.cursor = { type: "block" };
      writeState("(block)");
    }
  });
});
