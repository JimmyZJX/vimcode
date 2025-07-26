import { withEditor } from "../../testUtils.js";
import { emptyEnv } from "../common.js";
import { testChangeKeys } from "./change.js";

it("change", () => {
  withEditor(
    __filename,
    " abcde\n  fghij klmnopqrst\n",
    (editor, writeState) => {
      const env = emptyEnv();
      const testKeys = (keys: string[]) => testChangeKeys(editor, keys, env);

      editor.selections = [{ anchor: { l: 0, c: 3 }, active: { l: 0, c: 3 } }];
      editor.cursor = { type: "block" };
      writeState("init");

      testKeys(["D"]);
      writeState("D");

      testKeys(["p"]);
      writeState("p");

      testKeys(["P"]);
      writeState("P");

      testKeys(["d", "j"]);
      writeState("dj");

      testKeys(["p"]);
      writeState("p");

      testKeys(["d", "j"]);
      writeState("dj");

      testKeys(["P"]);
      writeState("P");
    }
  );
});
