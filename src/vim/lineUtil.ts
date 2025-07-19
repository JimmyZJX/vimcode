import { Editor } from "../editorInterface.js";

export function getLineWhitePrefix(editor: Editor, l: number) {
  const line = editor.getLine(l);
  const leadingWhiteChars = line.length - line.trimStart().length;
  return line.slice(0, leadingWhiteChars);
}
