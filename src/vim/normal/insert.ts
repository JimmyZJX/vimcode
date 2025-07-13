import {
  comparePos,
  Editor,
  fixPos,
  Pos,
  Selection,
} from "../../editorInterface";
import {
  Action,
  Chords,
  Env,
  runChordWithCallback,
  simpleKeys,
} from "../common";
import { motions } from "../motion/motion";
import { getCharType } from "../motion/word";

function getLineWhitePrefix(editor: Editor, l: number) {
  const line = editor.getLine(l);
  const leadingWhiteChars = line.length - line.trimStart().length;
  return line.slice(0, leadingWhiteChars);
}

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

function cutWithMotion(
  editor: Editor,
  env: Env,
  normalCursorPos: Pos,
  motionEnd: Pos
): Pos {
  // TODO use suggested region
  const compare = comparePos(normalCursorPos, motionEnd);
  if (compare === 0) {
    // no text removed
    return { l: motionEnd.l, c: motionEnd.c };
  }
  const region: Selection =
    compare > 0
      ? /* backward */
        {
          anchor: motionEnd,
          active: normalCursorPos,
        }
      : /* forward */
        {
          anchor: normalCursorPos,
          active: fixPos(editor, motionEnd, 1),
        };

  // TODO show register diff in tests
  env.globalState.textRegister[""] = {
    fullLine: false, // TODO implement
    content: editor.getText(region),
  };

  editor.editText(region, "");
  return region.anchor;
}

function cutMotionW(e: "e" | "E", w: "w" | "W") {
  const motionE = motions[e];
  const motionW = motions[w];
  if (motionE?.type !== "action" || motionW?.type !== "action")
    return undefined;
  return (editor: Editor, env: Env, p: Pos) => {
    const motionEnd =
      getCharType(editor.getLine(p.l)[p.c]) === "white"
        ? motionW.action(editor, env, p)
        : motionE.action(editor, env, p);
    return cutWithMotion(editor, env, p, motionEnd);
  };
}

export const inserts: Chords<Pos, Pos> = {
  ...simpleKeys(insert),
  C: {
    type: "action",
    action: (editor, env, p) => {
      const line = editor.getLine(p.l);
      return cutWithMotion(editor, env, p, { l: p.l, c: line.length });
    },
  },
  c: {
    type: "menu",
    chords: simpleKeys({
      c: (editor, env, p) => {
        const line = editor.getLine(p.l);
        const prefix = getLineWhitePrefix(editor, p.l);
        cutWithMotion(
          editor,
          env,
          { l: p.l, c: 0 },
          { l: p.l, c: line.length }
        );
        editor.editText(
          { anchor: { l: p.l, c: 0 }, active: { l: p.l, c: 0 } },
          prefix
        );
        return { l: p.l, c: prefix.length };
      },
      // TODO instead, implement motion with different modes (as context)
      /* c{w,W} is c{e,E} when cursor is not on whitespace */
      w: cutMotionW("e", "w"),
      W: cutMotionW("E", "W"),
    }),
    fallback: runChordWithCallback({
      chords: motions,
      fallback: undefined,
      callback: (editor, env, { input, output }) => {
        // TODO use suggested region
        return cutWithMotion(editor, env, input, output);
      },
    }),
  },
};
