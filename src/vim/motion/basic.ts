import { Editor, Pos } from "../../editorInterface";
import { Env } from "../common";

export function left(_: Editor, p: Pos) {
  if (p.c <= 0) return { l: p.l, c: 0 };
  return { l: p.l, c: p.c - 1 };
}

export function right(editor: Editor, p: Pos) {
  const len = editor.getLine(p.l).length;
  if (p.c + 1 >= len) return { l: p.l, c: len - 1 };
  return { l: p.l, c: p.c + 1 };
}

export function upDown(editor: Editor, env: Env, p: Pos, mode: "up" | "down") {
  let tc = p.c;
  if (env.flash.preferredColumn !== undefined) {
    const lenL = editor.getLine(p.l).length;
    if (p.c >= lenL - 1) {
      tc = env.flash.preferredColumn;
    }
  }

  const l = editor.getSiblingLine(p.l, mode === "up" ? -1 : 1);
  if (p.l === l) {
    return { l: p.l, c: tc };
  }
  const len = editor.getLine(l).length;
  if (len === 0) {
    env.flash = { preferredColumn: tc };
    return { l, c: 0 };
  } else {
    const c = Math.min(len - 1, tc);
    if (c < tc) {
      env.flash = { preferredColumn: tc };
    }
    return { l, c };
  }
}
