import { Editor, fixPos, Pos, Selection } from "../editorInterface.js";
import { ChordMenu, Env, followKey, mapChordMenu } from "./common.js";
import { fixNormalCursor, visualFromEditor, visualToEditor } from "./modeUtil.js";
import { motions } from "./motion/motion.js";
import { changes } from "./normal/change.js";
import { inserts } from "./normal/insert.js";
import { visualDelete } from "./visual/delete.js";

// TODO for VSCode: click cursor should be corrected to block cursor instead of line
// cursor

export type Mode = "normal" | "insert" | "visual" | "normal+" | "visual+";

type NormalModeResult = { pos: Pos; toMode: "normal" | "insert" | "visual" };
type VisualModeResult = { active: Pos; toMode: "visual" | "normal" | "insert" };

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

export class Vim {
  constructor(readonly editor: Editor, readonly env: Env) {
    editor.cursor = { "type": "block" };
  }

  private state: State = { mode: "normal", menu: undefined };

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
          impl: { type: "keys", keys: { ...motions, ...changes } },
        },
        (_editor, _env, { input: _, output }) => ({
          pos: output,
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
        {
          type: "impl",
          impl: { type: "keys", keys: motions },
        },
        (_editor, _env, { input: _, output }) => ({
          active: output,
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
      // mapChordMenu(
      //   (i) => i,
      //   { type: "impl", impl: { type: "keys", keys: inserts } },
      //   (_editor, _env, { input: _, output }) => ({
      //     active: output,
      //     toMode: "insert",
      //     // TODO keys like "sSiaIA" behaves very differently
      //   })
      // ),
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

  private runKey<I, O>(menu: ChordMenu<I, O>, getInput: () => I, key: string) {
    const r = followKey(menu, getInput(), key, this.editor, this.env);
    if (r === undefined) return undefined;
    if (r.type === "menu") { return r; }
    else {
      // r.type === "action"
      // clear flash on top-level chords
      const oldFlash = this.env.flash;
      const output = r.action(this.editor, this.env, getInput());
      if (this.env.flash === oldFlash) {
        this.env.flash = {};
      }
      return { type: "output" as const, output };
    }
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
    const runKeyResult = this.runKey(
      state.menu ?? Vim.visualMenus,
      getInput,
      key
    );
    if (runKeyResult === undefined) {
      // TODO LOG key not found
      return { processed: false, mode: "visual", menu: undefined };
    }
    const processed = true;
    if (runKeyResult.type === "menu") {
      return { processed, mode: "visual", menu: runKeyResult.menu };
    }
    const { active, toMode } = runKeyResult.output;
    if (toMode === "normal") {
      // TODO global fix to hook, also when mode is changed TO normal
      const fixed = fixNormalCursor(this.editor, active);
      this.editor.cursor = { type: "block" };
      this.editor.selections = [{ anchor: fixed, active: fixed }];
      return { processed, mode: "normal", menu: undefined };
    } else if (toMode === "visual") {
      this.editor.selections = [
        visualToEditor(this.editor, {
          anchor: visualSelection.anchor,
          active,
        }),
      ];
      // TODO "blockBefore" cursor type (non-blinking)
      // TODO depending on the order of anchor/active!
      this.editor.cursor = { type: "line" };
      return { processed, mode: "visual", menu: undefined };
    } else {
      // toMode === "insert"
      this.editor.selections = [{ anchor: active, active }];
      this.editor.cursor = { type: "line" };
      return { processed, mode: "insert" };
    }
  }

  private runNormal(
    key: string,
    state: Extract<State, { mode: "normal" }>
  ): State & { processed: boolean } {
    const getInput = () => this.editor.selections[0].active;
    const runKeyResult = this.runKey(
      state.menu ?? Vim.normalMenus,
      getInput,
      key
    );
    if (runKeyResult === undefined) {
      // TODO LOG key not found
      return { processed: false, mode: "normal", menu: undefined };
    }
    const processed = true;
    if (runKeyResult.type === "menu") {
      return { processed, mode: "normal", menu: runKeyResult.menu };
    }
    const { pos, toMode } = runKeyResult.output;
    if (toMode === "normal") {
      // TODO global fix to hook, also when mode is changed TO normal
      const fixed = fixNormalCursor(this.editor, pos);
      this.editor.selections = [{ anchor: fixed, active: fixed }];
      return { processed, mode: "normal", menu: undefined };
    } else if (toMode === "visual") {
      // only possible via "v" for now
      this.editor.selections = [
        { anchor: pos, active: fixPos(this.editor, pos, 1) },
      ];
      // TODO "blockBefore" cursor type (non-blinking)
      // TODO depending on the order of anchor/active!
      this.editor.cursor = { type: "line" };
      return { processed, mode: "visual", menu: undefined };
    } else {
      this.editor.selections = [{ anchor: pos, active: pos }];
      this.editor.cursor = { type: "line" };
      return { processed, mode: "insert" };
    }
  }

  public processKey(key: string): boolean {
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
        return processed;
      }
      case "insert": {
        if (key === "<escape>") {
          this.editor.cursor = { type: "block" };
          const fixed = fixNormalCursor(
            this.editor,
            this.editor.selections[0].active
          );
          this.editor.selections = [{ anchor: fixed, active: fixed }];
          this.state = { mode: "normal", menu: undefined };
          return true;
        } else {
          if (!this.editor.isFake)
            return false;

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

  public onKey(key: string): { processed: boolean; mode: Mode } {
    const processed = this.processKey(key);
    let mode: Mode;
    if (this.state.mode === "insert") {
      mode = "insert";
    }
    else if (this.state.mode === "normal") {
      mode = this.state.menu === undefined ? "normal" : "normal+";
    } else {
      // this.state.mode === "visual) {
      mode = this.state.menu === undefined ? "visual" : "visual+";
    }
    return { processed, mode };
  }
}
