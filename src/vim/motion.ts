import { Editor, Pos } from "../editorInterface";
import { Chords } from "./common";

type CharType = "word" | "white" | "other";

const RE_IS_WORD = /\w/;
const RE_IS_WHITE = /\s/;
function getCharType(char: string): CharType {
  if (RE_IS_WORD.test(char[0])) return "word";
  if (RE_IS_WHITE.test(char[0])) return "white";
  return "other";
}

function* iterChar(editor: Editor, p: Pos) {
  const totalLines = editor.getLines();
  for (let l = p.l; l < totalLines; l++) {
    const line = editor.getLine(l);
    let startC = l === p.l ? p.c : 0;
    for (let c = startC; c < line.length; c++) {
      yield { char: line[c], pos: { l, c } };
    }
    if (l + 1 < totalLines) {
      yield { char: "\n", pos: { l, c: line.length } };
    }
  }
}

export const motions: Chords<Pos, Pos> = {
  w: {
    type: "action",
    action: (editor, _options, p: Pos) => {
      // vscodevim default behavior: go to next different type (word, non-word, white) of
      // character, and stop on non-white
      let charType: CharType | null = null;
      for (const { char, pos } of iterChar(editor, p)) {
        const t = getCharType(char);
        if (charType === null) {
          charType = t;
        } else {
          if (char === "\n" && pos.c === 0) {
            // empty new line
            return pos;
          }
          if (charType !== t) {
            if (t !== "white") {
              return pos;
            } else {
              charType = "white";
            }
          }
        }
      }
      return { l: editor.getLines() - 1, c: 0 };
    },
  },
};
