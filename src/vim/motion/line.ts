import { Editor, Pos } from "../../editorInterface.js";
import { ChordKeys, simpleKeys } from "../common.js";
import { getLineWhitePrefix } from "../lineUtil.js";
import { MotionResult } from "./motion.js";

/** suitable for normal mode */
function lineNonWhiteStart(editor: Editor, l: number): MotionResult {
  const line = editor.getLine(l);
  const whiteLength = getLineWhitePrefix(editor, l).length;
  return { pos: { l, c: Math.max(0, Math.min(line.length - 1, whiteLength)) } };
}

const lineStartEnd: ChordKeys<Pos, MotionResult> = simpleKeys({
  "0": (_editor, _env, p) => {
    return { pos: { l: p.l, c: 0 } };
  },
  "^": (editor, _env, p) => {
    return lineNonWhiteStart(editor, p.l);
  },
  $: (editor, _env, p) => {
    return {
      pos: { l: p.l, c: editor.getLineLength(p.l) },
      range: {
        anchor: { l: p.l, c: p.c },
        active: { l: p.l, c: Math.max(0, editor.getLineLength(p.l) - 1) },
      },
    };
  },
});

export const lineMotions: ChordKeys<Pos, MotionResult> = {
  g: {
    type: "menu",
    menu: {
      type: "impl",
      impl: {
        type: "keys",
        keys: {
          ...lineStartEnd,
          ...simpleKeys({
            g: (editor, _env, _p) => {
              return { ...lineNonWhiteStart(editor, 0), wholeLine: true };
            },
            _: (editor, _env, p) => {
              return {
                pos: { l: p.l, c: Math.max(0, editor.getLineLength(p.l) - 1) },
                wholeLine: true,
              };
            },
          }),
        },
      },
    },
  },
  ...lineStartEnd,

  ...simpleKeys({
    G: (editor, _env, _p) => {
      const lines = editor.getLines();
      return {
        ...lineNonWhiteStart(editor, Math.max(0, lines - 1)),
        wholeLine: true,
      };
    },
    "+": (editor, _env, p) => {
      const l = Math.max(0, Math.min(editor.getLines() - 1, p.l + 1));
      return { ...lineNonWhiteStart(editor, l), wholeLine: true };
    },
    "-": (editor, _env, p) => {
      const l = Math.max(0, Math.min(editor.getLines() - 1, p.l - 1));
      return { ...lineNonWhiteStart(editor, l), wholeLine: true };
    },
  }),
};
