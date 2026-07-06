// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: `state::VimGlobals`, `state::Register`, and register-related helpers in
//   `vim::Vim` / `normal` modules
// - translated concepts: unnamed, named/append, numbered, small-delete, search, and
//   black-hole register storage
// - intentional differences: this slice implements the in-memory semantics needed by
//   current fixtures. System clipboard registers are integrated through a per-dispatch
//   async transaction supplied by the VSCode adapter; expression and read-only
//   file/alternate registers remain future work.

export type RegisterName = '"' | LowercaseLetter | UppercaseLetter | DigitRegister | "_" | "-" | "/" | "+" | "*";
export type RegisterKind = "characterwise" | "linewise" | "blockwise";

export type RegisterPart = {
  text: string;
  kind: RegisterKind;
};

export type RegisterContent = {
  text: string;
  kind: RegisterKind;
  parts?: readonly RegisterPart[];
};

export interface VimSystemClipboard {
  readText(): Promise<string>;
  writeText(text: string): void;
}

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
  private systemClipboard: RegisterContent | undefined;
  private readonly named = new Map<LowercaseLetter, RegisterContent>();
  private readonly numbered = new Map<DigitRegister, RegisterContent>();
  private activeClipboard: VimSystemClipboard | undefined;
  private useSystemClipboard = false;

  setUseSystemClipboard(useSystemClipboard: boolean): void {
    this.useSystemClipboard = useSystemClipboard;
  }

  read(name: RegisterName | undefined): string {
    return this.readContent(name).text;
  }

  readContent(name: RegisterName | undefined): RegisterContent {
    if (this.usesSystemClipboardRegister(name)) return this.systemClipboard ?? this.unnamed;
    if (name === undefined || name === '"') return this.unnamed;
    if (name === "_") return emptyRegister;
    if (name === "-") return this.smallDelete;
    if (name === "/") return this.search;
    if (isSystemClipboardRegister(name)) return this.systemClipboard ?? this.unnamed;
    if (isDigitRegister(name)) return this.numbered.get(name) ?? emptyRegister;
    return this.named.get(lowercaseRegister(name)) ?? emptyRegister;
  }

  async refreshSystemClipboardRegister(name: RegisterName | undefined): Promise<void> {
    if (!this.usesSystemClipboardRegister(name) || this.activeClipboard === undefined) return;
    // Clipboard round trips (browser clipboard services, remote bridging,
    // external apps) can deliver Windows line endings. The model is \n-only —
    // a stray `\r` surviving into a paste is rendered by the host as an extra
    // line break (`Vyp` through the system clipboard pasted a ghost empty
    // line: "aaa\r\n" minus the stripped `\n` left "aaa\r").
    const text = (await this.activeClipboard.readText()).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Unchanged since Vim last wrote it: keep the register as-is (kind and
    // multicursor parts still describe the text).
    if (this.systemClipboard !== undefined && this.systemClipboard.text === text) return;
    // The text changed externally: the stored kind/parts no longer apply.
    // Trailing-newline text pastes linewise, like Vim's plain-text heuristic.
    this.systemClipboard = {
      text,
      kind: text.endsWith("\n") ? "linewise" : "characterwise",
    };
  }

  async withSystemClipboard<T>(clipboard: VimSystemClipboard | undefined, f: () => Promise<T>): Promise<T> {
    const previous = this.activeClipboard;
    this.activeClipboard = clipboard;
    try {
      return await f();
    } finally {
      this.activeClipboard = previous;
    }
  }

  write(
    name: RegisterName | undefined,
    text: string,
    kind: RegisterKind = "characterwise",
    parts?: readonly RegisterPart[]
  ): void {
    if (name === "_") return;

    const content: RegisterContent = parts === undefined ? { text, kind } : { text, kind, parts };
    if (name !== undefined && isUppercaseLetter(name)) {
      const lower = lowercaseRegister(name);
      const current = this.named.get(lower) ?? emptyRegister;
      const appended = { text: current.text + text, kind };
      this.named.set(lower, appended);
      this.unnamed = appended;
      return;
    }

    this.unnamed = content;
    if (this.usesSystemClipboardRegister(name)) this.writeSystemClipboard(content);
    if (name !== undefined && name !== '"') {
      if (isDigitRegister(name)) this.numbered.set(name, content);
      else if (name === "-") this.smallDelete = content;
      else if (name === "/") this.search = content;
      else if (!isSystemClipboardRegister(name)) this.named.set(name, content);
    }
  }

  writeYank(
    name: RegisterName | undefined,
    text: string,
    kind: RegisterKind = "characterwise",
    parts?: readonly RegisterPart[]
  ): void {
    this.write(name, text, kind, parts);
    if (name === undefined || name === '"') {
      this.numbered.set("0", parts === undefined ? { text, kind } : { text, kind, parts });
    }
  }

  writeDelete(
    name: RegisterName | undefined,
    text: string,
    kind: RegisterKind = "characterwise",
    parts?: readonly RegisterPart[]
  ): void {
    const content: RegisterContent = parts === undefined ? { text, kind } : { text, kind, parts };
    if (name === '"') {
      this.unnamed = content;
      this.numbered.set("0", content);
      return;
    }

    if (name === undefined) {
      this.unnamed = content;
      if (this.usesSystemClipboardRegister(name)) this.writeSystemClipboard(content);
      if (kind === "linewise" || text.includes("\n")) {
        this.pushNumberedDelete(content);
      } else {
        this.smallDelete = content;
      }
      return;
    }

    this.write(name, text, kind, parts);
  }

  writeSearch(query: string): void {
    this.search = { text: query, kind: "characterwise" };
  }

  private writeSystemClipboard(content: RegisterContent): void {
    this.systemClipboard = content;
    this.activeClipboard?.writeText(content.text);
  }

  private usesSystemClipboardRegister(name: RegisterName | undefined): boolean {
    return isSystemClipboardRegister(name) || (name === undefined && this.useSystemClipboard);
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

export function isSystemClipboardRegister(name: RegisterName | undefined): name is "+" | "*" {
  return name === "+" || name === "*";
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
