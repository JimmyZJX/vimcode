import { Editor, fixPos, Pos } from "../editorInterface";
import { ChordMenu, Env, followKey, mapChordMenu } from "./common";
import { fixNormalCursor, visualFromEditor, visualToEditor } from "./modeUtil";
import { motions } from "./motion/motion";
import { deletes } from "./normal/cutDelete";
import { inserts } from "./normal/insert";

export type Mode = "normal" | "insert" | "visual" | "operator-pending";

type NormalModeResult = { pos: Pos; toMode: "normal" | "insert" | "visual" };
type VisualModeResult = { active: Pos; toMode: "visual" | "normal" | "insert" };

type State =
  | {
      mode: "normal";
      pending: boolean;
      menu: ChordMenu<Pos, NormalModeResult> | undefined;
    }
  | {
      mode: "visual";
      pending: boolean;
      menu: ChordMenu<Pos, VisualModeResult> | undefined;
    }
  | { mode: "insert" }; // TODO insert chords

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

  private static visualMenus: ChordMenu<Pos, VisualModeResult> = {
    type: "multi",
    menus: [
      mapChordMenu(
        (i) => i,
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
          impl: { type: "keys", keys: deletes },
          // TODO keys like "xX" behaves very differently
        },
        (_editor, _env, { input: _, output }) => ({
          active: output,
          toMode: "normal",
        })
      ),
      mapChordMenu(
        (i) => i,
        { type: "impl", impl: { type: "keys", keys: inserts } },
        (_editor, _env, { input: _, output }) => ({
          active: output,
          toMode: "insert",
          // TODO keys like "sSiaIA" behaves very differently
        })
      ),
      {
        type: "impl",
        impl: {
          type: "keys",
          keys: {
            "<escape>": {
              type: "action",
              action: (_editor, _env, p) => ({ active: p, toMode: "normal" }),
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

  public onKey(key: string): { processed: boolean; mode: Mode } {
    switch (this.state.mode) {
      case "visual": {
        // check if selection is forward or backward
        const { anchor, active } = visualFromEditor(
          this.editor,
          this.editor.selections[0]
        );
        const getInput = () => active;
        const runKeyResult = this.runKey(
          this.state.menu ?? Vim.visualMenus,
          getInput,
          key
        );
        if (runKeyResult === undefined) {
          // TODO LOG key not found
          this.state.pending = false;
          this.state.menu = undefined;
          return { processed: true, mode: "visual" };
        } else if (runKeyResult.type === "menu") {
          this.state.pending = true;
          this.state.menu = runKeyResult.menu;
          return { processed: true, mode: "operator-pending" };
        } else {
          this.state.pending = false;
          this.state.menu = undefined;
          const { active, toMode } = runKeyResult.output;

          if (toMode === "normal") {
            // TODO global fix to hook, also when mode is changed TO normal
            const fixed = fixNormalCursor(this.editor, active);
            this.editor.selections = [{ anchor: fixed, active: fixed }];
            return { processed: true, mode: "normal" };
          } else if (toMode === "visual") {
            this.editor.selections = [
              visualToEditor(this.editor, { anchor, active }),
            ];
            // TODO "blockBefore" cursor type (non-blinking)
            // TODO depending on the order of anchor/active!
            this.editor.cursor = { type: "line" };
            return { processed: true, mode: "visual" };
          } else {
            // toMode === "insert"
            this.editor.selections = [{ anchor: active, active }];
            this.state = { mode: "insert" };
            this.editor.cursor = { type: "line" };
            return { processed: true, mode: "insert" };
          }
        }
      }
      case "normal": {
        const getInput = () => this.editor.selections[0].active;
        const runKeyResult = this.runKey(
          this.state.menu ?? Vim.normalMenus,
          getInput,
          key
        );
        if (runKeyResult === undefined) {
          // TODO LOG key not found
          this.state.pending = false;
          this.state.menu = undefined;
          return { processed: true, mode: "normal" };
        } else if (runKeyResult.type === "menu") {
          this.state.pending = true;
          this.state.menu = runKeyResult.menu;
          return { processed: true, mode: "operator-pending" };
        } else {
          this.state.pending = false;
          this.state.menu = undefined;
          const { pos, toMode } = runKeyResult.output;

          if (toMode === "normal") {
            // TODO global fix to hook, also when mode is changed TO normal
            const fixed = fixNormalCursor(this.editor, pos);
            this.editor.selections = [{ anchor: fixed, active: fixed }];
            return { processed: true, mode: "normal" };
          } else if (toMode === "visual") {
            // only possible via "v" for now
            this.editor.selections = [
              { anchor: pos, active: fixPos(this.editor, pos, 1) },
            ];
            // TODO "blockBefore" cursor type (non-blinking)
            // TODO depending on the order of anchor/active!
            this.editor.cursor = { type: "line" };
            this.state = { mode: "visual", pending: false, menu: undefined };
            return { processed: true, mode: "visual" };
          } else {
            this.editor.selections = [{ anchor: pos, active: pos }];
            this.state = { mode: "insert" };
            this.editor.cursor = { type: "line" };
            return { processed: true, mode: "insert" };
          }
        }
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
