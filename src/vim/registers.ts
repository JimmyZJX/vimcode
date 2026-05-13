// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: `state::VimGlobals`, `state::Register`, and register-related helpers in
//   `vim::Vim` / `normal` modules
// - translated concepts: unnamed and named register storage plus selected-register prefix
// - intentional differences: this first slice supports only the unnamed register and
//   lowercase named registers. Numbered, small-delete, black-hole, system clipboard,
//   append, expression, and read-only registers are future work.

export type RegisterName = '"' | LowercaseLetter;
export type RegisterKind = "characterwise" | "linewise" | "blockwise";

export type RegisterContent = {
  text: string;
  kind: RegisterKind;
};

type LowercaseLetter =
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m"
  | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z";

const emptyRegister: RegisterContent = { text: "", kind: "characterwise" };

export class Registers {
  private unnamed: RegisterContent = emptyRegister;
  private readonly named = new Map<LowercaseLetter, RegisterContent>();

  read(name: RegisterName | undefined): string {
    return this.readContent(name).text;
  }

  readContent(name: RegisterName | undefined): RegisterContent {
    if (name === undefined || name === '"') return this.unnamed;
    return this.named.get(name) ?? emptyRegister;
  }

  write(name: RegisterName | undefined, text: string, kind: RegisterKind = "characterwise"): void {
    const content = { text, kind };
    this.unnamed = content;
    if (name !== undefined && name !== '"') {
      this.named.set(name, content);
    }
  }
}

export function parseRegisterName(key: string): RegisterName | undefined {
  if (key === '"') return '"';
  return /^[a-z]$/.test(key) ? (key as LowercaseLetter) : undefined;
}
