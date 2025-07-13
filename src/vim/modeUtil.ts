import { Editor, Pos } from "../editorInterface";

export function fixNormalCursor(editor: Editor, pos: Pos): Pos {
  const line = editor.getLine(pos.l);
  const c = Math.max(0, Math.min(line.length - 1, pos.c));
  return { l: pos.l, c };
}
