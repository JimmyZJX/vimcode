import { Editor, fixPos, Pos } from "../../editorInterface.js";
import { Env } from "../common.js";
import { MotionResult } from "./motion.js";

export function left(editor: Editor, p: Pos): MotionResult {
  const pos = fixPos(editor, p, -1);
  return { pos, range: { active: pos, anchor: p } };
}

export function right(editor: Editor, p: Pos) {
  const pos = fixPos(editor, p, 1);
  return { pos, range: { active: p, anchor: pos } };
}

// TODO different behavior for different mode... for the \n character... fixPos
export function moveUpDown(
  editor: Editor,
  env: Env,
  p: Pos,
  mode: "up" | "down"
) {
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

export function upDown(editor: Editor, env: Env, p: Pos, mode: "up" | "down") {
  return { pos: moveUpDown(editor, env, p, mode), wholeLine: true };
}
