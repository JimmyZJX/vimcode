import { Editor, Pos } from "../../editorInterface";
import { Action, Chords, Env, Options } from "../common";
import { left, right, upDown } from "./basic";
import { back, forwardEnd, forwardWord } from "./word";

const actions: Record<string, Action<Pos, Pos>> = {
  h: (editor, _env, p: Pos) => left(editor, p),
  l: (editor, _env, p: Pos) => right(editor, p),
  k: (editor, env, p: Pos) => upDown(editor, env, p, "up"),
  j: (editor, env, p: Pos) => upDown(editor, env, p, "down"),

  // vscodevim default behavior: go to next different type (word, non-word, white)
  // of character, and stop on non-white
  w: (editor, _env, p: Pos) => forwardWord(editor, p, false),
  W: (editor, _env, p: Pos) => forwardWord(editor, p, true),
  e: (editor, _env, p: Pos) => forwardEnd(editor, p, false),
  E: (editor, _env, p: Pos) => forwardEnd(editor, p, true),
  b: (editor, _env, p: Pos) => back(editor, p, false),
  B: (editor, _env, p: Pos) => back(editor, p, true),
};

export const motions: Chords<Pos, Pos> = {
  ...Object.fromEntries(
    Object.entries(actions).map(([k, action]) => [
      k,
      { type: "action", action },
    ])
  ),
};

export function runKeysInTest(editor: Editor, keys: string[], env?: Env): void {
  // TODO normal mode, single cursor for now
  env ??= { options: {}, flash: {} };

  let cur = motions;
  for (const k of keys) {
    const entry = cur[k];
    if (entry === undefined) {
      throw new Error("Chords not found: " + keys.join(" "));
    }
    if (entry.type === "menu") {
      cur = entry.chords;
    } else {
      const sel = editor.selections[0];
      const oldFlash = env.flash;
      const pos = entry.action(editor, env, sel.active);
      if (env.flash === oldFlash) {
        env.flash = {};
      }
      editor.selections = [{ anchor: pos, active: pos }];
      cur = motions;
    }
  }

  if (cur !== motions) {
    throw new Error("Chords not fully applied: " + keys.join(" "));
  }
}
