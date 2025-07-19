import { Editor, fixPos, Pos } from "../../editorInterface.js";
import { Env } from "../common.js";

export function left(editor: Editor, p: Pos) {
  return fixPos(editor, p, -1);
}

export function right(editor: Editor, p: Pos) {
  return fixPos(editor, p, 1);
}

// TODO different behavior for different mode... for the \n character... fixPos
export function upDown(editor: Editor, env: Env, p: Pos, mode: "up" | "down") {
  let tc = p.c;
  if (env.flash.preferredColumn !== undefined) {
    const lenL = editor.getLineLength(p.l);
    if (p.c >= lenL - 1) {
      tc = env.flash.preferredColumn;
    }
  }

  const l = editor.getSiblingLine(p.l, mode === "up" ? -1 : 1);
  env.flash = { preferredColumn: tc };
  if (p.l === l) {
    return { l: p.l, c: p.c };
  }
  const len = editor.getLineLength(l);
  if (len === 0) {
    return { l, c: 0 };
  } else {
    const pos = fixPos(editor, { l, c: tc });
    return pos;
  }
}
