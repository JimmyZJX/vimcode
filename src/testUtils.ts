import fs from "fs";
import FakeEditor from "./fakeEditor/fakeEditor.js";

export function withEditor(
  filename: string,
  initText: string,
  f: (editor: FakeEditor, writeState: (description: string) => void) => void
) {
  const dumpFd = fs.openSync(filename.replace(/\.+$/, "") + ".txt", "w");
  function writeState(description: string) {
    fs.writeFileSync(dumpFd, `${description}\n${editor.dump()}\n`);
  }
  const editor = new FakeEditor(initText);

  try {
    f(editor, writeState);
  } finally {
    fs.closeSync(dumpFd);
  }
}
