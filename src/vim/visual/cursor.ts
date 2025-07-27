import { Editor, Selection } from "../../editorInterface.js";
import { ChordKeys, Env, simpleKeys } from "../common.js";

function exchangeSelection(_editor: Editor, _env: Env, sel: Selection) {
  return { anchor: sel.active, active: sel.anchor };
}

export const visualCursor: ChordKeys<Selection, Selection> = {
  ...simpleKeys({
    o: exchangeSelection,
    O: exchangeSelection,
  }),
};
