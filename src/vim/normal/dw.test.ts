import { withEditor } from "../../testUtils.js";
import { testChangeKeys } from "./change.js";

it("change", () => {
  withEditor(__filename, "abc def ghi\n  j klm\n", (editor, writeState) => {
    editor.selections = [{ anchor: { l: 0, c: 3 }, active: { l: 0, c: 3 } }];
    editor.cursor = { type: "block" };
    writeState("init");

    testChangeKeys(editor, ["d", "w"]);
    writeState("dw");

    testChangeKeys(editor, ["d", "w"]);
    writeState("dw");

    testChangeKeys(editor, ["d", "w"]);
    writeState("dw");
  });
});
