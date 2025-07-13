import { Editor, Pos } from "../editorInterface";
import {
  ChordMenuMapper,
  collapse,
  CollapsedChordEntry,
  createMenuWithMap,
  Env,
  getKey,
} from "./common";
import { fixNormalCursor } from "./modeUtil";
import { motions } from "./motion/motion";
import { deletes } from "./normal/cutDelete";
import { inserts } from "./normal/insert";

export type Mode = "normal" | "insert" | "operator-pending";

type NormalModeResult = { pos: Pos; toMode: "normal" | "insert" };

type State =
  | {
      mode: "normal";
      pending: boolean;
      menu: ChordMenuMapper<Pos, NormalModeResult> | undefined;
    }
  | { mode: "insert" }; // TODO insert chords

type RunKeyResult<I, O> =
  | { type: "done"; output: O }
  | { type: "menu"; menu: ChordMenuMapper<I, O> }
  | undefined;

export class Vim {
  constructor(readonly editor: Editor, readonly env: Env) {}

  private runKey<I, O>(
    menu: ChordMenuMapper<I, O>,
    key: string,
    getInput: () => I
  ): RunKeyResult<I, O> {
    return menu((map, chords) => {
      const entry = getKey(chords, key, this.editor, this.env, getInput());
      if (entry === undefined) return undefined;
      const r: CollapsedChordEntry<I, O> = collapse((k) => k(map, entry));

      if (r.type === "menu") return r;

      const oldFlash = this.env.flash;
      const output = r.action(this.editor, this.env, getInput());
      if (this.env.flash === oldFlash) {
        this.env.flash = {};
      }
      return { type: "done", output };
    });
  }

  private pickRun<I, O>(
    menus: ChordMenuMapper<I, O>[],
    key: string,
    getInput: () => I
  ): RunKeyResult<I, O> {
    for (const menu of menus) {
      const r = this.runKey(menu, key, getInput);
      if (r !== undefined) return r;
    }
  }

  private state: State = { mode: "normal", pending: false, menu: undefined };

  private static normalMenus: ChordMenuMapper<Pos, NormalModeResult>[] = [
    createMenuWithMap({ keys: motions }, (pos) => ({ pos, toMode: "normal" })),
    createMenuWithMap({ keys: deletes }, (pos) => ({ pos, toMode: "normal" })),
    createMenuWithMap({ keys: inserts }, (pos) => ({ pos, toMode: "insert" })),
  ];

  public onKey(key: string): { processed: boolean; mode: Mode } {
    switch (this.state.mode) {
      case "normal": {
        const getInput = () => this.editor.selections[0].active;
        const runKeyResult =
          this.state.menu === undefined
            ? this.pickRun(Vim.normalMenus, key, getInput)
            : this.runKey(this.state.menu, key, getInput);
        if (runKeyResult === undefined) {
          // TODO LOG key not found
          this.state.pending = false;
          this.state.menu = undefined;
          return { processed: true, mode: "normal" };
        } else if (runKeyResult.type === "done") {
          this.state.pending = false;
          this.state.menu = undefined;
          const { pos, toMode } = runKeyResult.output;

          if (toMode === "normal") {
            // TODO global fix to hook, also when mode is changed TO normal
            const fixed = fixNormalCursor(this.editor, pos);
            this.editor.selections = [{ anchor: fixed, active: fixed }];
            return { processed: true, mode: "normal" };
          } else {
            this.editor.selections = [{ anchor: pos, active: pos }];
            this.state = { mode: "insert" };
            this.editor.cursor = { type: "line" };
            return { processed: true, mode: "insert" };
          }
        } else {
          this.state.pending = true;
          this.state.menu = runKeyResult.menu;
          return { processed: true, mode: "operator-pending" };
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
