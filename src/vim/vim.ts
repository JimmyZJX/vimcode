import { Editor, fixPos, Pos, Selection } from "../editorInterface.js";
import { ChordMenu, Env, followKey, mapChordMenu } from "./common.js";
import {
  fixNormalCursor,
  visualFromEditor,
  visualToEditor,
} from "./modeUtil.js";
import { motions } from "./motion/motion.js";
import { changes, changesCursorNeutral } from "./normal/change.js";
import { inserts } from "./normal/insert.js";
import { yanks } from "./normal/yank.js";
import { visualCursor } from "./visual/cursor.js";
import { visualDelete } from "./visual/delete.js";
import { visualInsert } from "./visual/insert.js";

// TODO for VSCode: click cursor should be corrected to block cursor instead of line
// cursor

export type Mode = "normal" | "insert" | "visual" | "normal+" | "visual+";

type NormalModeResult = { pos?: Pos; toMode: "normal" | "insert" | "visual" };
type VisualModeResult = {
  active?: Pos;
  anchor?: Pos;
  toMode: "visual" | "normal" | "insert";
};

type State =
  | {
      mode: "normal";
      menu: ChordMenu<Pos, NormalModeResult> | undefined;
    }
  | {
      mode: "visual";
      menu: ChordMenu<Selection, VisualModeResult> | undefined;
    }
  | { mode: "insert" }; // TODO insert chords

// TODO on macro execution, wait for delayed token
class DelayedToken {}

export class Vim {
  constructor(readonly editor: Editor, readonly env: Env) {
    editor.cursor = { type: "block" };
  }

  private state: State = { mode: "normal", menu: undefined };
  private lastDelayed: DelayedToken | undefined = undefined;

  public fixState() {
    // insert is still insert, even if there's selection
    if (this.state.mode === "insert") {
      this.editor.cursor = { type: "line" };
      return;
    }

    if (this.state.mode === "normal") {
      const { anchor, active } = this.editor.selections[0];
      if (anchor.l !== active.l || anchor.c !== active.c) {
        // normal -> visual
        this.state = { mode: "visual", menu: undefined };
      }
    }
    if (this.state.mode === "visual") {
      const { anchor, active } = this.editor.selections[0];
      if (anchor.l === active.l && anchor.c === active.c) {
        // visual -> normal
        const fixed = fixNormalCursor(this.editor, anchor);
        this.editor.selections = [{ anchor: fixed, active: fixed }];
        this.state = { mode: "normal", menu: undefined };
      }
    }

    if (this.state.mode === "normal") {
      this.editor.cursor = { type: "block" };
    } else if (this.state.mode === "visual") {
      this.editor.cursor = { type: "line" };
    }
  }

  public isPending() {
    if (this.state.mode === "insert") return false;
    return this.state.menu !== undefined;
  }

  private static normalMenus: ChordMenu<Pos, NormalModeResult> = {
    type: "multi",
    menus: [
      mapChordMenu(
        (i) => i,
        {
          type: "impl",
          impl: { type: "keys", keys: changes },
        },
        (_editor, _env, { input: _, output }) => ({
          pos: output,
          toMode: "normal",
        })
      ),
      mapChordMenu(
        (i) => i,
        motions,
        (_editor, _env, { input: _, output: { pos } }) => ({
          pos,
          toMode: "normal",
        })
      ),
      mapChordMenu(
        (i) => {},
        {
          type: "impl",
          impl: { type: "keys", keys: changesCursorNeutral },
        },
        (_editor, _env, { input: _inp, output: _outp }) => ({
          pos: undefined,
          toMode: "normal",
        })
      ),
      mapChordMenu(
        (i) => i,
        {
          type: "impl",
          impl: { type: "keys", keys: yanks },
        },
        (_editor, _env, { input: _inp, output: _outp }) => ({
          pos: undefined,
          toMode: "normal",
        })
      ),
      mapChordMenu(
        (i) => i,
        { type: "impl", impl: { type: "keys", keys: inserts } },
        (_editor, _env, { input: _, output }) => ({
          pos: output,
          toMode: "insert",
        })
      ),
      {
        type: "impl",
        impl: {
          type: "keys",
          keys: {
            v: {
              type: "action",
              action: (_editor, _env, p) => ({ pos: p, toMode: "visual" }),
            },
          },
        },
      },
    ],
  };

  private static visualMenus: ChordMenu<Selection, VisualModeResult> = {
    type: "multi",
    menus: [
      mapChordMenu(
        ({ anchor: _, active }) => active,
        motions,
        (_editor, _env, { input: _, output: { pos } }) => ({
          active: pos,
          toMode: "visual",
        })
      ),
      mapChordMenu(
        (i) => i,
        {
          type: "impl",
          impl: { type: "keys", keys: visualDelete },
          // TODO keys like "xX" behaves very differently
        },
        (_editor, _env, { input: _, output }) => ({
          active: output,
          toMode: "normal",
        })
      ),
      mapChordMenu(
        (i) => {},
        {
          type: "impl",
          impl: { type: "keys", keys: changesCursorNeutral },
        },
        (_editor, _env, { input: _inp, output: _outp }) => ({
          pos: undefined,
          toMode: "normal",
        })
      ),
      mapChordMenu(
        (i) => i,
        { type: "impl", impl: { type: "keys", keys: visualInsert } },
        (_editor, _env, { input: _, output }) => ({
          active: output,
          toMode: "insert",
        })
      ),
      mapChordMenu(
        (i) => i,
        { type: "impl", impl: { type: "keys", keys: visualCursor } },
        (_editor, _env, { input: _, output }) => ({
          active: output.active,
          anchor: output.anchor,
          toMode: "visual",
        })
      ),
      {
        type: "impl",
        impl: {
          type: "keys",
          keys: {
            "<escape>": {
              type: "action",
              action: (_editor, _env, { anchor: _, active }) => ({
                active,
                toMode: "normal",
              }),
            },
          },
        },
      },
    ],
  };

  private static withEnv<O>(env: Env, action: () => O): O {
    // clear flash on top-level chords
    const oldFlash = env.flash;
    const output = action();
    if (env.flash === oldFlash) {
      env.flash = {};
    }
    return output;
  }

  private runVisual(
    key: string,
    state: Extract<State, { mode: "visual" }>
  ): State & { processed: boolean } {
    const visualSelection = visualFromEditor(
      this.editor,
      this.editor.selections[0]
    );
    const getInput = () => visualSelection;
    const r = followKey(
      state.menu ?? Vim.visualMenus,
      getInput(),
      key,
      this.editor,
      this.env
    );
    if (r === undefined) {
      // TODO LOG key not found
      return { processed: false, mode: "visual", menu: undefined };
    }
    if (r.type === "menu") {
      return { processed: true, mode: "visual", menu: r.menu };
    }

    const onVisualResult = ({
      active,
      anchor,
      toMode,
    }: VisualModeResult): State => {
      if (toMode === "normal") {
        // TODO global fix to hook, also when mode is changed TO normal
        if (active) {
          const fixed = fixNormalCursor(this.editor, active);
          this.editor.cursor = { type: "block" };
          this.editor.selections = [{ anchor: fixed, active: fixed }];
        }
        return { mode: "normal", menu: undefined };
      } else if (toMode === "visual") {
        if (active) {
          this.editor.selections = [
            visualToEditor(this.editor, {
              anchor: anchor ?? visualSelection.anchor,
              active,
            }),
          ];
        }
        // TODO "blockBefore" cursor type (non-blinking)
        // TODO depending on the order of anchor/active!
        this.editor.cursor = { type: "line" };
        return { mode: "visual", menu: undefined };
      } else {
        // toMode === "insert"
        if (active) {
          this.editor.selections = [{ anchor: active, active }];
        }
        this.editor.cursor = { type: "line" };
        return { mode: "insert" };
      }
    };

    if (r.type === "action") {
      const visualResult = Vim.withEnv(this.env, () =>
        r.action(this.editor, this.env, getInput())
      );
      return { processed: true, ...onVisualResult(visualResult) };
    } else {
      // "delayed"
      const delayedToken = new DelayedToken();
      this.lastDelayed = delayedToken;
      r.delayed((prepare, delayed) => {
        prepare(this.editor, this.env, getInput()).then((delayedInput) => {
          if (this.lastDelayed === delayedToken) {
            const visualResult = Vim.withEnv(this.env, () =>
              delayed(this.editor, this.env, delayedInput)
            );
            this.state = onVisualResult(visualResult);
          }
        });
      });

      return { processed: true, ...state };
    }
  }

  private runNormal(
    key: string,
    state: Extract<State, { mode: "normal" }>
  ): State & { processed: boolean } {
    const getInput = () => this.editor.selections[0].active;
    const r = followKey(
      state.menu ?? Vim.normalMenus,
      getInput(),
      key,
      this.editor,
      this.env
    );
    if (r === undefined) {
      // TODO LOG key not found
      return { processed: false, mode: "normal", menu: undefined };
    }
    if (r.type === "menu") {
      return { processed: true, mode: "normal", menu: r.menu };
    }

    const onNormalResult = ({ pos, toMode }: NormalModeResult): State => {
      if (toMode === "normal") {
        // TODO global fix to hook, also when mode is changed TO normal
        if (pos) {
          const fixed = fixNormalCursor(this.editor, pos);
          this.editor.selections = [{ anchor: fixed, active: fixed }];
        }
        return { mode: "normal", menu: undefined };
      } else if (toMode === "visual") {
        // only possible via "v" for now
        if (pos) {
          this.editor.selections = [
            { anchor: pos, active: fixPos(this.editor, pos, 1) },
          ];
        }
        // TODO "blockBefore" cursor type (non-blinking)
        // TODO depending on the order of anchor/active!
        this.editor.cursor = { type: "line" };
        return { mode: "visual", menu: undefined };
      } else {
        // toMode === "insert"
        if (pos) {
          this.editor.selections = [{ anchor: pos, active: pos }];
        }
        this.editor.cursor = { type: "line" };
        return { mode: "insert" };
      }
    };

    if (r.type === "action") {
      const normalResult = Vim.withEnv(this.env, () =>
        r.action(this.editor, this.env, getInput())
      );
      return { processed: true, ...onNormalResult(normalResult) };
    } else {
      // "delayed"
      const delayedToken = new DelayedToken();
      this.lastDelayed = delayedToken;
      r.delayed((prepare, delayed) => {
        prepare(this.editor, this.env, getInput()).then((delayedInput) => {
          if (this.lastDelayed === delayedToken) {
            const normalResult = Vim.withEnv(this.env, () =>
              delayed(this.editor, this.env, delayedInput)
            );
            // TODO this should trigger some onStateChange callbacks...
            this.state = onNormalResult(normalResult);
          }
        });
      });

      return { processed: true, ...state };
    }
  }

  private _onKey(key: string): boolean {
    switch (this.state.mode) {
      case "visual": {
        // check if selection is forward or backward
        const { processed, ...state } = this.runVisual(key, this.state);
        this.state = state;
        return processed;
      }
      case "normal": {
        const { processed, ...state } = this.runNormal(key, this.state);
        this.state = state;
        return processed || key.length === 1;
      }
      case "insert": {
        if (key === "<escape>") {
          this.editor.cursor = { type: "block" };
          const active = this.editor.selections[0].active;
          const fixed = fixNormalCursor(
            this.editor,
            fixPos(this.editor, active, -1)
          );
          this.editor.selections = [{ anchor: fixed, active: fixed }];
          this.state = { mode: "normal", menu: undefined };
          return true;
        } else {
          if (!this.editor.isFake) return false;

          // don't handle any key in the real VSCode environment
          const sel = this.editor.selections[0];
          this.editor.editText(sel, key);
          const newPos = { l: sel.active.l, c: sel.active.c + 1 };
          this.editor.selections = [{ anchor: newPos, active: newPos }];
          return true;
        }
      }
      default: {
        const state: never = this.state;
        throw new Error(`Unexpected state ${(state as any).mode}`);
      }
    }
  }

  public onKey(key: string): boolean {
    const processed = this._onKey(key);
    this.env.globalState.registers.onAfterKeyProcessed(this.mode);
    return processed;
  }

  public get mode(): Mode {
    if (this.state.mode === "insert") {
      return "insert";
    } else if (this.state.mode === "normal") {
      return this.state.menu === undefined ? "normal" : "normal+";
    } else {
      // this.state.mode === "visual) {
      return this.state.menu === undefined ? "visual" : "visual+";
    }
  }
}
