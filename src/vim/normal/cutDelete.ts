import {
  comparePos,
  Editor,
  fixPos,
  Pos,
  Selection,
} from "../../editorInterface";
import {
  Action,
  ChordKeys,
  ChordMenu,
  Env,
  mapChordMenu,
  simpleKeys,
} from "../common";
import { getLineWhitePrefix } from "../lineUtil";
import { motions } from "../motion/motion";
import { getCharType } from "../motion/word";

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

function cutCurrentLine(editor: Editor, env: Env, p: Pos) {
  const line = editor.getLine(p.l);
  const prefix = getLineWhitePrefix(editor, p.l);
  delWithMotion(editor, env, { l: p.l, c: 0 }, { l: p.l, c: line.length });
  editor.editText(
    { anchor: { l: p.l, c: 0 }, active: { l: p.l, c: 0 } },
    prefix
  );
  return { l: p.l, c: prefix.length };
}

function deleteCurrentLine(editor: Editor, env: Env, p: Pos) {
  const lines = editor.getLines();
  const curLine = editor.getLine(p.l);
  if (p.l >= lines - 1) {
    if (p.l === 0) {
      // only one line
      editor.editText(
        {
          anchor: { l: 0, c: 0 },
          active: { l: 0, c: editor.getLine(0).length },
        },
        ""
      );
      return { l: 0, c: 0 };
    } else {
      // remove last line
      const lastLine = editor.getLine(p.l - 1);
      editor.editText(
        {
          anchor: { l: p.l - 1, c: lastLine.length },
          active: { l: p.l, c: curLine.length },
        },
        ""
      );
      return { l: p.l - 1, c: getLineWhitePrefix(editor, p.l - 1).length };
    }
  } else {
    // remove current line
    editor.editText(
      { anchor: { l: p.l, c: 0 }, active: { l: p.l + 1, c: 0 } },
      ""
    );
    return { l: p.l, c: getLineWhitePrefix(editor, p.l).length };
  }
}

function cutOrDelete(
  actions: Record<string, Action<Pos, Pos> | undefined>
): ChordMenu<Pos, Pos> {
  return {
    type: "multi",
    menus: [
      {
        type: "impl",
        impl: {
          type: "keys",
          keys: simpleKeys({
            // TODO instead, implement motion with different modes (as context)
            /* c{w,W} is c{e,E} when cursor is not on whitespace */
            w: delMotionW("e", "w"),
            W: delMotionW("E", "W"),
            ...actions,
          }),
        },
      },
      mapChordMenu(
        (i) => i,
        { type: "impl", impl: { type: "keys", keys: motions } },
        (editor, env, { input, output }) => {
          return delWithMotion(editor, env, input, output);
        }
      ),
    ],
  };
}

export const cuts: ChordKeys<Pos, Pos> = {
  ...simpleKeys({
    s: (editor, env, p) => {
      return delWithMotion(editor, env, p, fixPos(editor, p, 1));
    },
    S: cutCurrentLine,
    C: (editor, env, p) => {
      const line = editor.getLine(p.l);
      return delWithMotion(editor, env, p, { l: p.l, c: line.length });
    },
  }),
  c: { type: "menu", menu: cutOrDelete({ c: cutCurrentLine }) },
};

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
    menu: cutOrDelete({
      d: deleteCurrentLine,
    }),
  },
  r: {
    type: "menu",
    menu: {
      type: "impl",
      impl: {
        type: "fn",
        fn: (_editor, _env, { key, input: _ }) => {
          if (key.length > 1) return undefined;
          return {
            type: "action",
            action: (editor, _env, p) => {
              const line = editor.getLine(p.l);
              if (p.c < line.length) {
                editor.editText(
                  { anchor: p, active: { l: p.l, c: p.c + 1 } },
                  key
                );
              }
              return { l: p.l, c: p.c };
            },
          };
        },
      },
    },
  },
};
