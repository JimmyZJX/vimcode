import { Editor, Pos } from "../../editorInterface.js";
import {
  ChordKeymap,
  ChordMenu,
  Env,
  KeyChordMenu,
  MappedChordMenu,
  MultiChordMenu,
  simpleKeys,
} from "../common.js";
import { MotionResult, motions } from "../motion/motion.js";
import { forwardWord } from "../motion/word.js";
import { fixDwMotion, getMotionRange } from "./cutDelete.js";

function yankLines(editor: Editor, env: Env, l1: number, l2: number) {
  [l1, l2] = [Math.min(l1, l2), Math.max(l1, l2)];

  const range = {
    anchor: { l: l1, c: 0 },
    active: { l: l2, c: editor.getLineLength(l2) },
  };

  env.globalState.registers.putText(editor, {
    isFullLine: true,
    content: editor.getText(range),
  });
}

function yankMotionImpl(
  editor: Editor,
  env: Env,
  {
    input,
    output: { pos, range, wholeLine },
  }: { input: Pos; output: MotionResult }
): void {
  if (wholeLine) {
    const [l1, l2] = range
      ? [range.anchor.l, range.active.l]
      : [input.l, pos.l];
    yankLines(editor, env, l1, l2);
  } else {
    const r = range ?? getMotionRange(editor, input, pos);
    env.globalState.registers.putText(editor, {
      isFullLine: false,
      content: editor.getText(r),
    });
  }
}

const yankMotion: ChordMenu<Pos, void> = new MappedChordMenu(
  (i) => i,
  motions,
  (editor, env, inp) => yankMotionImpl(editor, env, inp)
);

export const yanks: ChordKeymap<Pos, void> = {
  y: {
    type: "menu",
    menu: new MultiChordMenu<Pos, void>([
      new KeyChordMenu(
        simpleKeys({
          y: (editor, env, p) => yankLines(editor, env, p.l, p.l),
          w: (editor, env, p) => {
            const motion = forwardWord(editor, p, {
              whiteOnly: false,
              stopOnLF: true,
            });
            fixDwMotion(motion, editor);
            return yankMotionImpl(editor, env, {
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
            return yankMotionImpl(editor, env, {
              input: p,
              output: motion,
            });
          },
        })
      ),
      yankMotion,
    ]),
  },
};
