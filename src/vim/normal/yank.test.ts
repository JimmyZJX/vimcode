import { Editor, Pos } from "../../editorInterface";
import { withEditor } from "../../testUtils";
import { emptyEnv, Env, mapChordMenu, testKeys } from "../common";
import { fixNormalCursor } from "../modeUtil";
import { changes } from "./change";
import { yanks } from "./yank";

async function testChangeAndYankKeys(
  editor: Editor,
  keys: string[],
  env?: Env
): Promise<void> {
  await testKeys({
    editor,
    keys,
    chords: {
      type: "multi",
      menus: [
        { type: "impl", impl: { type: "keys", keys: changes } },
        mapChordMenu(
          (i: Pos) => i,
          { type: "impl", impl: { type: "keys", keys: yanks } },
          (_editor, _env, { input, output: _ }: { input: Pos; output: void }) =>
            input
        ),
      ],
    },
    getInput: () => editor.selections[0].active,
    onOutput: (pos) => {
      editor.cursor = { type: "block" };
      const p = fixNormalCursor(editor, pos);
      editor.selections = [{ anchor: p, active: p }];
    },
    env: env ?? emptyEnv(),
  });
}

it("change", () => {
  withEditor(
    __filename,
    "abcde\n  fghij klmnopqrst\n",
    async (editor, writeState) => {
      const env = emptyEnv();
      const testKeys = (keys: string[]) =>
        testChangeAndYankKeys(editor, keys, env);

      editor.selections = [{ anchor: { l: 0, c: 3 }, active: { l: 0, c: 3 } }];
      editor.cursor = { type: "block" };
      writeState("init");

      testKeys(["y", "y"]);
      writeState("yy");

      await testKeys(["p"]);
      writeState("p");

      await testKeys(["P"]);
      writeState("P");

      testKeys(["d", "j"]);
      writeState("dj");

      editor.selections = [{ anchor: { l: 0, c: 3 }, active: { l: 0, c: 3 } }];
      writeState("reset");

      testKeys(["y", "w"]);
      writeState("yw");

      await testKeys(["p"]);
      writeState("p");

      testKeys(["y", "j"]);
      writeState("yj");

      await testKeys(["p"]);
      writeState("p");
    }
  );
});
