import { Pos } from "../../editorInterface";
import { Action, Chords, simpleKeys } from "../common";

const insert: Record<string, Action<Pos, Pos>> = {
  i: (_editor, _env, p) => p,
  I: (editor, _env, p) => {
    const line = editor.getLine(p.l);
    const leadingWhiteChars = line.length - line.trimStart().length;
    return { l: p.l, c: leadingWhiteChars };
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
    const leadingWhiteChars = line.length - line.trimStart().length;
    const prefix = line.slice(0, leadingWhiteChars);
    const lineEnd = { l: p.l, c: line.length };
    editor.editText({ anchor: lineEnd, active: lineEnd }, "\n" + prefix);
    return { l: p.l + 1, c: prefix.length };
  },
  O: (editor, _env, p) => {
    const line = editor.getLine(p.l);
    const leadingWhiteChars = line.length - line.trimStart().length;
    const prefix = line.slice(0, leadingWhiteChars);
    const lineStart = { l: p.l, c: 0 };
    editor.editText({ anchor: lineStart, active: lineStart }, prefix + "\n");
    return { l: p.l, c: prefix.length };
  },
};

export const inserts: Chords<Pos, Pos> = simpleKeys(insert);
