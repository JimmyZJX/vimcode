import {
  Editor,
  fixPos,
  Pos,
  rangeOfSelection,
  Selection,
} from "../../editorInterface.js";
import { ChordKeys, Env, simpleKeys } from "../common.js";
import { delRange } from "../normal/cutDelete.js";

function cutRange(editor: Editor, env: Env, sel: Selection) {
  const { start, end } = rangeOfSelection(sel);
  delRange(editor, env, { anchor: start, active: fixPos(editor, end, 1) });
  return start;
}

export const visualInsert: ChordKeys<Selection, Pos> = {
  ...simpleKeys({
    A: (editor, _env, sel) => {
      const { start: _, end } = rangeOfSelection(sel);
      return fixPos(editor, end, 1);
    },
    I: (_editor, _env, sel) => {
      const { start, end: _ } = rangeOfSelection(sel);
      return start;
    },
    s: cutRange,
    c: cutRange,
  }),
};
