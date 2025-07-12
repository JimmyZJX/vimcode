import { Editor, Pos } from "../editorInterface";
import { withEditor } from "../testUtils";
import { Chords, Options } from "./common";
import { motions } from "./motion";

function runKeys(editor: Editor, keys: string[]) {
  // TODO normal mode, single cursor for now
  const options: Options = {};

  let cur = motions;
  for (const k of keys) {
    const entry = cur[k];
    if (entry.type === "menu") {
      cur = entry.chords;
    } else {
      const sel = editor.selections[0];
      const pos = entry.action(editor, options, sel.active);
      editor.selections = [{ anchor: pos, active: pos }];
      cur = motions;
    }
  }

  if (cur !== motions) {
    throw new Error("Chords not fully applied: " + keys.join(" "));
  }
}

it("motion basic", () => {
  withEditor(__filename, "ab cdef\ngh.-=! ** 8w8\n\n", (editor, writeState) => {
    editor.cursor = { type: "block" };
    writeState("init");
    for (let i = 0; i < 8; i++) {
      runKeys(editor, ["w"]);
      writeState("w");
    }
    editor.selections = [{ anchor: { l: 0, c: 0 }, active: { l: 0, c: 0 } }];
    writeState("reset");
    for (let i = 0; i < 7; i++) {
      runKeys(editor, ["W"]);
      writeState("W");
    }
  });
});
