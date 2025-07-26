import { Editor, fixPos, Pos } from "../../editorInterface.js";
import { ChordKeys, emptyEnv, Env, simpleKeys, testKeys } from "../common.js";
import { getLineWhitePrefix } from "../lineUtil.js";
import { fixNormalCursor } from "../modeUtil.js";
import { deletes } from "./cutDelete.js";

function paste(
  editor: Editor,
  env: Env,
  p: Pos,
  mode: "before" | "after"
): Pos {
  const registerText = env.globalState.registers.getText(editor);
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
        { anchor: { l: p.l, c: lineLen }, active: { l: p.l, c: lineLen } },
        "\n" + registerText.content
      );
      return { l: p.l + 1, c: getLineWhitePrefix(editor, p.l + 1).length };
    }
  } else {
    const pos = mode === "before" ? p : fixPos(editor, p, 1);
    editor.editText({ anchor: pos, active: pos }, registerText.content);
  }
  return { l: p.l, c: p.c };
}

export const changes: ChordKeys<Pos, Pos> = {
  ...deletes,
  ...simpleKeys({
    p: (editor, env, p) => {
      return paste(editor, env, p, "before");
    },
    P: (editor, env, p) => {
      return paste(editor, env, p, "after");
    },
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
