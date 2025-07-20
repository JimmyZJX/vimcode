import { Editor, Pos, Selection } from "../../editorInterface.js";
import {
  Action,
  ChordKeys,
  emptyEnv,
  Env,
  simpleKeys,
  testKeys,
} from "../common.js";
import { left, right, upDown } from "./basic.js";
import { lineMotions } from "./line.js";
import { back, forwardEnd, forwardWord } from "./word.js";

// TODO motion has a "preferred interpretation"
// type Interpretation =
//   | { type: "line" }
//   | { type: "char" }
//   | { type: "charAfter" }
//   | { type: "charBefore" };

// {type:"pos", pos:Pos} | {type:"range", range:Range} | {type:"none"} (ftFT)

export type MotionResult = {
  pos: Pos;
  range?: Selection; // sort first, and interpret as [start, end)
  wholeLine?: boolean;
};

const actions: Record<string, Action<Pos, MotionResult>> = {
  h: (editor, _env, p: Pos) => left(editor, p),
  l: (editor, _env, p: Pos) => right(editor, p),
  k: (editor, env, p: Pos) => upDown(editor, env, p, "up"),
  j: (editor, env, p: Pos) => upDown(editor, env, p, "down"),

  // vscodevim default behavior: go to next different type (word, non-word, white)
  // of character, and stop on non-white
  w: (editor, _env, p: Pos) => forwardWord(editor, p, { whiteOnly: false }),
  W: (editor, _env, p: Pos) => forwardWord(editor, p, { whiteOnly: true }),
  e: (editor, _env, p: Pos) => forwardEnd(editor, p, false),
  E: (editor, _env, p: Pos) => forwardEnd(editor, p, true),
  b: (editor, _env, p: Pos) => back(editor, p, false),
  B: (editor, _env, p: Pos) => back(editor, p, true),
};

export const motions: ChordKeys<Pos, MotionResult> = {
  ...simpleKeys(actions),
  ...lineMotions,
};

export function testMotionKeys(
  editor: Editor,
  keys: string[],
  env?: Env
): void {
  testKeys({
    editor,
    keys,
    chords: { type: "impl", impl: { type: "keys", keys: motions } },
    getInput: () => editor.selections[0].active,
    onOutput: ({ pos }) => (editor.selections = [{ anchor: pos, active: pos }]),
    env: env ?? emptyEnv(),
  });
}
