import { withEditor } from "../testUtils.js";
import { emptyEnv } from "./common.js";
import { Vim } from "./vim.js";

function debugVim(vim: Vim, writeState: (description: string) => void) {
  return (keys: string | string[]) => {
    for (const key of keys) {
      vim.onKey(key);
    }
    writeState([...keys].join(" "));
  };
}

it("vim mode", () => {
  withEditor(__filename, "abc\n  def\nghi\n", (editor, writeState) => {
    const env = emptyEnv();
    editor.cursor = { type: "block" };
    const vim = new Vim(editor, env);
    writeState("init");

    const type = debugVim(vim, writeState);

    type("lllljl");
    type("cw");
    type("abcd");
    type(["<escape>"]);
    type("i");
    type(["<escape>"]);

    type("hv");
    type("ll");
    type("l");
    type("hhh");
    type("d");
  });
});
