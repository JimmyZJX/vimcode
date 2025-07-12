import { Pos } from "../../editorInterface";
import { Chords } from "../common";
import { forwardWord } from "./word";

export const motions: Chords<Pos, Pos> = {
  w: {
    type: "action",
    action: (editor, _options, p: Pos) => {
      // vscodevim default behavior: go to next different type (word, non-word, white) of
      // character, and stop on non-white
      return forwardWord(editor, p, false);
    },
  },
  W: {
    type: "action",
    action: (editor, _options, p: Pos) => {
      return forwardWord(editor, p, true);
    },
  },
};
