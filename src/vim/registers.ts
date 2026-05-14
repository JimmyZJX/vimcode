// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: `state::VimGlobals`, `state::Register`, and register-related helpers in
//   `vim::Vim` / `normal` modules
// - translated concepts: unnamed, named/append, numbered, small-delete, search, and
//   black-hole register storage
// - intentional differences: this slice implements the in-memory semantics needed by
//   current fixtures. System clipboard, expression, and read-only file/alternate registers
//   remain future work.

export type RegisterName = '"' | LowercaseLetter | UppercaseLetter | DigitRegister | "_" | "-" | "/" | "+" | "*";
export type RegisterKind = "characterwise" | "linewise" | "blockwise";

export type RegisterContent = {
  text: string;
  kind: RegisterKind;
};

type LowercaseLetter =
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m"
  | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z";

type UppercaseLetter = Uppercase<LowercaseLetter>;
type DigitRegister = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

const emptyRegister: RegisterContent = { text: "", kind: "characterwise" };

export class Registers {
  private unnamed: RegisterContent = emptyRegister;
  private smallDelete: RegisterContent = emptyRegister;
  private search: RegisterContent = emptyRegister;
  private readonly named = new Map<LowercaseLetter, RegisterContent>();
  private readonly numbered = new Map<DigitRegister, RegisterContent>();

  read(name: RegisterName | undefined): string {
    return this.readContent(name).text;
  }

  readContent(name: RegisterName | undefined): RegisterContent {
    if (name === undefined || name === '"') return this.unnamed;
    if (name === "_") return emptyRegister;
    if (name === "-") return this.smallDelete;
    if (name === "/") return this.search;
    if (name === "+" || name === "*") return this.unnamed;
    if (isDigitRegister(name)) return this.numbered.get(name) ?? emptyRegister;
    return this.named.get(lowercaseRegister(name)) ?? emptyRegister;
  }

  write(name: RegisterName | undefined, text: string, kind: RegisterKind = "characterwise"): void {
    if (name === "_") return;

    const content = { text, kind };
    if (name !== undefined && isUppercaseLetter(name)) {
      const lower = lowercaseRegister(name);
      const current = this.named.get(lower) ?? emptyRegister;
      const appended = { text: current.text + text, kind };
      this.named.set(lower, appended);
      this.unnamed = appended;
      return;
    }

    this.unnamed = content;
    if (name !== undefined && name !== '"') {
      if (isDigitRegister(name)) this.numbered.set(name, content);
      else if (name === "-") this.smallDelete = content;
      else if (name === "/") this.search = content;
      else if (name === "+" || name === "*") {
        // Keep unnamed authoritative for clipboard-like registers in this slice.
      } else this.named.set(name, content);
    }
  }

  writeYank(name: RegisterName | undefined, text: string, kind: RegisterKind = "characterwise"): void {
    this.write(name, text, kind);
    if (name === undefined || name === '"') this.numbered.set("0", { text, kind });
  }

  writeDelete(name: RegisterName | undefined, text: string, kind: RegisterKind = "characterwise"): void {
    const content = { text, kind };
    if (name === '"') {
      this.unnamed = content;
      this.numbered.set("0", content);
      return;
    }

    if (name === undefined) {
      this.unnamed = content;
      if (kind === "linewise" || text.includes("\n")) {
        this.pushNumberedDelete(content);
      } else {
        this.smallDelete = content;
      }
      return;
    }

    this.write(name, text, kind);
  }

  writeSearch(query: string): void {
    this.search = { text: query, kind: "characterwise" };
  }

  private pushNumberedDelete(content: RegisterContent): void {
    for (let digit = 9; digit >= 2; digit--) {
      const previous = this.numbered.get(String(digit - 1) as DigitRegister);
      if (previous !== undefined) this.numbered.set(String(digit) as DigitRegister, previous);
    }
    this.numbered.set("1", content);
  }
}

export function parseRegisterName(key: string): RegisterName | undefined {
  if (key === '"') return '"';
  if (key === "_" || key === "-" || key === "/" || key === "+" || key === "*") return key;
  if (/^[0-9]$/.test(key)) return key as DigitRegister;
  if (/^[a-z]$/.test(key)) return key as LowercaseLetter;
  if (/^[A-Z]$/.test(key)) return key as UppercaseLetter;
  return undefined;
}

function isDigitRegister(name: RegisterName): name is DigitRegister {
  return /^[0-9]$/.test(name);
}

function isUppercaseLetter(name: RegisterName): name is UppercaseLetter {
  return /^[A-Z]$/.test(name);
}

function lowercaseRegister(name: LowercaseLetter | UppercaseLetter): LowercaseLetter {
  return name.toLowerCase() as LowercaseLetter;
}
