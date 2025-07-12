import { withEditor } from "../../testUtils";
import { runKeysInTest } from "./motion";

it("motion basic", () => {
  withEditor(__filename, "ab cdef\ngh.-=! ** 8w8\n\n", (editor, writeState) => {
    editor.cursor = { type: "block" };
    writeState("init");
    for (let i = 0; i < 8; i++) {
      runKeysInTest(editor, ["w"]);
      writeState("w");
    }

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("reset");
    for (let i = 0; i < 7; i++) {
      runKeysInTest(editor, ["W"]);
      writeState("W");
    }

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("reset");
    for (let i = 0; i < 7; i++) {
      runKeysInTest(editor, ["e"]);
      writeState("e");
    }

    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("reset");
    for (let i = 0; i < 6; i++) {
      runKeysInTest(editor, ["E"]);
      writeState("E");
    }
  });
});
