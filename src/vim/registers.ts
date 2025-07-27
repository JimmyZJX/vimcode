import { Editor } from "../editorInterface";
import { Mode } from "./vim";

export type RegisterTextContent = { isFullLine: boolean; content: string };

export type RegisterContent =
  | ({ type: "text" } & RegisterTextContent)
  | { type: "macro"; keys: string[] };

export class Registers {
  registers: Record<string, RegisterContent | undefined> = {};

  // TODO Can also show current reg name somewhere
  // ...this really means text register, not macro
  currentRegName: string | undefined;
  currentRegNameJustSet = false;

  public setCurrentRegister(register: string | undefined) {
    this.currentRegName = register;
    if (register) this.currentRegNameJustSet = true;
  }

  public onAfterKeyProcessed(mode: Mode) {
    if (mode === "normal" && !this.currentRegNameJustSet) {
      this.currentRegName = undefined;
    }
    this.currentRegNameJustSet = false;
  }

  public putText(editor: Editor, { isFullLine, content }: RegisterTextContent) {
    const regName = this.currentRegName ?? '"';
    this.registers[regName] = { type: "text", isFullLine, content };
    if (regName === '"') {
      editor.real_putClipboard(regName);
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
    if (content === regText?.content) {
      return { isFullLine: regText.isFullLine, content };
    } else {
      return { isFullLine: false, content };
    }
  }
}
