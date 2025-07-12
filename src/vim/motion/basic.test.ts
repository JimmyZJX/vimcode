import { withEditor } from "../../testUtils";
import { Env } from "../common";
import { runKeysInTest } from "./motion";

it("motion basic", () => {
  withEditor(__filename, "abcd\nef\n\nghijkl", (editor, writeState) => {
    editor.cursor = { type: "block" };
    writeState("init");

    let env: Env = { options: {}, flash: {} };

    runKeysInTest(editor, ["l", "l", "l", "l"], env);
    writeState("l * 4");

    for (let i = 0; i < 3; i++) {
      runKeysInTest(editor, ["j"], env);
      writeState("j");
    }

    runKeysInTest(editor, ["k"], env);
    writeState("k");
    runKeysInTest(editor, ["k"], env);
    writeState("k");
    runKeysInTest(editor, ["h"], env);
    writeState("h");
    runKeysInTest(editor, ["k"], env);
    writeState("k");
  });
});
