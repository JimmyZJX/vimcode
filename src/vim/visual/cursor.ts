import { Editor, Selection } from "../../editorInterface.js";
import { ChordKeymap, Env, simpleKeys } from "../common.js";

function exchangeSelection(_editor: Editor, _env: Env, sel: Selection) {
  return { anchor: sel.active, active: sel.anchor };
}

export const visualCursor: ChordKeymap<Selection, Selection> = {
  ...simpleKeys({
    o: exchangeSelection,
    O: exchangeSelection,
  }),
};
