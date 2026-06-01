// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/normal.rs, assets/keymaps/vim.json
// - translated concepts: normal-mode key dispatch, count accumulation, pending operators
// - intentional differences: this first slice hard-codes a small keymap instead of using
//   Zed's declarative key-context system.

import { lookupDigraph } from "./digraph.js";
import { VimEditorCapabilities, keepUndoTransactionOpen } from "./editor.js";
import { enterInsertAtSelections, firstNonWhitespace, openLine } from "./insert.js";
import { Motion, applyMotionWithGoal, hostViewLineSelectionsForMotion, lineRange, motionRange, motionForKey } from "./motion.js";
import { TextObject, textObjectForKey, textObjectRange } from "./object.js";
import { changeLineRange, changeLines, changeMotion } from "./normal/change.js";
import { deleteCharacters, deleteCharactersBefore, deleteLineRange, deleteLines, deleteMotion } from "./normal/delete.js";
import { applyTextObjectOperator } from "./normal/object.js";
import { paste } from "./normal/paste.js";
import { yankLines, yankMotion } from "./normal/yank.js";
import { RegisterName, Registers, isSystemClipboardRegister, parseRegisterName } from "./registers.js";
import { replaceCharacters } from "./replace.js";
import { ConvertTarget, convertRanges, toggleCaseCharacters } from "./normal/convert.js";
import { IndentDirection, currentLineRanges, indentRanges } from "./normal/indent.js";
import { incrementNumbers } from "./normal/increment.js";
import { joinLines } from "./normal/join.js";
import { addSurrounds, changeSurrounds, deleteSurrounds } from "./surrounds.js";
import { KeyResult, Operator, TextRange, VimSelection, charwiseSelection, selectionHead } from "./state.js";

type PendingOperator = {
  operator: Operator;
  count: number;
};

type PendingPrefix = "g" | "register" | "indent";
type PendingTextObject = { around: boolean };
type PendingConvert = { target: ConvertTarget; count: number };
type PendingConvertTextObject = PendingConvert & { around: boolean };
type PendingIndent = { direction: IndentDirection; count: number };
type PendingIndentTextObject = PendingIndent & { around: boolean };
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
  insertCount: number;
  insertSeparator: string;
};

function handled(
  { enterInsert = false, insertCount = 1, insertSeparator = "" }: { enterInsert?: boolean; insertCount?: number; insertSeparator?: string } = {}
): NormalKeyResult {
  return { keyResult: "handled", enterInsert, insertCount, insertSeparator };
}

export class NormalMode {
  private countBuffer = "";
  private pendingOperator: PendingOperator | undefined;
  private pendingPrefix: PendingPrefix | undefined;
  private pendingTextObject: PendingTextObject | undefined;
  private pendingConvert: PendingConvert | undefined;
  private pendingConvertTextObject: PendingConvertTextObject | undefined;
  private pendingIndent: PendingIndent | undefined;
  private pendingIndentTextObject: PendingIndentTextObject | undefined;
  private pendingSurround: PendingSurround | undefined;
  private pendingReplaceCount: number | undefined;
  private pendingReplaceDigraph: { count: number; first?: string } | undefined;
  private selectedRegister: RegisterName | undefined;

  constructor(
    private readonly editor: VimEditorCapabilities,
    private readonly registers: Registers
  ) {}

  isPending(): boolean {
    return this.pendingOperator !== undefined || this.pendingPrefix !== undefined || this.pendingTextObject !== undefined || this.pendingConvert !== undefined || this.pendingConvertTextObject !== undefined || this.pendingIndent !== undefined || this.pendingIndentTextObject !== undefined || this.pendingSurround !== undefined || this.pendingReplaceCount !== undefined || this.pendingReplaceDigraph !== undefined || this.selectedRegister !== undefined || this.countBuffer.length > 0;
  }

  pendingOperatorName(): Operator | undefined {
    return this.pendingOperator?.operator;
  }

  isExpectingRegisterName(): boolean {
    return this.pendingPrefix === "register";
  }

  systemClipboardRegisterToReadForKey(key: string): { registerName: RegisterName | undefined } | undefined {
    if (key !== "p" && key !== "P") return undefined;
    if (this.selectedRegister === undefined || isSystemClipboardRegister(this.selectedRegister)) {
      return { registerName: this.selectedRegister };
    }
    return undefined;
  }

  hasPendingNonCount(): boolean {
    return this.pendingOperator !== undefined
      || this.pendingPrefix !== undefined
      || this.pendingTextObject !== undefined
      || this.pendingConvert !== undefined
      || this.pendingConvertTextObject !== undefined
      || this.pendingIndent !== undefined
      || this.pendingIndentTextObject !== undefined
      || this.pendingSurround !== undefined
      || this.pendingReplaceCount !== undefined
      || this.pendingReplaceDigraph !== undefined
      || this.selectedRegister !== undefined;
  }

  selectRegisterKey(key: string): void {
    const registerName = parseRegisterName(key);
    if (registerName !== undefined) this.selectedRegister = registerName;
  }

  takeSelectedRegisterForRepeat(): RegisterName | undefined {
    return this.takeSelectedRegister();
  }

  hasOnlySelectedRegisterPending(): boolean {
    return this.selectedRegister !== undefined
      && this.pendingOperator === undefined
      && this.pendingPrefix === undefined
      && this.pendingTextObject === undefined
      && this.pendingConvert === undefined
      && this.pendingConvertTextObject === undefined
      && this.pendingIndent === undefined
      && this.pendingIndentTextObject === undefined
      && this.pendingSurround === undefined
      && this.pendingReplaceCount === undefined
      && this.pendingReplaceDigraph === undefined;
  }

  pendingChord(): string {
    const count = this.countBuffer;
    const operator = this.pendingOperator === undefined ? "" : keyForOperator(this.pendingOperator.operator);
    if (this.pendingTextObject !== undefined) return `${count}${operator}${this.pendingTextObject.around ? "a" : "i"}`;
    if (this.pendingConvertTextObject !== undefined) return `${count}g${keyForConvertTarget(this.pendingConvertTextObject.target)}${this.pendingConvertTextObject.around ? "a" : "i"}`;
    if (this.pendingConvert !== undefined) return `${count}g${keyForConvertTarget(this.pendingConvert.target)}`;
    if (this.pendingIndentTextObject !== undefined) return `${count}${keyForIndentDirection(this.pendingIndentTextObject.direction)}${this.pendingIndentTextObject.around ? "a" : "i"}`;
    if (this.pendingIndent !== undefined) return `${count}${keyForIndentDirection(this.pendingIndent.direction)}`;
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
    this.pendingConvert = undefined;
    this.pendingConvertTextObject = undefined;
    this.pendingIndent = undefined;
    this.pendingIndentTextObject = undefined;
    this.pendingSurround = undefined;
    this.pendingReplaceCount = undefined;
    this.pendingReplaceDigraph = undefined;
    this.selectedRegister = undefined;
  }

  // Zed: assets/keymaps/vim.json plus `vim_operator` / `vim_mode` contexts.
  // This first slice hard-codes the tiny keymap until we introduce a Zed-like
  // declarative keymap file.
  onKey(key: string): NormalKeyResult {
    if (this.pendingReplaceDigraph !== undefined) {
      this.handleReplaceDigraphKey(key);
      return handled();
    }

    if (this.pendingReplaceCount !== undefined) {
      this.handleReplaceKey(key);
      return handled();
    }

    if (this.pendingSurround !== undefined) {
      return handled({ enterInsert: this.handleSurroundKey(key) });
    }

    if (this.pendingConvertTextObject !== undefined) {
      const object = textObjectForKey(key);
      if (object === undefined) {
        this.clearPending();
        return handled();
      }
      this.handleConvertTextObject(object);
      return handled();
    }

    if (this.pendingConvert !== undefined) {
      this.handleConvertKey(key);
      return handled();
    }

    if (this.pendingIndentTextObject !== undefined) {
      const object = textObjectForKey(key);
      if (object === undefined) {
        this.clearPending();
        return handled();
      }
      this.handleIndentTextObject(object);
      return handled();
    }

    if (this.pendingIndent !== undefined) {
      this.handleIndentKey(key);
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
      return this.handleGKey(key);
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

    if (key === ">" || key === "<" || key === "=") {
      this.pendingIndent = { direction: indentDirectionForKey(key), count: this.takeCount(1) };
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
      const targetRow = maybeLine === undefined ? this.editor.lineCount() - 1 : maybeLine - 1;
      if (this.pendingOperator !== undefined) {
        return handled({ enterInsert: this.applyLinewiseOperatorToRow(targetRow) });
      }
      this.moveToLine(targetRow);
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
      case "i": {
        const insertCount = this.takeCount(1);
        this.selectedRegister = undefined;
        enterInsertAtSelections(this.editor, (pos) => pos);
        return handled({ enterInsert: true, insertCount });
      }
      case "a": {
        const insertCount = this.takeCount(1);
        this.selectedRegister = undefined;
        enterInsertAtSelections(this.editor, (pos) => ({
          row: pos.row,
          column: Math.min(pos.column + 1, this.editor.lineLength(pos.row)),
        }));
        return handled({ enterInsert: true, insertCount });
      }
      case "I": {
        const insertCount = this.takeCount(1);
        this.selectedRegister = undefined;
        enterInsertAtSelections(this.editor, (pos) => firstNonWhitespace(this.editor.line(pos.row), pos.row));
        return handled({ enterInsert: true, insertCount });
      }
      case "A": {
        const insertCount = this.takeCount(1);
        this.selectedRegister = undefined;
        enterInsertAtSelections(this.editor, (pos) => ({ row: pos.row, column: this.editor.lineLength(pos.row) }));
        return handled({ enterInsert: true, insertCount });
      }
      case "o": {
        const insertCount = this.takeCount(1);
        this.selectedRegister = undefined;
        openLine(this.editor, { above: false }, keepUndoTransactionOpen());
        return handled({ enterInsert: true, insertCount, insertSeparator: "\n" });
      }
      case "O": {
        const insertCount = this.takeCount(1);
        this.selectedRegister = undefined;
        openLine(this.editor, { above: true }, keepUndoTransactionOpen());
        return handled({ enterInsert: true, insertCount, insertSeparator: "\n" });
      }
      case "r":
        this.pendingReplaceCount = this.takeCount(1);
        return handled();
      case "s": {
        const count = this.takeCount(1);
        deleteCharacters(this.editor, this.registers, this.takeSelectedRegister(), count, keepUndoTransactionOpen());
        enterInsertAtSelections(this.editor, (pos) => pos);
        return handled({ enterInsert: true });
      }
      case "S":
        this.handleLineOperator("change");
        return handled({ enterInsert: true });
      case "D":
        deleteMotion(this.editor, this.registers, this.takeSelectedRegister(), { type: "endOfLine" }, this.takeCount(1));
        return handled();
      case "X":
        deleteCharactersBefore(this.editor, this.registers, this.takeSelectedRegister(), this.takeCount(1));
        return handled();
      case "J":
        this.joinFromSelections({ insertWhitespace: true });
        return handled();
      case "ctrl-a":
        incrementNumbers(this.editor, this.takeCount(1));
        return handled();
      case "ctrl-x":
        incrementNumbers(this.editor, -this.takeCount(1));
        return handled();
      case "x":
      case "delete":
        deleteCharacters(this.editor, this.registers, this.takeSelectedRegister(), this.takeCount(1));
        return handled();
      case "~":
        toggleCaseCharacters(this.editor, this.takeCount(1));
        this.selectedRegister = undefined;
        return handled();
      case "p":
        paste(this.editor, this.registers, this.takeSelectedRegister(), { before: false, count: this.takeCount(1) });
        return handled();
      case "P":
        paste(this.editor, this.registers, this.takeSelectedRegister(), { before: true, count: this.takeCount(1) });
        return handled();
      case "+":
        this.moveToLineFirstNonWhitespace(this.takeCount(1));
        this.selectedRegister = undefined;
        return handled();
      case "-":
        this.moveToLineFirstNonWhitespace(-this.takeCount(1));
        this.selectedRegister = undefined;
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
      const hostSelections = hostViewLineSelectionsForMotion(this.editor, motion, count, { displayLine: false, extend: false });
      if (hostSelections === undefined) this.moveSelections(motion, count);
      else this.editor.setSelections(hostSelections);
      this.selectedRegister = undefined;
      return false;
    } else {
      return this.applyOperatorToMotion(pending.operator, motion, pending.count * count);
    }
  }

  handleGKey(key: string): NormalKeyResult {
    if (key === "g") {
      const count = this.takeCount(1);
      if (this.pendingOperator !== undefined) {
        return handled({ enterInsert: this.applyLinewiseOperatorToRow(count - 1) });
      }
      this.moveToLine(count - 1);
      this.selectedRegister = undefined;
      return handled();
    }

    if ((key === "u" || key === "U" || key === "~") && this.pendingOperator === undefined) {
      this.pendingConvert = { target: convertTargetForKey(key), count: this.takeCount(1) };
      return handled();
    }

    if (key === "J" && this.pendingOperator === undefined) {
      this.joinFromSelections({ insertWhitespace: false });
      return handled();
    }

    if ((key === "ctrl-a" || key === "ctrl-x") && this.pendingOperator === undefined) {
      const delta = (key === "ctrl-a" ? 1 : -1) * this.takeCount(1);
      incrementNumbers(this.editor, delta, delta);
      return handled();
    }

    if (key === "_") {
      return handled({ enterInsert: this.applyMotion({ type: "lastNonWhitespace" }, this.takeCount(1)) });
    }

    if ((key === "j" || key === "k") && this.pendingOperator === undefined) {
      const count = this.takeCount(1);
      const motion: Motion = { type: key === "j" ? "down" : "up" };
      const hostSelections = hostViewLineSelectionsForMotion(this.editor, motion, count, { displayLine: true, extend: false });
      if (hostSelections === undefined) this.moveSelections(motion, count);
      else this.editor.setSelections(hostSelections);
      this.selectedRegister = undefined;
      return handled();
    }

    this.clearPending();
    return handled();
  }

  private moveSelections(motion: Motion, count: number): void {
    this.editor.setSelections(
      this.editor.getSelections().map((selection) => {
        const { position, goal } = applyMotionWithGoal(
          this.editor,
          selectionHead(selection),
          motion,
          count,
          selection.goal
        );
        const nextSelection = charwiseSelection(position);
        return goal === undefined ? nextSelection : { ...nextSelection, goal };
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

  private moveToLineFirstNonWhitespace(rowDelta: number): void {
    this.editor.setSelections(
      this.editor.getSelections().map((selection) => {
        const head = selectionHead(selection);
        const targetRow = Math.max(0, Math.min(head.row + rowDelta, this.editor.lineCount() - 1));
        return charwiseSelection(firstNonWhitespace(this.editor.line(targetRow), targetRow));
      })
    );
  }

  private handleIndentKey(key: string): void {
    const pending = this.pendingIndent;
    this.pendingIndent = undefined;
    if (pending === undefined) return;

    if (key === "i" || key === "a") {
      this.pendingIndentTextObject = { ...pending, around: key === "a" };
      return;
    }

    if (key === keyForIndentDirection(pending.direction)) {
      indentRanges(this.editor, currentLineRanges(this.editor, pending.count * this.takeCount(1)), pending.direction);
      return;
    }

    const motion = motionForKey(key);
    if (motion === undefined) {
      this.clearPending();
      return;
    }
    const count = pending.count * this.takeCount(1);
    const ranges = this.editor.getSelections().map(selection => motionRange(this.editor, selectionHead(selection), motion, count));
    indentRanges(this.editor, ranges, pending.direction);
  }

  private handleIndentTextObject(object: TextObject): void {
    const pending = this.pendingIndentTextObject;
    this.pendingIndentTextObject = undefined;
    if (pending === undefined) return;

    const objectCount = this.takeCount(1);
    const ranges = this.editor.getSelections().map(selection =>
      textObjectRange(this.editor, selectionHead(selection), object, {
        around: pending.around,
        count: pending.count * objectCount,
      }));
    indentRanges(this.editor, ranges, pending.direction);
  }

  private joinFromSelections({ insertWhitespace }: { insertWhitespace: boolean }): void {
    const count = this.takeCount(1);
    for (const selection of this.editor.getSelections()) {
      joinLines(this.editor, selectionHead(selection).row, count <= 1 ? 1 : count - 1, { insertWhitespace });
      break;
    }
    this.selectedRegister = undefined;
  }

  private handleReplaceKey(key: string): void {
    const count = this.pendingReplaceCount;
    this.pendingReplaceCount = undefined;
    if (count === undefined || key.length === 0) return;
    if (key === "ctrl-k") {
      this.pendingReplaceDigraph = { count };
      return;
    }
    replaceCharacters(this.editor, keyForInput(key), count);
  }

  private handleReplaceDigraphKey(key: string): void {
    const pending = this.pendingReplaceDigraph;
    if (pending === undefined) return;
    if (pending.first === undefined) {
      this.pendingReplaceDigraph = { ...pending, first: keyForInput(key) };
      return;
    }
    this.pendingReplaceDigraph = undefined;
    replaceCharacters(this.editor, lookupDigraph(pending.first, keyForInput(key)), pending.count);
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

  private handleConvertKey(key: string): void {
    const pending = this.pendingConvert;
    this.pendingConvert = undefined;
    if (pending === undefined) return;

    if (key === "i" || key === "a") {
      this.pendingConvertTextObject = { ...pending, around: key === "a" };
      return;
    }

    if (key === keyForConvertTarget(pending.target)) {
      this.convertCurrentLines(pending.target, pending.count * this.takeCount(1));
      return;
    }

    const motion = motionForKey(key);
    if (motion === undefined) {
      this.clearPending();
      return;
    }

    const count = pending.count * this.takeCount(1);
    const ranges = this.editor.getSelections().map(selection => motionRange(this.editor, selectionHead(selection), motion, count));
    const cursors = this.editor.getSelections().map(selection => selectionHead(selection));
    convertRanges(this.editor, ranges, pending.target, (_range, index) => cursors[index] ?? _range.start);
  }

  private handleConvertTextObject(object: TextObject): void {
    const pending = this.pendingConvertTextObject;
    this.pendingConvertTextObject = undefined;
    if (pending === undefined) return;

    const objectCount = this.takeCount(1);
    const ranges = this.editor.getSelections().map(selection =>
      textObjectRange(this.editor, selectionHead(selection), object, {
        around: pending.around,
        count: pending.count * objectCount,
      }));
    convertRanges(this.editor, ranges, pending.target);
  }

  private convertCurrentLines(target: ConvertTarget, count: number): void {
    const ranges = this.editor.getSelections().map(selection => {
      const row = selectionHead(selection).row;
      return lineRange(this.editor, row, count);
    });
    convertRanges(this.editor, ranges, target);
  }

  private handleTextObject(object: TextObject, around: boolean): boolean {
    const pending = this.pendingOperator;
    const objectCount = this.takeCount(1);
    this.pendingTextObject = undefined;
    this.pendingOperator = undefined;
    if (pending === undefined) {
      return false;
    }

    const count = pending.count * objectCount;
    const registerName = this.takeSelectedRegister();
    return applyTextObjectOperator(this.editor, this.registers, registerName, pending.operator, object, { around, count });
  }

  // Zed: `normal::Vim::normal_motion` dispatches active operators to
  // `normal::change::Vim::change_motion`, `normal::delete::Vim::delete_motion`,
  // or `normal::yank::Vim::yank_motion`.
  private applyOperatorToMotion(operator: Operator, motion: Motion, count: number): boolean {
    const registerName = this.takeSelectedRegister();
    const sourceSelections = this.editor.getSelections();
    const hostSelections = hostViewLineSelectionsForMotion(this.editor, motion, count, { displayLine: false, extend: false });
    if (hostSelections !== undefined) {
      return this.applyOperatorToLinewiseSelections(operator, registerName, sourceSelections, hostSelections);
    }
    if (motion.type === "startOfDocument") {
      const targetSelections = sourceSelections.map(selection => charwiseSelection({ row: Math.min(count - 1, this.editor.lineCount() - 1), column: selectionHead(selection).column }));
      return this.applyOperatorToLinewiseSelections(operator, registerName, sourceSelections, targetSelections, { includeSameRow: true });
    }
    switch (operator) {
      case "change":
        return changeMotion(this.editor, this.registers, registerName, motion, count);
      case "delete":
        deleteMotion(this.editor, this.registers, registerName, motion, count);
        return false;
      case "yank":
        yankMotion(this.editor, this.registers, registerName, motion, count);
        return false;
    }
  }

  private applyOperatorToLinewiseSelections(
    operator: Operator,
    registerName: RegisterName | undefined,
    sourceSelections: readonly VimSelection[],
    targetSelections: readonly VimSelection[],
    { includeSameRow = false }: { includeSameRow?: boolean } = {}
  ): boolean {
    const rows = sourceSelections.flatMap((selection, index) => {
      const head = selectionHead(selection);
      const target = selectionHead(targetSelections[index] ?? selection);
      if (!includeSameRow && head.row === target.row) return [];
      return [{
        startRow: Math.min(head.row, target.row),
        endRow: Math.max(head.row, target.row),
        column: head.column,
      }];
    });
    if (rows.length === 0) return false;

    switch (operator) {
      case "change":
        return changeLineRange(this.editor, this.registers, registerName, rows);
      case "delete":
        deleteLineRange(this.editor, this.registers, registerName, rows);
        return false;
      case "yank":
        return false;
    }
  }

  private applyLinewiseOperatorToRow(targetRow: number): boolean {
    const pending = this.pendingOperator;
    this.pendingOperator = undefined;
    if (pending === undefined) return false;

    const registerName = this.takeSelectedRegister();
    const rows = this.editor.getSelections().map(selection => {
      const head = selectionHead(selection);
      return {
        startRow: Math.min(head.row, Math.max(0, Math.min(targetRow, this.editor.lineCount() - 1))),
        endRow: Math.max(head.row, Math.max(0, Math.min(targetRow, this.editor.lineCount() - 1))),
        column: head.column,
      };
    });

    switch (pending.operator) {
      case "change":
        return changeLineRange(this.editor, this.registers, registerName, rows);
      case "delete":
        deleteLineRange(this.editor, this.registers, registerName, rows);
        return false;
      case "yank":
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

  takeCountForRepeat(): number | undefined {
    return this.takeCount(undefined);
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
    return key !== "0" || this.countBuffer.length > 0;
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

function keyForInput(key: string): string {
  return key === "space" ? " " : key;
}

function isOperatorKey(key: string): boolean {
  return key === "d" || key === "c" || key === "y";
}

function indentDirectionForKey(key: string): IndentDirection {
  switch (key) {
    case ">":
      return "in";
    case "<":
      return "out";
    case "=":
      return "auto";
    default:
      throw new Error(`not an indent key: ${key}`);
  }
}

function keyForIndentDirection(direction: IndentDirection): string {
  switch (direction) {
    case "in":
      return ">";
    case "out":
      return "<";
    case "auto":
      return "=";
  }
}

function convertTargetForKey(key: string): ConvertTarget {
  switch (key) {
    case "u":
      return "lower";
    case "U":
      return "upper";
    case "~":
      return "toggle";
    default:
      throw new Error(`not a convert key: ${key}`);
  }
}

function keyForConvertTarget(target: ConvertTarget): string {
  switch (target) {
    case "lower":
      return "u";
    case "upper":
      return "U";
    case "toggle":
      return "~";
  }
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
