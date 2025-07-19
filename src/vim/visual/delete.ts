import {
  Editor,
  Pos,
  rangeOfSelection,
  Selection,
} from "../../editorInterface.js";
import { ChordKeys, Env, simpleKeys } from "../common.js";
import { getLineWhitePrefix } from "../lineUtil.js";

function fixRegionEnd(editor: Editor, p: Pos): Pos {
  const lines = editor.getLines();
  const line = editor.getLine(p.l);
  if (p.c >= line.length) {
    if (p.l >= lines - 1) {
      return { l: p.l, c: p.c };
    }
    return { l: p.l + 1, c: 0 };
  }
  return { l: p.l, c: p.c + 1 };
}

function getVisualRange(editor: Editor, sel: Selection) {
  const { start, end } = rangeOfSelection(sel);
  return { start, end: fixRegionEnd(editor, end) };
}

function deleteRegion(editor: Editor, _env: Env, sel: Selection) {
  const { start, end } = getVisualRange(editor, sel);
  editor.editText({ anchor: start, active: end }, "");
  return rangeOfSelection(sel).start;
}

function deleteLine(editor: Editor, _env: Env, sel: Selection) {
  const { start, end } = rangeOfSelection(sel);
  const endOfLine =
    end.l + 1 >= editor.getLines()
      ? { l: end.l, c: editor.getLineLength(end.l) }
      : { l: end.l + 1, c: 0 };
  const deleteRange = { anchor: { l: start.l, c: 0 }, active: endOfLine };
  editor.editText(deleteRange, "");
  const toLine = Math.max(0, start.l - 1);
  return { l: toLine, c: getLineWhitePrefix(editor, toLine).length };
}

export const visualDelete: ChordKeys<Selection, Pos> = {
  ...simpleKeys({
    x: deleteRegion,
    d: deleteRegion,
    X: deleteLine,
    D: deleteLine,
  }),
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
            action: (editor, _env, sel) => {
              const { start, end } = getVisualRange(editor, sel);
              const text = editor.getText({ anchor: start, active: end });
              const edited = text.replace(/[^\n]/g, key);
              editor.editText({ anchor: start, active: end }, edited);
              return start;
            },
          };
        },
      },
    },
  },
};
