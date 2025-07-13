import {
  comparePos,
  Editor,
  fixPos,
  Pos,
  Selection,
} from "../../editorInterface";
import {
  ChordEntry,
  Chords,
  Env,
  runChordWithCallback,
  simpleKeys,
} from "../common";
import { getLineWhitePrefix } from "../lineUtil";
import { motions } from "../motion/motion";
import { getCharType } from "../motion/word";

function delWithMotion(
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

function delMotionW(e: "e" | "E", w: "w" | "W") {
  const motionE = motions[e];
  const motionW = motions[w];
  if (motionE?.type !== "action" || motionW?.type !== "action")
    return undefined;
  return (editor: Editor, env: Env, p: Pos) => {
    const motionEnd =
      getCharType(editor.getLine(p.l)[p.c]) === "white"
        ? motionW.action(editor, env, p)
        : motionE.action(editor, env, p);
    return delWithMotion(editor, env, p, motionEnd);
  };
}

function delCurrentLine(editor: Editor, env: Env, p: Pos) {
  const line = editor.getLine(p.l);
  const prefix = getLineWhitePrefix(editor, p.l);
  delWithMotion(editor, env, { l: p.l, c: 0 }, { l: p.l, c: line.length });
  editor.editText(
    { anchor: { l: p.l, c: 0 }, active: { l: p.l, c: 0 } },
    prefix
  );
  return { l: p.l, c: prefix.length };
}

function cutOrDelete(key: "c" | "d"): ChordEntry<Pos, Pos> {
  return {
    type: "menu",
    chords: simpleKeys({
      [key]: delCurrentLine,
      // TODO instead, implement motion with different modes (as context)
      /* c{w,W} is c{e,E} when cursor is not on whitespace */
      w: delMotionW("e", "w"),
      W: delMotionW("E", "W"),
    }),
    fallback: runChordWithCallback({
      chords: motions,
      fallback: undefined,
      callback: (editor, env, { input, output }) => {
        // TODO use suggested region
        return delWithMotion(editor, env, input, output);
      },
    }),
  };
}

export const cuts: Chords<Pos, Pos> = {
  ...simpleKeys({
    s: (editor, env, p) => {
      return delWithMotion(editor, env, p, fixPos(editor, p, 1));
    },
    S: delCurrentLine,
    C: (editor, env, p) => {
      const line = editor.getLine(p.l);
      return delWithMotion(editor, env, p, { l: p.l, c: line.length });
    },
  }),
  c: cutOrDelete("c"),
};

export const deletes: Chords<Pos, Pos> = {
  ...simpleKeys({
    x: (editor, env, p) => {
      return delWithMotion(editor, env, p, fixPos(editor, p, 1));
    },
    X: (editor, env, p) => {
      return delWithMotion(editor, env, fixPos(editor, p, -1), p);
    },
    D: (editor, env, p) => {
      const line = editor.getLine(p.l);
      return delWithMotion(editor, env, p, { l: p.l, c: line.length });
    },
  }),
  d: cutOrDelete("d"),
};
