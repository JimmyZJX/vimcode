import { Editor, Pos } from "../../editorInterface.js";
import {
  Action,
  ChordKeys,
  emptyEnv,
  Env,
  simpleKeys,
  testKeys,
} from "../common.js";
import { getLineWhitePrefix } from "../lineUtil.js";
import { cuts } from "./cutDelete.js";

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

export function testInsertKeys(
  editor: Editor,
  keys: string[],
  env?: Env
): void {
  testKeys({
    editor,
    keys,
    chords: { type: "impl", impl: { type: "keys", keys: inserts } },
    getInput: () => editor.selections[0].active,
    onOutput: (pos) => {
      editor.cursor = { type: "line" };
      editor.selections = [{ anchor: pos, active: pos }];
    },
    env: env ?? emptyEnv(),
  });
}
