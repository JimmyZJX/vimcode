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

type RegisterStorage = {
  unnamed: RegisterContent | undefined;
  smallDelete: RegisterContent | undefined;
  search: RegisterContent | undefined;
  systemClipboard: RegisterContent | undefined;
  named: Map<LowercaseLetter, RegisterContent>;
  numbered: Map<DigitRegister, RegisterContent>;
};

function createRegisterStorage(): RegisterStorage {
  return {
    unnamed: undefined,
    smallDelete: undefined,
    search: undefined,
    systemClipboard: undefined,
    named: new Map(),
    numbered: new Map(),
  };
}

export class Registers {
  private activeClipboard: VimSystemClipboard | undefined;
  private activeClipboardFresh = false;
  private activeClipboardContent: RegisterContent | undefined;
  private useSystemClipboard = false;

  constructor(private readonly storage: RegisterStorage = createRegisterStorage()) {}

  /** A per-Vim facade: register values remain global, while execution-scoped
      clipboard identity/freshness cannot race with another editor controller. */
  scoped(): Registers {
    return new Registers(this.storage);
  }

  setUseSystemClipboard(useSystemClipboard: boolean): void {
    this.useSystemClipboard = useSystemClipboard;
  }

  hasFreshActiveClipboard(): boolean {
    return this.activeClipboard !== undefined && this.activeClipboardFresh;
  }

  read(name: RegisterName | undefined): string {
    return this.readContent(name).text;
  }

  readContent(name: RegisterName | undefined): RegisterContent {
    return this.readContentIfPresent(name) ?? emptyRegister;
  }

  readContentIfPresent(name: RegisterName | undefined): RegisterContent | undefined {
    if (this.usesSystemClipboardRegister(name) || isSystemClipboardRegister(name)) {
      return this.activeClipboardContent ?? this.storage.systemClipboard ?? this.storage.unnamed;
    }
    if (name === undefined || name === '"') return this.storage.unnamed;
    if (name === "_") return emptyRegister;
    if (name === "-") return this.storage.smallDelete;
    if (name === "/") return this.storage.search;
    if (isDigitRegister(name)) return this.storage.numbered.get(name);
    return this.storage.named.get(lowercaseRegister(name));
  }

  refreshSystemClipboardRegister(name: RegisterName | undefined): Promise<void> | void {
    if (!this.usesSystemClipboardRegister(name) || this.activeClipboard === undefined || this.activeClipboardFresh) return;
    return this.refreshActiveSystemClipboard();
  }

  private async refreshActiveSystemClipboard(): Promise<void> {
    const clipboard = this.activeClipboard;
    if (clipboard === undefined) return;
    // Clipboard round trips (browser clipboard services, remote bridging,
    // external apps) can deliver Windows line endings. The model is \n-only —
    // a stray `\r` surviving into a paste is rendered by the host as an extra
    // line break (`Vyp` through the system clipboard pasted a ghost empty
    // line: "aaa\r\n" minus the stripped `\n` left "aaa\r").
    const text = (await clipboard.readText()).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Unchanged since Vim last wrote it: keep kind/parts. External text gets a
    // fresh plain-text classification.
    const content = this.storage.systemClipboard?.text === text
      ? this.storage.systemClipboard
      : {
          text,
          kind: text.endsWith("\n") ? "linewise" as const : "characterwise" as const,
        };
    this.storage.systemClipboard = content;
    if (this.activeClipboard === clipboard) {
      this.activeClipboardContent = content;
      this.activeClipboardFresh = true;
    }
  }

  async withSystemClipboard<T>(clipboard: VimSystemClipboard | undefined, f: () => Promise<T>): Promise<T> {
    const previous = this.activeClipboard;
    const previousFresh = this.activeClipboardFresh;
    const previousContent = this.activeClipboardContent;
    const sameTransaction = previous !== undefined && previous === clipboard;
    this.activeClipboard = clipboard;
    this.activeClipboardFresh = sameTransaction ? previousFresh : false;
    this.activeClipboardContent = sameTransaction ? previousContent : undefined;
    try {
      return await f();
    } finally {
      const refreshed = this.activeClipboardFresh;
      const refreshedContent = this.activeClipboardContent;
      this.activeClipboard = previous;
      this.activeClipboardFresh = sameTransaction ? previousFresh || refreshed : previousFresh;
      this.activeClipboardContent = sameTransaction && refreshed ? refreshedContent : previousContent;
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
      const current = this.storage.named.get(lower) ?? emptyRegister;
      const appended = appendRegisterContent(current, content);
      this.storage.named.set(lower, appended);
      this.storage.unnamed = appended;
      return;
    }

    this.storage.unnamed = content;
    if (this.usesSystemClipboardRegister(name)) this.writeSystemClipboard(content);
    if (name !== undefined && name !== '"') {
      if (isDigitRegister(name)) this.storage.numbered.set(name, content);
      else if (name === "-") this.storage.smallDelete = content;
      else if (name === "/") this.storage.search = content;
      else if (!isSystemClipboardRegister(name)) this.storage.named.set(name, content);
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
      this.storage.numbered.set("0", parts === undefined ? { text, kind } : { text, kind, parts });
    }
  }

  writeDelete(
    name: RegisterName | undefined,
    text: string,
    kind: RegisterKind = "characterwise",
    parts?: readonly RegisterPart[]
  ): void {
    if (name === "_") return;
    const content: RegisterContent = parts === undefined ? { text, kind } : { text, kind, parts };
    this.write(name, text, kind, parts);
    if (name === '"') this.storage.numbered.set("0", content);

    // Neovim-verified asymmetry: the 1-9 rotation happens even when the delete
    // names a register (`"add` also fills `"1`, :h quote1), but the
    // small-delete register is written only when NO register was specified
    // (`"adw`/`""dw` leave `"-` untouched, :h quote-).
    this.writeDeleteHistoryContent(content, { smallDelete: name === undefined });
  }

  /** Update numbered/small-delete history without overwriting the selected
      source register (Visual `P`). The replaced text of a visual put counts as
      an unspecified-register delete, so it may write `"-` even when the put
      itself read a named register (Neovim-verified: `viw"ap` fills `"-`). */
  writeDeleteHistory(
    text: string,
    kind: RegisterKind = "characterwise",
    parts?: readonly RegisterPart[]
  ): void {
    const content: RegisterContent = parts === undefined ? { text, kind } : { text, kind, parts };
    this.writeDeleteHistoryContent(content, { smallDelete: true });
  }

  private writeDeleteHistoryContent(content: RegisterContent, { smallDelete }: { smallDelete: boolean }): void {
    // Classify from real part geometry, not synthetic separators in aggregate
    // multicursor text.
    const multiline = content.kind !== "characterwise"
      || (content.parts === undefined
        ? content.text.includes("\n")
        : content.parts.some(part => part.text.includes("\n")));
    if (multiline) this.pushNumberedDelete(content);
    else if (smallDelete) this.storage.smallDelete = content;
  }

  writeSearch(query: string): void {
    this.storage.search = { text: query, kind: "characterwise" };
  }

  private writeSystemClipboard(content: RegisterContent): void {
    this.storage.systemClipboard = content;
    if (this.activeClipboard !== undefined) {
      this.activeClipboard.writeText(content.text);
      this.activeClipboardContent = content;
      this.activeClipboardFresh = true;
    }
  }

  private usesSystemClipboardRegister(name: RegisterName | undefined): boolean {
    return isSystemClipboardRegister(name) || (name === undefined && this.useSystemClipboard);
  }

  private pushNumberedDelete(content: RegisterContent): void {
    for (let digit = 9; digit >= 2; digit--) {
      const previous = this.storage.numbered.get(String(digit - 1) as DigitRegister);
      const destination = String(digit) as DigitRegister;
      if (previous !== undefined) this.storage.numbered.set(destination, previous);
      else this.storage.numbered.delete(destination);
    }
    this.storage.numbered.set("1", content);
  }
}

function appendRegisterContent(current: RegisterContent, incoming: RegisterContent): RegisterContent {
  const appended = appendRegisterPart(current, incoming);
  const partCount = Math.max(current.parts?.length ?? 0, incoming.parts?.length ?? 0);
  if (partCount === 0) return appended;
  const parts = Array.from({ length: partCount }, (_unused, index) =>
    appendRegisterPart(registerPartAt(current, index), registerPartAt(incoming, index)));
  const text = appended.kind === "linewise"
    ? `${parts.map(part => part.text.endsWith("\n") ? part.text.slice(0, -1) : part.text).join("\n")}\n`
    : parts.map(part => part.text).join("\n");
  return { text, kind: appended.kind, parts };
}

function registerPartAt(content: RegisterContent, index: number): RegisterPart {
  return content.parts?.[index] ?? content.parts?.[0] ?? { text: content.text, kind: content.kind };
}

function appendRegisterPart(current: RegisterPart, incoming: RegisterPart): RegisterPart {
  if (current.text.length === 0) return { text: incoming.text, kind: incoming.kind };
  if (incoming.text.length === 0) return { text: current.text, kind: current.kind };
  if (current.kind === "linewise" || incoming.kind === "linewise") {
    const currentText = current.text.endsWith("\n") ? current.text.slice(0, -1) : current.text;
    const incomingText = incoming.text.endsWith("\n") ? incoming.text.slice(0, -1) : incoming.text;
    return { text: `${currentText}\n${incomingText}\n`, kind: "linewise" };
  }
  return {
    text: current.text + incoming.text,
    kind: current.kind === "blockwise" && incoming.kind === "blockwise" ? "blockwise" : "characterwise",
  };
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
