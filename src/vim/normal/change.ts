import { Editor, Pos } from "../../editorInterface.js";
import { ChordKeys, emptyEnv, Env, simpleKeys, testKeys } from "../common.js";
import { fixNormalCursor } from "../modeUtil.js";
import { deletes } from "./cutDelete.js";

export const changes: ChordKeys<Pos, Pos> = {
  ...deletes,
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

export function testChangeKeys(
  editor: Editor,
  keys: string[],
  env?: Env
): void {
  testKeys({
    editor,
    keys,
    chords: { type: "impl", impl: { type: "keys", keys: changes } },
    getInput: () => editor.selections[0].active,
    onOutput: (pos) => {
      editor.cursor = { type: "block" };
      const p = fixNormalCursor(editor, pos);
      editor.selections = [{ anchor: p, active: p }];
    },
    env: env ?? emptyEnv(),
  });
}
