import { Editor, Pos, Selection } from "../editorInterface.js";
import { ChordEntry } from "./common.js";
import { Mode } from "./vim.js";

export type RegisterTextContent = { isFullLine: boolean; content: string };

export type RegisterContent =
  | ({ type: "text" } & RegisterTextContent)
  | { type: "macro"; keys: string[] };

export class Registers {
  registers: Record<string, RegisterContent | undefined> = {};

  // TODO Can also show current reg name somewhere
  // ...this really means text register, not macro
  currentRegName: string | undefined;
  private registerJustSelected = false;

  public setCurrentRegister(register: string | undefined) {
    this.currentRegName = register;
    this.registerJustSelected = true;
  }

  public onAfterKeyProcessed(mode: Mode, previousMode: Mode) {
    // Clear register after any command in normal/visual mode
    // (but not when we just selected a register or while in operator-pending)
    const inNormalOrVisual = mode === "normal" || mode === "visual";

    if (inNormalOrVisual && !this.registerJustSelected) {
      this.currentRegName = undefined;
    }

    // Always clear the "just selected" flag after processing
    this.registerJustSelected = false;
  }

  public putText(editor: Editor, { isFullLine, content }: RegisterTextContent) {
    const regName = this.currentRegName ?? '"';
    this.registers[regName] = { type: "text", isFullLine, content };
    if (regName === '"') {
      editor.real_putClipboard(content);
    }
  }

  public async getText(
    editor: Editor
  ): Promise<RegisterTextContent | undefined> {
    const regName = this.currentRegName ?? '"';
    const reg = this.registers[regName];
    const regText = reg?.type === "text" ? reg : undefined;
    const realClipboard =
      regName === '"' ? await editor.real_getClipboard() : undefined;
    let content = realClipboard ?? regText?.content;
    if (content === undefined) return undefined;
    content = content.replace(/(\r\n|\r)/g, "\n");
    if (regText && content === regText.content) {
      return { isFullLine: regText.isFullLine, content };
    } else {
      return { isFullLine: false, content };
    }
  }

  /**
   * Create a ChordEntry for register selection (the `"` command) in normal mode.
   * Returns a menu that accepts any single character as a register name.
   */
  public static createRegisterSelectionChord(): ChordEntry<
    Pos,
    { pos: Pos; toMode: "normal" }
  > {
    return {
      type: "menu",
      menu: {
        type: "impl",
        impl: {
          type: "fn",
          fn: (_editor, env, { key, input: p }) => {
            // Accept any single character as register name
            if (key.length === 1) {
              env.globalState.registers.setCurrentRegister(key);
              return {
                type: "action",
                action: (_e, _env, _p) => ({
                  pos: p,
                  toMode: "normal",
                }),
              };
            }
            return undefined;
          },
        },
      },
    };
  }

  /**
   * Create a ChordEntry for register selection (the `"` command) in visual mode.
   * Returns a menu that accepts any single character as a register name.
   */
  public static createRegisterSelectionChordVisual(): ChordEntry<
    Selection,
    { active: Pos; anchor: Pos; toMode: "visual" }
  > {
    return {
      type: "menu",
      menu: {
        type: "impl",
        impl: {
          type: "fn",
          fn: (_editor, env, { key, input: sel }) => {
            // Accept any single character as register name
            if (key.length === 1) {
              env.globalState.registers.setCurrentRegister(key);
              return {
                type: "action",
                action: (_e, _env, _sel) => ({
                  active: sel.active,
                  anchor: sel.anchor,
                  toMode: "visual",
                }),
              };
            }
            return undefined;
          },
        },
      },
    };
  }
}
