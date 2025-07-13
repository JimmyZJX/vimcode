import { withEditor } from "../../testUtils";
import { emptyEnv } from "../common";
import { testMotionKeys } from "./motion";

it("motion basic", () => {
  withEditor(__filename, "  abcd\n ef\n\n   ghijkl", (editor, writeState) => {
    editor.cursor = { type: "block" };
    writeState("init");

    let env = emptyEnv();

    testMotionKeys(editor, ["l", "l", "l", "l"], env);
    writeState("l*4");

    testMotionKeys(editor, ["^"], env);
    writeState("^");
    testMotionKeys(editor, ["$"], env);
    writeState("$");

    testMotionKeys(editor, ["0"], env);
    writeState("0");
    testMotionKeys(editor, ["g", "_"], env);
    writeState("g_");

    testMotionKeys(editor, ["-"], env);
    writeState("-");
    testMotionKeys(editor, ["+"], env);
    writeState("+");
    testMotionKeys(editor, ["+"], env);
    writeState("+");

    testMotionKeys(editor, ["G"], env);
    writeState("G");
    testMotionKeys(editor, ["g", "g"], env);
    writeState("gg");
  });
});
