import { withEditor } from "../../testUtils.js";
import { testMotionKeys } from "./motion.js";

it("motion basic", () => {
  withEditor(__filename, "ab cdef\ngh.-=! ** 8w8\n\n", (editor, writeState) => {
    editor.cursor = { type: "block" };
    writeState("init");
    for (let i = 0; i < 8; i++) {
      testMotionKeys(editor, ["w"]);
      writeState("w");
    }

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("reset");
    for (let i = 0; i < 7; i++) {
      testMotionKeys(editor, ["W"]);
      writeState("W");
    }

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("reset");
    for (let i = 0; i < 7; i++) {
      testMotionKeys(editor, ["e"]);
      writeState("e");
    }

    for (let i = 0; i < 7; i++) {
      testMotionKeys(editor, ["b"]);
      writeState("b");
    }

    for (let i = 0; i < 6; i++) {
      testMotionKeys(editor, ["E"]);
      writeState("E");
    }

    for (let i = 0; i < 7; i++) {
      testMotionKeys(editor, ["B"]);
      writeState("B");
    }

    testMotionKeys(editor, ["G"]);
    writeState("G");

    for (let i = 0; i < 3; i++) {
      testMotionKeys(editor, ["g", "E"]);
      writeState("gE");
      testMotionKeys(editor, ["g", "e"]);
      writeState("ge");
    }
  });
});
