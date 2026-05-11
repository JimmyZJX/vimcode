// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: `state::VimGlobals`, `state::Register`, and register-related helpers in
//   `vim::Vim` / `normal` modules
// - translated concepts: unnamed and named register storage plus selected-register prefix
// - intentional differences: this first slice supports only the unnamed register and
//   lowercase named registers. Numbered, small-delete, black-hole, system clipboard,
//   append, expression, and read-only registers are future work.

export type RegisterName = '"' | LowercaseLetter;

type LowercaseLetter =
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m"
  | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z";

export class Registers {
  private unnamed = "";
  private readonly named = new Map<LowercaseLetter, string>();

  read(name: RegisterName | undefined): string {
    if (name === undefined || name === '"') return this.unnamed;
    return this.named.get(name) ?? "";
  }

  write(name: RegisterName | undefined, text: string): void {
    this.unnamed = text;
    if (name !== undefined && name !== '"') {
      this.named.set(name, text);
    }
  }
}

export function parseRegisterName(key: string): RegisterName | undefined {
  if (key === '"') return '"';
  return /^[a-z]$/.test(key) ? (key as LowercaseLetter) : undefined;
}
