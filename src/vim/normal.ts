// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/normal.rs, assets/keymaps/vim.json
// - translated concepts: normal-mode key dispatch, count accumulation, pending operators
// - intentional differences: this first slice hard-codes a small keymap instead of using
//   Zed's declarative key-context system.

import { VimEditorCapabilities } from "./editor.js";
import { enterInsertAtSelections, firstNonWhitespace, openLine } from "./insert.js";
import { Motion, applyMotionWithGoal, lineRange, motionRange, motionForKey } from "./motion.js";
import { TextObject, textObjectForKey, textObjectRange } from "./object.js";
import { changeLines, changeMotion, changeRange } from "./normal/change.js";
import { deleteCharacters, deleteLines, deleteMotion, deleteRange } from "./normal/delete.js";
import { paste } from "./normal/paste.js";
import { yankLines, yankMotion, yankRange } from "./normal/yank.js";
import { RegisterName, Registers, parseRegisterName } from "./registers.js";
import { replaceCharacters } from "./replace.js";
import { addSurrounds, changeSurrounds, deleteSurrounds } from "./surrounds.js";
import { KeyResult, Operator, TextRange, charwiseSelection, selectionHead } from "./state.js";

type PendingOperator = {
  operator: Operator;
  count: number;
};

type PendingPrefix = "g" | "register";
type PendingTextObject = { around: boolean };
type PendingSurround =
  | { type: "addTarget"; count: number }
  | { type: "addObject"; around: boolean; count: number }
  | { type: "addChar"; ranges: readonly TextRange[]; linewise: boolean }
  | { type: "deleteChar" }
  | { type: "changeFrom" }
  | { type: "changeTo"; fromKey: string };

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
  private pendingSurround: PendingSurround | undefined;
  private pendingReplaceCount: number | undefined;
  private selectedRegister: RegisterName | undefined;

  constructor(
    private readonly editor: VimEditorCapabilities,
    private readonly registers: Registers
  ) {}

  isPending(): boolean {
    return this.pendingOperator !== undefined || this.pendingPrefix !== undefined || this.pendingTextObject !== undefined || this.pendingSurround !== undefined || this.pendingReplaceCount !== undefined || this.selectedRegister !== undefined || this.countBuffer.length > 0;
  }

  pendingOperatorName(): Operator | undefined {
    return this.pendingOperator?.operator;
  }

  isExpectingRegisterName(): boolean {
    return this.pendingPrefix === "register";
  }

  pendingChord(): string {
    const count = this.countBuffer;
    const operator = this.pendingOperator === undefined ? "" : keyForOperator(this.pendingOperator.operator);
    if (this.pendingTextObject !== undefined) return `${count}${operator}${this.pendingTextObject.around ? "a" : "i"}`;
    if (this.pendingSurround !== undefined) return `${count}${operator}s`;
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
    this.pendingSurround = undefined;
    this.pendingReplaceCount = undefined;
    this.selectedRegister = undefined;
  }

  // Zed: assets/keymaps/vim.json plus `vim_operator` / `vim_mode` contexts.
  // This first slice hard-codes the tiny keymap until we introduce a Zed-like
  // declarative keymap file.
  onKey(key: string): NormalKeyResult {
    if (this.pendingReplaceCount !== undefined) {
      this.handleReplaceKey(key);
      return handled();
    }

    if (this.pendingSurround !== undefined) {
      return handled({ enterInsert: this.handleSurroundKey(key) });
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

    if (this.pendingOperator !== undefined && key === "s") {
      switch (this.pendingOperator.operator) {
        case "yank":
          this.pendingSurround = { type: "addTarget", count: this.pendingOperator.count };
          this.pendingOperator = undefined;
          return handled();
        case "delete":
          this.pendingSurround = { type: "deleteChar" };
          this.pendingOperator = undefined;
          return handled();
        case "change":
          this.pendingSurround = { type: "changeFrom" };
          this.pendingOperator = undefined;
          return handled();
      }
    }

    if (this.pendingOperator !== undefined && (key === "i" || key === "a")) {
      this.pendingTextObject = { around: key === "a" };
      return handled();
    }

    const motion = motionForKey(key);
    if (motion !== undefined) {
      return handled({ enterInsert: this.applyMotion(motion, this.takeCount(1)) });
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
      case "r":
        this.pendingReplaceCount = this.takeCount(1);
        return handled();
      case "x":
        deleteCharacters(this.editor, this.registers, this.takeSelectedRegister(), this.takeCount(1));
        return handled();
      case "p":
        paste(this.editor, this.registers, this.takeSelectedRegister(), { before: false, count: this.takeCount(1) });
        return handled();
      case "P":
        paste(this.editor, this.registers, this.takeSelectedRegister(), { before: true, count: this.takeCount(1) });
        return handled();
      default:
        this.clearPending();
        return handled();
    }
  }

  // Zed: `motion::Vim::motion`, which combines counts, forced-motion state,
  // active operators, and mode-specific motion handling.
  applyMotion(motion: Motion, count: number): boolean {
    if (this.pendingSurround?.type === "addTarget") {
      const pending = this.pendingSurround;
      const ranges = this.editor.getSelections().map(selection =>
        motionRange(this.editor, selectionHead(selection), motion, pending.count * count));
      this.pendingSurround = { type: "addChar", ranges, linewise: false };
      return false;
    }

    const pending = this.pendingOperator;
    this.pendingOperator = undefined;

    if (pending === undefined) {
      this.moveSelections(motion, count);
      this.selectedRegister = undefined;
      return false;
    } else {
      return this.applyOperatorToMotion(pending.operator, motion, pending.count * count);
    }
  }

  private moveSelections(motion: Motion, count: number): void {
    this.editor.setSelections(
      this.editor.getSelections().map((selection) => {
        const { position, goalColumn } = applyMotionWithGoal(
          this.editor,
          selectionHead(selection),
          motion,
          count,
          selection.goalColumn
        );
        const nextSelection = charwiseSelection(position);
        return goalColumn === undefined ? nextSelection : { ...nextSelection, goalColumn };
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

  private handleReplaceKey(key: string): void {
    const count = this.pendingReplaceCount;
    this.pendingReplaceCount = undefined;
    if (count === undefined || key.length === 0) return;
    replaceCharacters(this.editor, key, count);
  }

  private handleSurroundKey(key: string): boolean {
    const pending = this.pendingSurround;
    if (pending === undefined) return false;

    switch (pending.type) {
      case "deleteChar":
        this.pendingSurround = undefined;
        deleteSurrounds(this.editor, key);
        return false;
      case "changeFrom":
        this.pendingSurround = { type: "changeTo", fromKey: key };
        return false;
      case "changeTo":
        this.pendingSurround = undefined;
        changeSurrounds(this.editor, pending.fromKey, key);
        return false;
      case "addChar":
        this.pendingSurround = undefined;
        addSurrounds(this.editor, pending.ranges, key, { linewise: pending.linewise });
        return false;
      case "addObject": {
        const object = textObjectForKey(key);
        if (object === undefined) {
          this.clearPending();
          return false;
        }
        const ranges = this.editor.getSelections().map(selection =>
          textObjectRange(this.editor, selectionHead(selection), object, { around: pending.around }));
        this.pendingSurround = { type: "addChar", ranges, linewise: false };
        return false;
      }
      case "addTarget": {
        if (key === "i" || key === "a") {
          this.pendingSurround = { type: "addObject", around: key === "a", count: pending.count };
          return false;
        }
        if (key === "s") {
          const ranges = this.editor.getSelections().map(selection =>
            trimmedLineRange(this.editor, selectionHead(selection).row, pending.count));
          this.pendingSurround = { type: "addChar", ranges, linewise: false };
          return false;
        }
        const motion = motionForKey(key);
        if (motion !== undefined) {
          const ranges = this.editor.getSelections().map(selection =>
            motionRange(this.editor, selectionHead(selection), motion, pending.count));
          this.pendingSurround = { type: "addChar", ranges, linewise: false };
          return false;
        }
        this.clearPending();
        return false;
      }
    }
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
  takeCountForMotion(defaultValue: number): number {
    return this.takeCount(defaultValue);
  }

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

function trimmedLineRange(editor: VimEditorCapabilities, row: number, count: number): TextRange {
  const range = lineRange(editor, row, count);
  if (range.start.row !== range.end.row) return range;
  const line = editor.line(row);
  const first = line.search(/\S/);
  if (first < 0) return range;
  const last = line.search(/\s*$/);
  return { start: { row, column: first }, end: { row, column: last } };
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
