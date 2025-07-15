import { Pos } from "../../editorInterface";
import { Action, ChordKeys, simpleKeys } from "../common";
import { getLineWhitePrefix } from "../lineUtil";
import { cuts } from "./cutDelete";

const insert: Record<string, Action<Pos, Pos>> = {
  i: (_editor, _env, p) => p,
  I: (editor, _env, p) => {
    return { l: p.l, c: getLineWhitePrefix(editor, p.l).length };
  },
  a: (editor, _env, p) => {
    const line = editor.getLine(p.l);
    return { l: p.l, c: Math.min(p.c + 1, line.length) };
  },
  A: (editor, _env, p) => {
    const line = editor.getLine(p.l);
    return { l: p.l, c: line.length };
  },
  o: (editor, _env, p) => {
    const line = editor.getLine(p.l);
    const prefix = getLineWhitePrefix(editor, p.l);
    const lineEnd = { l: p.l, c: line.length };
    editor.editText({ anchor: lineEnd, active: lineEnd }, "\n" + prefix);
    return { l: p.l + 1, c: prefix.length };
  },
  O: (editor, _env, p) => {
    const prefix = getLineWhitePrefix(editor, p.l);
    const lineStart = { l: p.l, c: 0 };
    editor.editText({ anchor: lineStart, active: lineStart }, prefix + "\n");
    return { l: p.l, c: prefix.length };
  },
};

export const inserts: ChordKeys<Pos, Pos> = {
  ...simpleKeys(insert),
  ...cuts,
};
