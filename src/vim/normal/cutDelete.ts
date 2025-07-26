import {
  comparePos,
  Editor,
  fixPos,
  Pos,
  rangeOfSelection,
  Selection,
} from "../../editorInterface.js";
import {
  ChordKeys,
  ChordMenu,
  Env,
  mapChordMenu,
  simpleKeys,
} from "../common.js";
import { getLineWhitePrefix } from "../lineUtil.js";
import { MotionResult, motions } from "../motion/motion.js";
import { forwardWord } from "../motion/word.js";

/** deletes [anchor <- active) */
export function delRange(editor: Editor, env: Env, range: Selection) {
  // TODO show register diff in tests
  env.globalState.registers.putText(editor, {
    isFullLine: false,
    content: editor.getText(range),
  });

  editor.editText(range, "");
}

export function delWithMotion(
  editor: Editor,
  env: Env,
  normalCursorPos: Pos,
  motionEnd: Pos
): Pos {
  // TODO use suggested region
  const region: Selection =
    comparePos(normalCursorPos, motionEnd) > 0
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

  delRange(editor, env, region);
  return region.anchor;
}

// function delMotionWord(e: "e" | "E", w: "w" | "W") {
//   const motionE = motions[e];
//   const motionW = motions[w];
//   if (motionE?.type !== "action" || motionW?.type !== "action")
//     return undefined;
//   return (editor: Editor, env: Env, p: Pos) => {
//     const motionEnd =
//       getCharType(editor.getLine(p.l)[p.c]) === "white"
//         ? motionW.action(editor, env, p)
//         : motionE.action(editor, env, p);
//     return delWithMotion(editor, env, p, motionEnd);
//   };
// }

function cutLines(editor: Editor, env: Env, l1: number, l2: number) {
  [l1, l2] = [Math.min(l1, l2), Math.max(l1, l2)];
  const len2 = editor.getLineLength(l2);
  const prefix = getLineWhitePrefix(editor, l1);

  const range = { anchor: { l: l1, c: 0 }, active: { l: l2, c: len2 } };

  env.globalState.registers.putText(editor, {
    isFullLine: true,
    content: editor.getText(range),
  });

  editor.editText(range, prefix);
  return { l: l1, c: prefix.length };
}

function deleteLines(editor: Editor, env: Env, l1: number, l2: number) {
  [l1, l2] = [Math.min(l1, l2), Math.max(l1, l2)];
  const lines = editor.getLines();
  const len2 = editor.getLineLength(l2);

  const range = { anchor: { l: l1, c: 0 }, active: { l: l2, c: len2 } };
  env.globalState.registers.putText(editor, {
    isFullLine: true,
    content: editor.getText(range),
  });

  if (l2 + 1 < lines) {
    // delete and focus on next line
    editor.editText(
      { anchor: { l: l1, c: 0 }, active: { l: l2 + 1, c: 0 } },
      ""
    );
    return { l: l1, c: getLineWhitePrefix(editor, l1).length };
  } else if (l1 > 0) {
    // remove text and focus on previous line
    editor.editText(
      {
        anchor: { l: l1 - 1, c: editor.getLineLength(l1 - 1) },
        active: { l: l2, c: len2 },
      },
      ""
    );
    return { l: l1 - 1, c: getLineWhitePrefix(editor, l1 - 1).length };
  } else {
    // all text removed
    editor.editText(
      {
        anchor: { l: 0, c: 0 },
        active: { l: l2, c: len2 },
      },
      ""
    );
    return { l: 0, c: 0 };
  }
}

function curOrDeleteMotion(
  mode: "cut" | "delete",
  editor: Editor,
  env: Env,
  {
    input,
    output: { pos, range, wholeLine },
  }: { input: Pos; output: MotionResult }
): Pos {
  if (wholeLine) {
    const [l1, l2] = range
      ? [range.anchor.l, range.active.l]
      : [input.l, pos.l];
    if (mode === "cut") {
      return cutLines(editor, env, l1, l2);
    } else {
      return deleteLines(editor, env, l1, l2);
    }
  } else {
    if (range) {
      const { start, end } = rangeOfSelection(range);
      delRange(editor, env, { anchor: start, active: end });
      return fixPos(editor, start, 0);
    } else {
      return delWithMotion(editor, env, input, pos);
    }
  }
}

function cutOrDelete(mode: "cut" | "delete"): ChordMenu<Pos, Pos> {
  return mapChordMenu(
    (i) => i,
    motions,
    (editor, env, inp) => curOrDeleteMotion(mode, editor, env, inp)
  );
}

export const cuts: ChordKeys<Pos, Pos> = {
  ...simpleKeys({
    s: (editor, env, p) => {
      return delWithMotion(editor, env, p, fixPos(editor, p, 1));
    },
    S: (editor, env, p) => cutLines(editor, env, p.l, p.l),
    C: (editor, env, p) => {
      const line = editor.getLine(p.l);
      return delWithMotion(editor, env, p, { l: p.l, c: line.length });
    },
  }),
  c: {
    type: "menu",
    menu: {
      type: "multi",
      menus: [
        {
          type: "impl",
          impl: {
            type: "keys",
            keys: simpleKeys({
              c: (editor, env, p) => cutLines(editor, env, p.l, p.l),
              w: (editor, env, p) => {
                const motion = forwardWord(editor, p, {
                  whiteOnly: false,
                  stopOnWhite: true,
                });
                return curOrDeleteMotion("cut", editor, env, {
                  input: p,
                  output: motion,
                });
              },
              W: (editor, env, p) => {
                const motion = forwardWord(editor, p, {
                  whiteOnly: true,
                  stopOnWhite: true,
                });
                return curOrDeleteMotion("cut", editor, env, {
                  input: p,
                  output: motion,
                });
              },
            }),
          },
        },
        cutOrDelete("cut"),
      ],
    },
  },
};

function fixDwMotion(motion: MotionResult, editor: Editor) {
  const range = motion.range;
  if (range && range.anchor.l > 0 && range.anchor.c === 0) {
    const l = range.anchor.l - 1;
    range.anchor = { l, c: editor.getLineLength(l) };
  }
}

export const deletes: ChordKeys<Pos, Pos> = {
  ...simpleKeys({
    x: (editor, env, p) => {
      return delWithMotion(editor, env, p, p);
    },
    X: (editor, env, p) => {
      if (p.c === 0) return p;
      const left = fixPos(editor, p, -1);
      return delWithMotion(editor, env, left, left);
    },
    D: (editor, env, p) => {
      const line = editor.getLine(p.l);
      return delWithMotion(editor, env, p, { l: p.l, c: line.length });
    },
  }),
  d: {
    type: "menu",
    menu: {
      type: "multi",
      menus: [
        {
          type: "impl",
          impl: {
            type: "keys",
            keys: simpleKeys({
              d: (editor, env, p) => deleteLines(editor, env, p.l, p.l),
              w: (editor, env, p) => {
                const motion = forwardWord(editor, p, {
                  whiteOnly: false,
                  stopOnLF: true,
                });
                fixDwMotion(motion, editor);
                return curOrDeleteMotion("delete", editor, env, {
                  input: p,
                  output: motion,
                });
              },
              W: (editor, env, p) => {
                const motion = forwardWord(editor, p, {
                  whiteOnly: true,
                  stopOnLF: true,
                });
                fixDwMotion(motion, editor);
                return curOrDeleteMotion("delete", editor, env, {
                  input: p,
                  output: motion,
                });
              },
            }),
          },
        },
        cutOrDelete("delete"),
      ],
    },
  },
};
