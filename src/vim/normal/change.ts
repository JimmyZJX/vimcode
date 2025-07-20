import { Pos } from "../../editorInterface";
import { ChordKeys } from "../common";
import { deletes } from "./cutDelete";

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
}