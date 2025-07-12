import FakeEditor from "./fakeEditor";
import { Selection, Cursor } from "./editorInterface";
import fs from "fs";

describe("FakeEditor", () => {
  it("should dump initial state and after edits", () => {
    const dumpFd = fs.openSync(__dirname + "/fakeEditor.test.dump.txt", "w");
    const editor = new FakeEditor("hello\nworld");

    function writeState(description: string) {
      fs.writeFileSync(dumpFd, `${description}\n${editor.dump()}\n`);
    }

    writeState(
      "Initial: The editor is created with two lines: 'hello' and 'world'."
    );
    expect(editor.getText()).toBe("hello\nworld");

    editor.selections = [{ anchor: { l: 1, c: 0 }, active: { l: 1, c: 3 } }];
    writeState(
      "The cursor is moved to line 1, column 3, and 'wor' in 'world' is selected."
    );
    expect(editor.getText()).toBe("hello\nworld");

    editor.selections = [
      ...editor.selections,
      { anchor: { l: 0, c: 1 }, active: { l: 0, c: 4 } },
    ];
    writeState("Multi selections");

    editor.editText(editor.selections[0], "abc");
    writeState("After edit: The selected 'wor' is replaced with 'abc'.");
    expect(editor.getText()).toBe("hello\nabcld");

    editor.selections = [{ anchor: { l: 0, c: 2 }, active: { l: 1, c: 2 } }];
    writeState(
      "Selection changed to multi-line from after 'he' in 'hello' to 'wo' in 'world' is replaced with 'XY'."
    );

    editor.editText(editor.selections[0], "XY");
    writeState("After multiline edit: selection is replaced with 'XY'.");
    expect(editor.getText()).toBe("heXYcld");

    editor.selections = [{ anchor: { l: 0, c: 2 }, active: { l: 0, c: 2 } }];
    writeState("Fix selection manually");

    editor.selections = [{ anchor: { l: 0, c: 2 }, active: { l: 0, c: 7 } }];
    writeState("Select to the end of line");

    editor.selections = [{ anchor: { l: 0, c: 2 }, active: { l: 0, c: 5 } }];
    editor.cursor = { type: "block" };
    writeState("Block selection");

    fs.closeSync(dumpFd);
  });
});
