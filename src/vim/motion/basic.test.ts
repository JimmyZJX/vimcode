import { withEditor } from "../../testUtils";
import { emptyEnv, Env } from "../common";
import { testMotionKeys } from "./motion";

it("motion basic", () => {
  withEditor(__filename, "abcd\nef\n\nghijkl", (editor, writeState) => {
    editor.cursor = { type: "block" };
    writeState("init");

    let env = emptyEnv();

    testMotionKeys(editor, ["l", "l", "l", "l"], env);
    writeState("l * 4");

    for (let i = 0; i < 3; i++) {
      testMotionKeys(editor, ["j"], env);
      writeState("j");
    }

    testMotionKeys(editor, ["k"], env);
    writeState("k");
    testMotionKeys(editor, ["k"], env);
    writeState("k");
    testMotionKeys(editor, ["h"], env);
    writeState("h");
    testMotionKeys(editor, ["k"], env);
    writeState("k");
  });
});
