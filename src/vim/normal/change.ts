import { Pos } from "../../editorInterface.js";
import { ChordKeys, simpleKeys } from "../common.js";
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
    })
}
