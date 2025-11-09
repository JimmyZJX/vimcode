import { Editor, Pos } from "../../editorInterface.js";
import {
  ChordKeys,
  DelayedAction,
  emptyEnv,
  Env,
  simpleKeys,
  testKeys,
} from "../common.js";
import { getLineWhitePrefix } from "../lineUtil.js";
import { fixCursorPosition } from "../modeUtil.js";
import { deletes } from "./cutDelete.js";

function paste(mode: "before" | "after"): DelayedAction<Pos, Pos> {
  return (k) =>
    k(
      async (editor: Editor, env: Env, p: Pos) => {
        const registerText = await env.globalState.registers.getText(editor);
        return { p, registerText };
      },
      (editor: Editor, _env: Env, { p, registerText }) => {
        if (registerText === undefined) {
          return { l: p.l, c: p.c };
        }
        if (registerText.isFullLine) {
          if (mode === "before") {
            const lineStart = { l: p.l, c: 0 };
            editor.editText(
              { anchor: lineStart, active: lineStart },
              registerText.content + "\n"
            );
            return { l: p.l, c: getLineWhitePrefix(editor, p.l).length };
          } else {
            // after
            const lineLen = editor.getLineLength(p.l);
            editor.editText(
              {
                anchor: { l: p.l, c: lineLen },
                active: { l: p.l, c: lineLen },
              },
              "\n" + registerText.content
            );
            return {
              l: p.l + 1,
              c: getLineWhitePrefix(editor, p.l + 1).length,
            };
          }
        } else {
          const pos = mode === "before" ? p : fixCursorPosition(editor, p, { mode: 'insert', offset: 1 });
          const content = registerText.content;
          editor.editText({ anchor: pos, active: pos }, content);
          const lineOffset = (content.match(/\n/g) || "").length;
          const col =
            lineOffset === 0
              ? p.c + content.length + (mode === "before" ? 0 : 1)
              : content.length - content.lastIndexOf("\n") - 1;
          return { l: p.l + lineOffset, c: col };
        }
      }
    );
}

export const changes: ChordKeys<Pos, Pos> = {
  ...deletes,
  p: { type: "delayed", delayed: paste("after") },
  P: { type: "delayed", delayed: paste("before") },
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

export const changesCursorNeutral: ChordKeys<void, void> = {
  ...simpleKeys({
    u: (editor, _env, _void) => editor.real_undo(),
    "C-r": (editor, _env, _void) => editor.real_redo(),
  }),
};

export async function testChangeKeys(
  editor: Editor,
  keys: string[],
  env?: Env
): Promise<void> {
  await testKeys({
    editor,
    keys,
    chords: { type: "impl", impl: { type: "keys", keys: changes } },
    getInput: () => editor.selections[0].active,
    onOutput: (pos) => {
      editor.cursor = { type: "block" };
      const p = fixCursorPosition(editor, pos, { mode: 'normal' });
      editor.selections = [{ anchor: p, active: p }];
    },
    env: env ?? emptyEnv(),
  });
}
