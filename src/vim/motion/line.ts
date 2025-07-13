import { Editor, Pos } from "../../editorInterface";
import { Chords, simpleKeys } from "../common";
import { getLineWhitePrefix } from "../lineUtil";

// TODO all calls to `getLineWhitePrefix` might be wrong if the line is all white spaces
function lineNonWhiteStart(editor: Editor, l: number) {
  const line = editor.getLine(l);
  const whiteLength = getLineWhitePrefix(editor, l).length;
  return { l, c: Math.max(0, Math.min(line.length - 1, whiteLength)) };
}

const lineStartEnd: Chords<Pos, Pos>["keys"] = simpleKeys({
  "0": (_editor, _env, p) => {
    return { l: p.l, c: 0 };
  },
  "^": (editor, _env, p) => {
    return lineNonWhiteStart(editor, p.l);
  },
  $: (editor, _env, p) => {
    return { l: p.l, c: editor.getLine(p.l).length };
  },
});

export const lineMotions: Chords<Pos, Pos>["keys"] = {
  g: {
    type: "menu",
    chords: {
      keys: {
        ...lineStartEnd,
        ...simpleKeys({
          g: (editor, _env, _p) => {
            return lineNonWhiteStart(editor, 0);
          },
          _: (editor, _env, p) => {
            return { l: p.l, c: Math.max(0, editor.getLine(p.l).length - 1) };
          },
        }),
      },
    },
  },
  ...lineStartEnd,
  ...simpleKeys({
    G: (editor, _env, _p) => {
      const lines = editor.getLines();
      return lineNonWhiteStart(editor, Math.max(0, lines - 1));
    },
    "+": (editor, _env, p) => {
      const l = Math.max(0, Math.min(editor.getLines() - 1, p.l + 1));
      return lineNonWhiteStart(editor, l);
    },
    "-": (editor, _env, p) => {
      const l = Math.max(0, Math.min(editor.getLines() - 1, p.l - 1));
      return lineNonWhiteStart(editor, l);
    },
  }),
};
