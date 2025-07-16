import { withEditor } from "../testUtils";
import { emptyEnv } from "./common";
import { Vim } from "./vim";

function debugVim(vim: Vim, writeState: (description: string) => void) {
  return (keys: string | string[]) => {
    for (const key of keys) {
      vim.onKey(key);
    }
    writeState([...keys].join(" "));
  };
}

it("insert", () => {
  withEditor(__filename, "abc\n  def\nghi\n", (editor, writeState) => {
    const env = emptyEnv();
    editor.cursor = { type: "block" };
    const vim = new Vim(editor, env);
    writeState("init");

    const type = debugVim(vim, writeState);

    type("lllljl");
    type("cw");
    type("abc");
    type(["<escape>"]);

    type("hv");
    type("ll");
    type("l");
    type("hhh");
    type("d");
  });
});
