// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/normal.rs, assets/keymaps/vim.json
// - translated concepts: normal-mode key dispatch, count accumulation, pending operators
// - intentional differences: this first slice hard-codes a small keymap instead of using
//   Zed's declarative key-context system.

import { VimEditorCapabilities } from "./editor.js";
import { enterInsertAtSelections, firstNonWhitespace, openLine } from "./insert.js";
import { Motion, applyMotion } from "./motion.js";
import { TextObject, textObjectForKey, textObjectRange } from "./object.js";
import { changeLines, changeMotion, changeRange } from "./normal/change.js";
import { deleteCharacters, deleteLines, deleteMotion, deleteRange } from "./normal/delete.js";
import { paste } from "./normal/paste.js";
import { yankLines, yankMotion, yankRange } from "./normal/yank.js";
import { RegisterName, Registers, parseRegisterName } from "./registers.js";
import { KeyResult, Operator, charwiseSelection, selectionHead } from "./state.js";

type PendingOperator = {
  operator: Operator;
  count: number;
};

type PendingPrefix = "g" | "register";
type PendingTextObject = { around: boolean };

export type NormalKeyResult = {
  keyResult: KeyResult;
  enterInsert: boolean;
};

function handled({ enterInsert = false }: { enterInsert?: boolean } = {}): NormalKeyResult {
  return { keyResult: "handled", enterInsert };
}

export class NormalMode {
  private countBuffer = "";
  private pendingOperator: PendingOperator | undefined;
  private pendingPrefix: PendingPrefix | undefined;
  private pendingTextObject: PendingTextObject | undefined;
  private pendingSearch: string | undefined;
  private lastSearch: string | undefined;
  private selectedRegister: RegisterName | undefined;

  constructor(
    private readonly editor: VimEditorCapabilities,
    private readonly registers: Registers
  ) {}

  isPending(): boolean {
    return this.pendingOperator !== undefined || this.pendingPrefix !== undefined || this.pendingTextObject !== undefined || this.pendingSearch !== undefined || this.selectedRegister !== undefined || this.countBuffer.length > 0;
  }

  pendingOperatorName(): Operator | undefined {
    return this.pendingOperator?.operator;
  }

  pendingChord(): string {
    if (this.pendingSearch !== undefined) return `/${this.pendingSearch}`;
    const count = this.countBuffer;
    const operator = this.pendingOperator === undefined ? "" : keyForOperator(this.pendingOperator.operator);
    if (this.pendingTextObject !== undefined) return `${count}${operator}${this.pendingTextObject.around ? "a" : "i"}`;
    if (this.pendingPrefix === "register") return `${count}${operator}\"`;
    if (this.pendingPrefix === "g") return `${count}g`;
    if (this.selectedRegister !== undefined) return `${count}\"${this.selectedRegister}`;
    if (operator !== "") return `${count}${operator}`;
    return count;
  }

  clearPending(): void {
    this.countBuffer = "";
    this.pendingOperator = undefined;
    this.pendingPrefix = undefined;
    this.pendingTextObject = undefined;
    this.pendingSearch = undefined;
    this.selectedRegister = undefined;
  }

  // Zed: assets/keymaps/vim.json plus `vim_operator` / `vim_mode` contexts.
  // This first slice hard-codes the tiny keymap until we introduce a Zed-like
  // declarative keymap file.
  onKey(key: string): NormalKeyResult {
    if (this.pendingSearch !== undefined) {
      this.handlePendingSearchKey(key);
      return handled();
    }

    if (this.pendingTextObject !== undefined) {
      const object = textObjectForKey(key);
      if (object === undefined) {
        this.clearPending();
        return handled();
      }
      return handled({ enterInsert: this.handleTextObject(object, this.pendingTextObject.around) });
    }

    if (this.pendingPrefix === "register") {
      this.pendingPrefix = undefined;
      const registerName = parseRegisterName(key);
      if (registerName === undefined) {
        this.clearPending();
        return handled();
      }
      this.selectedRegister = registerName;
      return handled();
    }

    if (this.pendingPrefix === "g") {
      this.pendingPrefix = undefined;
      if (key === "g") {
        const count = this.takeCount(1);
        this.moveToLine(count - 1);
        this.selectedRegister = undefined;
        return handled();
      }
      this.clearPending();
      return handled();
    }

    if (this.isCountKey(key)) {
      this.countBuffer += key;
      return handled();
    }

    if (key === "g") {
      this.pendingPrefix = "g";
      return handled();
    }

    if (key === '"') {
      this.pendingPrefix = "register";
      return handled();
    }

    if (key === "/") {
      this.pendingSearch = "";
      return handled();
    }

    if (key === "n") {
      this.repeatSearch();
      return handled();
    }

    if (this.pendingOperator !== undefined && (key === "i" || key === "a")) {
      this.pendingTextObject = { around: key === "a" };
      return handled();
    }

    const motion = motionForKey(key);
    if (motion !== undefined) {
      return handled({ enterInsert: this.handleMotion(motion) });
    }

    if (key === "G") {
      const maybeLine = this.takeCount(undefined);
      this.moveToLine(maybeLine === undefined ? this.editor.lineCount() - 1 : maybeLine - 1);
      this.selectedRegister = undefined;
      return handled();
    }

    if (key === "enter") {
      this.moveToNextLineStart();
      this.selectedRegister = undefined;
      return handled();
    }

    if (key === "backspace") {
      this.moveSelections({ type: "wrappingLeft" }, this.takeCount(1));
      this.selectedRegister = undefined;
      return handled();
    }

    if (isOperatorKey(key)) {
      if (this.pendingOperator?.operator === operatorForKey(key)) {
        return handled({ enterInsert: this.handleLineOperator(this.pendingOperator.operator) });
      } else {
        // Zed: `vim::Vim::push_operator`.
        this.pendingOperator = { operator: operatorForKey(key), count: this.takeCount(1) };
      }
      return handled();
    }

    switch (key) {
      case "i":
        this.selectedRegister = undefined;
        enterInsertAtSelections(this.editor, (pos) => pos);
        return handled({ enterInsert: true });
      case "a":
        this.selectedRegister = undefined;
        enterInsertAtSelections(this.editor, (pos) => ({
          row: pos.row,
          column: Math.min(pos.column + 1, this.editor.lineLength(pos.row)),
        }));
        return handled({ enterInsert: true });
      case "I":
        this.selectedRegister = undefined;
        enterInsertAtSelections(this.editor, (pos) => firstNonWhitespace(this.editor.line(pos.row), pos.row));
        return handled({ enterInsert: true });
      case "A":
        this.selectedRegister = undefined;
        enterInsertAtSelections(this.editor, (pos) => ({ row: pos.row, column: this.editor.lineLength(pos.row) }));
        return handled({ enterInsert: true });
      case "o":
        this.selectedRegister = undefined;
        openLine(this.editor, { above: false });
        return handled({ enterInsert: true });
      case "O":
        this.selectedRegister = undefined;
        openLine(this.editor, { above: true });
        return handled({ enterInsert: true });
      case "x":
        deleteCharacters(this.editor, this.registers, this.takeSelectedRegister(), this.takeCount(1));
        return handled();
      case "p":
        paste(this.editor, this.registers, this.takeSelectedRegister(), { before: false });
        return handled();
      case "P":
        paste(this.editor, this.registers, this.takeSelectedRegister(), { before: true });
        return handled();
      default:
        this.clearPending();
        return handled();
    }
  }

  // Zed: `motion::Vim::motion`, which combines counts, forced-motion state,
  // active operators, and mode-specific motion handling.
  private handleMotion(motion: Motion): boolean {
    const postCount = this.takeCount(1);
    const pending = this.pendingOperator;
    this.pendingOperator = undefined;

    if (pending === undefined) {
      this.moveSelections(motion, postCount);
      this.selectedRegister = undefined;
      return false;
    } else {
      return this.applyOperatorToMotion(pending.operator, motion, pending.count * postCount);
    }
  }

  private moveSelections(motion: Motion, count: number): void {
    this.editor.setSelections(
      this.editor.getSelections().map((selection) => {
        const head = applyMotion(this.editor, selectionHead(selection), motion, count);
        return charwiseSelection(head);
      })
    );
  }

  private moveToLine(row: number): void {
    const targetRow = Math.max(0, Math.min(row, this.editor.lineCount() - 1));
    this.editor.setSelections(
      this.editor.getSelections().map((selection) => {
        const head = selectionHead(selection);
        return charwiseSelection({
          row: targetRow,
          column: Math.min(head.column, Math.max(0, this.editor.lineLength(targetRow) - 1)),
        });
      })
    );
  }

  private moveToNextLineStart(): void {
    this.editor.setSelections(
      this.editor.getSelections().map((selection) => {
        const head = selectionHead(selection);
        const targetRow = Math.min(head.row + 1, this.editor.lineCount() - 1);
        return charwiseSelection(firstNonWhitespace(this.editor.line(targetRow), targetRow));
      })
    );
  }

  private handlePendingSearchKey(key: string): void {
    if (this.pendingSearch === undefined) return;
    if (key === "enter") {
      const query = this.pendingSearch;
      this.pendingSearch = undefined;
      if (query.length > 0) {
        this.lastSearch = query;
        this.searchForward(query);
      }
      return;
    }
    if (key === "backspace") {
      this.pendingSearch = this.pendingSearch.slice(0, -1);
      return;
    }
    this.pendingSearch += key === "space" ? " " : key;
  }

  private repeatSearch(): void {
    if (this.lastSearch !== undefined) {
      this.searchForward(this.lastSearch);
    }
  }

  private searchForward(query: string): void {
    const text = documentText(this.editor);
    this.editor.setSelections(
      this.editor.getSelections().map((selection) => {
        const head = selectionHead(selection);
        const startOffset = offsetOfPosition(this.editor, head) + 1;
        const found = findWithWrap(text, query, startOffset);
        return found === undefined ? charwiseSelection(head) : charwiseSelection(positionOfOffset(this.editor, found));
      })
    );
  }

  private handleTextObject(object: TextObject, around: boolean): boolean {
    const pending = this.pendingOperator;
    this.pendingTextObject = undefined;
    this.pendingOperator = undefined;
    if (pending === undefined) {
      return false;
    }

    const registerName = this.takeSelectedRegister();
    switch (pending.operator) {
      case "change":
        changeRange(this.editor, this.registers, registerName, (head) => textObjectRange(this.editor, head, object, { around }));
        return true;
      case "delete":
        deleteRange(this.editor, this.registers, registerName, (head) => textObjectRange(this.editor, head, object, { around }));
        return false;
      case "yank":
        yankRange(this.editor, this.registers, registerName, (head) => textObjectRange(this.editor, head, object, { around }));
        return false;
    }
  }

  // Zed: `normal::Vim::normal_motion` dispatches active operators to
  // `normal::change::Vim::change_motion`, `normal::delete::Vim::delete_motion`,
  // or `normal::yank::Vim::yank_motion`.
  private applyOperatorToMotion(operator: Operator, motion: Motion, count: number): boolean {
    const registerName = this.takeSelectedRegister();
    switch (operator) {
      case "change":
        changeMotion(this.editor, this.registers, registerName, motion, count);
        return true;
      case "delete":
        deleteMotion(this.editor, this.registers, registerName, motion, count);
        return false;
      case "yank":
        yankMotion(this.editor, this.registers, registerName, motion, count);
        return false;
    }
  }

  // Zed: `dd`/`cc`/`yy` are represented as operator + `motion::Motion::CurrentLine`.
  private handleLineOperator(operator: Operator): boolean {
    const postCount = this.takeCount(1);
    const pendingCount = this.pendingOperator?.count ?? 1;
    const count = pendingCount * postCount;
    this.pendingOperator = undefined;

    const registerName = this.takeSelectedRegister();
    switch (operator) {
      case "change":
        changeLines(this.editor, this.registers, registerName, count);
        return true;
      case "delete":
        deleteLines(this.editor, this.registers, registerName, count);
        return false;
      case "yank":
        yankLines(this.editor, this.registers, registerName, count);
        return false;
    }
  }

  // Zed: `vim::Vim::take_count`; count digit accumulation is handled by
  // `vim::Vim::push_count_digit`.
  private takeCount(defaultValue: number): number;
  private takeCount(defaultValue: undefined): number | undefined;
  private takeCount(defaultValue: number | undefined): number | undefined {
    if (this.countBuffer.length === 0) return defaultValue;
    const count = Number(this.countBuffer);
    this.countBuffer = "";
    return count;
  }

  private isCountKey(key: string): boolean {
    if (!/^\d$/.test(key)) return false;
    return key !== "0" || this.countBuffer.length > 0 || this.pendingOperator !== undefined;
  }

  private takeSelectedRegister(): RegisterName | undefined {
    const registerName = this.selectedRegister;
    this.selectedRegister = undefined;
    return registerName;
  }
}

// Zed: assets/keymaps/vim.json maps keys to action structs, and
// `motion::register` registers those actions to concrete `Motion` variants.
// This local mapping is the temporary minimal equivalent.
function motionForKey(key: string): Motion | undefined {
  switch (key) {
    case "h":
      return { type: "left" };
    case "l":
      return { type: "right" };
    case "k":
      return { type: "up" };
    case "j":
      return { type: "down" };
    case "0":
      return { type: "startOfLine" };
    case "^":
      return { type: "firstNonWhitespace" };
    case "$":
      return { type: "endOfLine" };
    case "w":
      return { type: "nextWordStart", bigWord: false };
    case "W":
      return { type: "nextWordStart", bigWord: true };
    case "e":
      return { type: "nextWordEnd", bigWord: false };
    case "E":
      return { type: "nextWordEnd", bigWord: true };
    case "b":
      return { type: "previousWordStart", bigWord: false };
    case "B":
      return { type: "previousWordStart", bigWord: true };
    default:
      return undefined;
  }
}

function documentText(editor: VimEditorCapabilities): string {
  const lines: string[] = [];
  for (let row = 0; row < editor.lineCount(); row++) {
    lines.push(editor.line(row));
  }
  return lines.join("\n");
}

function findWithWrap(text: string, query: string, startOffset: number): number | undefined {
  const fromStart = text.indexOf(query, startOffset);
  if (fromStart >= 0) return fromStart;
  const wrapped = text.indexOf(query, 0);
  return wrapped >= 0 ? wrapped : undefined;
}

function offsetOfPosition(editor: VimEditorCapabilities, position: ReturnType<typeof selectionHead>): number {
  let offset = 0;
  for (let row = 0; row < position.row; row++) {
    offset += editor.lineLength(row) + 1;
  }
  return offset + position.column;
}

function positionOfOffset(editor: VimEditorCapabilities, offset: number): ReturnType<typeof selectionHead> {
  let remaining = offset;
  for (let row = 0; row < editor.lineCount(); row++) {
    const lineLength = editor.lineLength(row);
    if (remaining <= lineLength) return { row, column: remaining };
    remaining -= lineLength + 1;
  }
  const lastRow = editor.lineCount() - 1;
  return { row: lastRow, column: Math.max(0, editor.lineLength(lastRow) - 1) };
}

function isOperatorKey(key: string): boolean {
  return key === "d" || key === "c" || key === "y";
}

function keyForOperator(operator: Operator): string {
  switch (operator) {
    case "delete":
      return "d";
    case "change":
      return "c";
    case "yank":
      return "y";
  }
}

// Zed: assets/keymaps/vim.json maps `d`, `c`, and `y` to `PushDelete`,
// `PushChange`, and `PushYank`, which call `push_operator` in vim.rs.
function operatorForKey(key: string): Operator {
  switch (key) {
    case "d":
      return "delete";
    case "c":
      return "change";
    case "y":
      return "yank";
    default:
      throw new Error(`not an operator key: ${key}`);
  }
}
