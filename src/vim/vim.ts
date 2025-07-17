import { Editor, fixPos, Pos, Selection } from "../editorInterface";
import { ChordMenu, Env, followKey, mapChordMenu } from "./common";
import { fixNormalCursor, visualFromEditor, visualToEditor } from "./modeUtil";
import { motions } from "./motion/motion";
import { deletes } from "./normal/cutDelete";
import { inserts } from "./normal/insert";
import { visualDelete } from "./visual/delete";

// TODO for VSCode: click cursor should be corrected to block cursor instead of line
// cursor

export type Mode = "normal" | "insert" | "visual" | "operator-pending";

type NormalModeResult = { pos: Pos; toMode: "normal" | "insert" | "visual" };
type VisualModeResult = { active: Pos; toMode: "visual" | "normal" | "insert" };

type State =
  | {
      mode: "normal";
      // TODO duplicated info? [menu === undefined] <=> pending
      pending: boolean;
      menu: ChordMenu<Pos, NormalModeResult> | undefined;
    }
  | {
      mode: "visual";
      pending: boolean;
      menu: ChordMenu<Selection, VisualModeResult> | undefined;
    }
  | { mode: "insert" }; // TODO insert chords

function isStatePending(state: State) {
  if (state.mode === "insert") return false;
  return state.pending;
}

export class Vim {
  constructor(readonly editor: Editor, readonly env: Env) {}

  private state: State = { mode: "normal", pending: false, menu: undefined };

  private static normalMenus: ChordMenu<Pos, NormalModeResult> = {
    type: "multi",
    menus: [
      mapChordMenu(
        (i) => i,
        {
          type: "impl",
          impl: { type: "keys", keys: { ...motions, ...deletes } },
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
    if (r.type === "menu") return r;
    if (r.type === "action") {
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
  ): State {
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
      return { mode: "visual", pending: false, menu: undefined };
    }
    if (runKeyResult.type === "menu") {
      return { mode: "visual", pending: true, menu: runKeyResult.menu };
    }
    const { active, toMode } = runKeyResult.output;
    if (toMode === "normal") {
      // TODO global fix to hook, also when mode is changed TO normal
      const fixed = fixNormalCursor(this.editor, active);
      this.editor.cursor = { type: "block" };
      this.editor.selections = [{ anchor: fixed, active: fixed }];
      return { mode: "normal", pending: false, menu: undefined };
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
      return { mode: "visual", pending: false, menu: undefined };
    } else {
      // toMode === "insert"
      this.editor.selections = [{ anchor: active, active }];
      this.editor.cursor = { type: "line" };
      return { mode: "insert" };
    }
  }

  private runNormal(
    key: string,
    state: Extract<State, { mode: "normal" }>
  ): State {
    const getInput = () => this.editor.selections[0].active;
    const runKeyResult = this.runKey(
      state.menu ?? Vim.normalMenus,
      getInput,
      key
    );
    if (runKeyResult === undefined) {
      // TODO LOG key not found
      return { mode: "normal", pending: false, menu: undefined };
    }
    if (runKeyResult.type === "menu") {
      return { mode: "normal", pending: true, menu: runKeyResult.menu };
    }
    const { pos, toMode } = runKeyResult.output;
    if (toMode === "normal") {
      // TODO global fix to hook, also when mode is changed TO normal
      const fixed = fixNormalCursor(this.editor, pos);
      this.editor.selections = [{ anchor: fixed, active: fixed }];
      return { mode: "normal", pending: false, menu: undefined };
    } else if (toMode === "visual") {
      // only possible via "v" for now
      this.editor.selections = [
        { anchor: pos, active: fixPos(this.editor, pos, 1) },
      ];
      // TODO "blockBefore" cursor type (non-blinking)
      // TODO depending on the order of anchor/active!
      this.editor.cursor = { type: "line" };
      return { mode: "visual", pending: false, menu: undefined };
    } else {
      this.editor.selections = [{ anchor: pos, active: pos }];
      this.editor.cursor = { type: "line" };
      return { mode: "insert" };
    }
  }

  public onKey(key: string): { processed: boolean; mode: Mode } {
    switch (this.state.mode) {
      case "visual": {
        // check if selection is forward or backward
        this.state = this.runVisual(key, this.state);
        return {
          processed: true,
          mode: isStatePending(this.state)
            ? "operator-pending"
            : this.state.mode,
        };
      }
      case "normal": {
        this.state = this.runNormal(key, this.state);
        return {
          processed: true,
          mode: isStatePending(this.state)
            ? "operator-pending"
            : this.state.mode,
        };
      }
      case "insert": {
        if (key === "<escape>") {
          this.editor.cursor = { type: "block" };
          const fixed = fixNormalCursor(
            this.editor,
            this.editor.selections[0].active
          );
          this.editor.selections = [{ anchor: fixed, active: fixed }];
          this.state = { mode: "normal", pending: false, menu: undefined };
          return { processed: true, mode: "normal" };
        } else {
          // TODO in fact we don't need to handle these in the real VSCode environment
          const sel = this.editor.selections[0];
          this.editor.editText(sel, key);
          const newPos = { l: sel.active.l, c: sel.active.c + 1 };
          this.editor.selections = [{ anchor: newPos, active: newPos }];
          return { processed: false, mode: "insert" };
        }
      }
      default: {
        const _: never = this.state;
        throw new Error(`Unexpected state ${(this.state as any).mode}`);
      }
    }
  }
}
