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

type PendingEditOperator =
  | { type: "change"; count: number }
  | { type: "delete"; count: number }
  | { type: "yank"; count: number };

type PendingObjectOperator = { type: "object"; around: boolean };

type PendingConvertOperator =
  | { type: "lowercase"; count: number }
  | { type: "uppercase"; count: number }
  | { type: "oppositeCase"; count: number };

type PendingIndentOperator =
  | { type: "indent"; count: number }
  | { type: "outdent"; count: number }
  | { type: "autoIndent"; count: number };

type PendingSurroundOperator =
  | { type: "addSurrounds"; count: number; target?: PendingSurroundTarget }
  | { type: "deleteSurrounds" }
  | { type: "changeSurrounds"; fromKey?: string };

type PendingReplaceOperator = { type: "replace"; count: number };
type PendingDigraphOperator = { type: "digraph"; count: number; first?: string };
type PendingRegisterOperator = { type: "register" };

type PendingSurroundTarget =
  | { type: "object"; around: boolean }
  | { type: "ranges"; ranges: readonly TextRange[]; linewise: boolean };

type PendingOperator =
  | PendingEditOperator
  | PendingObjectOperator
  | PendingConvertOperator
  | PendingIndentOperator
  | PendingSurroundOperator
  | PendingReplaceOperator
  | PendingDigraphOperator
  | PendingRegisterOperator;

type PendingPrefix = "g" | "indent";

const editOperatorTypes = new Set<PendingEditOperator["type"]>(["change", "delete", "yank"]);
const convertOperatorTypes = new Set<PendingConvertOperator["type"]>(["lowercase", "uppercase", "oppositeCase"]);
const indentOperatorTypes = new Set<PendingIndentOperator["type"]>(["indent", "outdent", "autoIndent"]);
const surroundOperatorTypes = new Set<PendingSurroundOperator["type"]>(["addSurrounds", "deleteSurrounds", "changeSurrounds"]);
const replaceOperatorTypes = new Set<PendingReplaceOperator["type"]>(["replace"]);
const digraphOperatorTypes = new Set<PendingDigraphOperator["type"]>(["digraph"]);
const registerOperatorTypes = new Set<PendingRegisterOperator["type"]>(["register"]);

function pendingEditOperator(operator: Operator, count: number): PendingEditOperator {
  switch (operator) {
    case "change":
      return { type: "change", count };
    case "delete":
      return { type: "delete", count };
    case "yank":
      return { type: "yank", count };
  }
}

function editOperatorForPending(operator: PendingEditOperator): Operator {
  switch (operator.type) {
    case "change":
      return "change";
    case "delete":
      return "delete";
    case "yank":
      return "yank";
  }
}

function pendingConvertOperator(target: ConvertTarget, count: number): PendingConvertOperator {
  switch (target) {
    case "lower":
      return { type: "lowercase", count };
    case "upper":
      return { type: "uppercase", count };
    case "toggle":
      return { type: "oppositeCase", count };
  }
}

function convertTargetForPending(operator: PendingConvertOperator): ConvertTarget {
  switch (operator.type) {
    case "lowercase":
      return "lower";
    case "uppercase":
      return "upper";
    case "oppositeCase":
      return "toggle";
  }
}

function pendingIndentOperator(direction: IndentDirection, count: number): PendingIndentOperator {
  switch (direction) {
    case "in":
      return { type: "indent", count };
    case "out":
      return { type: "outdent", count };
    case "auto":
      return { type: "autoIndent", count };
  }
}

function indentDirectionForPending(operator: PendingIndentOperator): IndentDirection {
  switch (operator.type) {
    case "indent":
      return "in";
    case "outdent":
      return "out";
    case "autoIndent":
      return "auto";
  }
}

function isSurroundOperator(operator: PendingOperator): operator is PendingSurroundOperator {
  return surroundOperatorTypes.has(operator.type as PendingSurroundOperator["type"]);
}

function isWaitingOperator(operator: PendingOperator): boolean {
  switch (operator.type) {
    case "addSurrounds":
    case "deleteSurrounds":
    case "changeSurrounds":
    case "replace":
    case "digraph":
    case "register":
      return true;
    case "change":
    case "delete":
    case "yank":
    case "object":
    case "lowercase":
    case "uppercase":
    case "oppositeCase":
    case "indent":
    case "outdent":
    case "autoIndent":
      return false;
  }
}

function operatorStatus(operator: PendingOperator): string {
  switch (operator.type) {
    case "change":
      return "c";
    case "delete":
      return "d";
    case "yank":
      return "y";
    case "object":
      return operator.around ? "a" : "i";
    case "lowercase":
      return "gu";
    case "uppercase":
      return "gU";
    case "oppositeCase":
      return "g~";
    case "indent":
      return ">";
    case "outdent":
      return "<";
    case "autoIndent":
      return "=";
    case "addSurrounds":
      return "ys";
    case "deleteSurrounds":
      return "ds";
    case "changeSurrounds":
      return operator.fromKey === undefined ? "cs" : `cs${operator.fromKey}`;
    case "replace":
      return "r";
    case "digraph":
      return operator.first === undefined ? "ctrl-k" : `ctrl-k${operator.first}`;
    case "register":
      return "\"";
  }
}

type NormalKeyHandler = () => NormalKeyResult;

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
  private pendingStack: PendingOperator[] = [];
  private pendingPrefix: PendingPrefix | undefined;
  private selectedRegister: RegisterName | undefined;

  private readonly keyHandlers: ReadonlyMap<string, NormalKeyHandler> = new Map([
    ["i", () => this.insertBefore()],
    ["a", () => this.insertAfter()],
    ["I", () => this.insertFirstNonWhitespace()],
    ["A", () => this.insertEndOfLine()],
    ["o", () => this.openLineBelow()],
    ["O", () => this.openLineAbove()],
    ["r", () => this.startReplace()],
    ["s", () => this.substituteCharacters()],
    ["S", () => this.substituteLines()],
    ["C", () => this.changeToEndOfLine()],
    ["D", () => this.deleteToEndOfLine()],
    ["X", () => this.deleteLeft()],
    ["J", () => this.joinLines()],
    ["ctrl-a", () => this.increment()],
    ["ctrl-x", () => this.decrement()],
    ["x", () => this.deleteRight()],
    ["delete", () => this.deleteRight()],
    ["~", () => this.toggleCase()],
    ["p", () => this.pasteAfter()],
    ["P", () => this.pasteBefore()],
    ["+", () => this.moveDownFirstNonWhitespace()],
    ["-", () => this.moveUpFirstNonWhitespace()],
  ]);

  constructor(
    private readonly editor: VimEditorCapabilities,
    private readonly registers: Registers
  ) {}

  private activeEditOperator(): PendingEditOperator | undefined {
    return this.activeOperatorOfTypes(editOperatorTypes);
  }

  private activeConvert(): PendingConvertOperator | undefined {
    return this.activeOperatorOfTypes(convertOperatorTypes);
  }

  private activeIndent(): PendingIndentOperator | undefined {
    return this.activeOperatorOfTypes(indentOperatorTypes);
  }

  private activeSurround(): PendingSurroundOperator | undefined {
    return this.activeOperatorOfTypes(surroundOperatorTypes);
  }

  private activeReplace(): PendingReplaceOperator | undefined {
    return this.activeOperatorOfTypes(replaceOperatorTypes);
  }

  private activeDigraph(): PendingDigraphOperator | undefined {
    return this.activeOperatorOfTypes(digraphOperatorTypes);
  }

  private activeRegister(): PendingRegisterOperator | undefined {
    return this.activeOperatorOfTypes(registerOperatorTypes);
  }

  private activeOperatorOfTypes<const Type extends PendingOperator["type"]>(types: ReadonlySet<Type>): Extract<PendingOperator, { type: Type }> | undefined {
    for (let index = this.pendingStack.length - 1; index >= 0; index--) {
      const item = this.pendingStack[index];
      if (types.has(item.type as Type)) return item as Extract<PendingOperator, { type: Type }>;
    }
    return undefined;
  }

  private activeObject(): PendingObjectOperator | undefined {
    const item = this.pendingStack[this.pendingStack.length - 1];
    return item?.type === "object" ? item : undefined;
  }

  private pushEditOperator(operator: Operator, count: number): void {
    this.pendingStack.push(pendingEditOperator(operator, count));
  }

  private pushObject(around: boolean): void {
    this.pendingStack.push({ type: "object", around });
  }

  private pushConvert(target: ConvertTarget, count: number): void {
    this.pendingStack.push(pendingConvertOperator(target, count));
  }

  private pushIndent(direction: IndentDirection, count: number): void {
    this.pendingStack.push(pendingIndentOperator(direction, count));
  }

  private pushSurround(surround: PendingSurroundOperator): void {
    this.pendingStack.push(surround);
  }

  private pushReplace(count: number): void {
    this.pendingStack.push({ type: "replace", count });
  }

  private pushDigraph(count: number): void {
    this.pendingStack.push({ type: "digraph", count });
  }

  private pushRegister(): void {
    this.pendingStack.push({ type: "register" });
  }

  private replaceActiveDigraph(digraph: PendingDigraphOperator): void {
    for (let index = this.pendingStack.length - 1; index >= 0; index--) {
      if (this.pendingStack[index].type === "digraph") {
        this.pendingStack[index] = digraph;
        return;
      }
    }
    this.pendingStack.push(digraph);
  }

  private replaceActiveSurround(surround: PendingSurroundOperator): void {
    for (let index = this.pendingStack.length - 1; index >= 0; index--) {
      if (isSurroundOperator(this.pendingStack[index])) {
        this.pendingStack[index] = surround;
        return;
      }
    }
    this.pushSurround(surround);
  }

  private popEditOperator(): PendingEditOperator | undefined {
    return this.popOperatorOfTypes(editOperatorTypes);
  }

  private popConvert(): PendingConvertOperator | undefined {
    return this.popOperatorOfTypes(convertOperatorTypes);
  }

  private popIndent(): PendingIndentOperator | undefined {
    return this.popOperatorOfTypes(indentOperatorTypes);
  }

  private popSurround(): PendingSurroundOperator | undefined {
    return this.popOperatorOfTypes(surroundOperatorTypes);
  }

  private popReplace(): PendingReplaceOperator | undefined {
    return this.popOperatorOfTypes(replaceOperatorTypes);
  }

  private popDigraph(): PendingDigraphOperator | undefined {
    return this.popOperatorOfTypes(digraphOperatorTypes);
  }

  private popRegister(): PendingRegisterOperator | undefined {
    return this.popOperatorOfTypes(registerOperatorTypes);
  }

  private popOperatorOfTypes<const Type extends PendingOperator["type"]>(types: ReadonlySet<Type>): Extract<PendingOperator, { type: Type }> | undefined {
    for (let index = this.pendingStack.length - 1; index >= 0; index--) {
      const item = this.pendingStack[index];
      if (types.has(item.type as Type)) {
        this.pendingStack.splice(index, 1);
        return item as Extract<PendingOperator, { type: Type }>;
      }
    }
    return undefined;
  }

  private popObject(): PendingObjectOperator | undefined {
    const item = this.pendingStack[this.pendingStack.length - 1];
    if (item?.type !== "object") return undefined;
    this.pendingStack.pop();
    return item;
  }

  isPending(): boolean {
    return this.pendingStack.length > 0 || this.pendingPrefix !== undefined || this.selectedRegister !== undefined || this.countBuffer.length > 0;
  }

  pendingOperatorName(): Operator | undefined {
    const operator = this.activeEditOperator();
    return operator === undefined ? undefined : editOperatorForPending(operator);
  }

  isExpectingRegisterName(): boolean {
    return this.activeRegister() !== undefined;
  }

  systemClipboardRegisterToReadForKey(key: string): { registerName: RegisterName | undefined } | undefined {
    if (key !== "p" && key !== "P") return undefined;
    if (this.selectedRegister === undefined || isSystemClipboardRegister(this.selectedRegister)) {
      return { registerName: this.selectedRegister };
    }
    return undefined;
  }

  hasPendingNonCount(): boolean {
    return this.pendingStack.length > 0
      || this.pendingPrefix !== undefined
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
      && this.pendingStack.length === 0
      && this.pendingPrefix === undefined;
  }

  pendingChord(): string {
    const count = this.countBuffer;
    const activeTextObject = this.activeObject();
    const stackPrefix = this.pendingStackPrefix();
    if (activeTextObject !== undefined) return `${count}${stackPrefix}${activeTextObject.around ? "a" : "i"}`;
    if (this.activeSurround() !== undefined) return `${count}${stackPrefix}s`;
    if (this.activeRegister() !== undefined) return `${count}${stackPrefix}\"`;
    if (this.pendingPrefix === "g") return `${count}g`;
    if (this.selectedRegister !== undefined) return `${count}\"${this.selectedRegister}`;
    if (stackPrefix !== "") return `${count}${stackPrefix}`;
    return count;
  }

  private pendingStackPrefix(): string {
    const item = this.pendingStack.find(stackItem => stackItem.type !== "object" && !isWaitingOperator(stackItem));
    if (item === undefined) return "";
    switch (item.type) {
      case "change":
      case "delete":
      case "yank":
      case "lowercase":
      case "uppercase":
      case "oppositeCase":
      case "indent":
      case "outdent":
      case "autoIndent":
      case "addSurrounds":
      case "deleteSurrounds":
      case "changeSurrounds":
      case "replace":
      case "digraph":
      case "register":
        return operatorStatus(item);
      case "object":
        return "";
    }
  }

  clearPending(): void {
    this.countBuffer = "";
    this.pendingStack = [];
    this.pendingPrefix = undefined;
    this.selectedRegister = undefined;
  }

  // Zed: assets/keymaps/vim.json plus `vim_operator` / `vim_mode` contexts.
  // This first slice hard-codes the tiny keymap until we introduce a Zed-like
  // declarative keymap file.
  onKey(key: string): NormalKeyResult {
    if (this.activeDigraph() !== undefined) {
      this.handleDigraphKey(key);
      return handled();
    }

    if (this.activeReplace() !== undefined) {
      this.handleReplaceKey(key);
      return handled();
    }

    if (this.activeSurround() !== undefined) {
      return handled({ enterInsert: this.handleSurroundKey(key) });
    }

    const activeConvert = this.activeConvert();
    if (activeConvert !== undefined && this.activeObject() === undefined) {
      this.handleConvertKey(key);
      return handled();
    }

    const activeIndent = this.activeIndent();
    if (activeIndent !== undefined && this.activeObject() === undefined) {
      this.handleIndentKey(key);
      return handled();
    }

    const pendingTextObject = this.activeObject();
    if (pendingTextObject !== undefined) {
      const object = textObjectForKey(key);
      if (object === undefined) {
        this.clearPending();
        return handled();
      }
      return handled({ enterInsert: this.handleTextObject(object, pendingTextObject.around) });
    }

    if (this.activeRegister() !== undefined) {
      this.popRegister();
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
      this.pushRegister();
      return handled();
    }

    if (key === ">" || key === "<" || key === "=") {
      this.pushIndent(indentDirectionForKey(key), this.takeCount(1));
      return handled();
    }

    const activeOperator = this.activeEditOperator();
    if (activeOperator !== undefined && key === "s") {
      switch (activeOperator.type) {
        case "yank":
          this.pushSurround({ type: "addSurrounds", count: activeOperator.count });
          this.popEditOperator();
          return handled();
        case "delete":
          this.pushSurround({ type: "deleteSurrounds" });
          this.popEditOperator();
          return handled();
        case "change":
          this.pushSurround({ type: "changeSurrounds" });
          this.popEditOperator();
          return handled();
      }
    }

    if (activeOperator !== undefined && (key === "i" || key === "a")) {
      this.pushObject(key === "a");
      return handled();
    }

    if (key === "%") {
      const percent = this.takeCount(undefined);
      if (percent !== undefined) {
        return handled({ enterInsert: this.applyMotion({ type: "goToPercentage", percent }, 1) });
      }
    }

    const motion = motionForKey(key);
    if (motion !== undefined) {
      return handled({ enterInsert: this.applyMotion(motion, this.takeCount(1)) });
    }

    if (key === "G") {
      const maybeLine = this.takeCount(undefined);
      const targetRow = maybeLine === undefined ? this.editor.lineCount() - 1 : maybeLine - 1;
      if (this.activeEditOperator() !== undefined) {
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
      const operator = operatorForKey(key);
      if (this.activeEditOperator()?.type === operator) {
        return handled({ enterInsert: this.handleLineOperator(operator) });
      }
      // Zed: `vim::Vim::push_operator`.
      this.pushEditOperator(operator, this.takeCount(1));
      return handled();
    }

    const handler = this.keyHandlers.get(key);
    if (handler !== undefined) return handler();

    this.clearPending();
    return handled();
  }

  private insertBefore(): NormalKeyResult {
    const insertCount = this.takeCount(1);
    this.selectedRegister = undefined;
    enterInsertAtSelections(this.editor, (pos) => pos);
    return handled({ enterInsert: true, insertCount });
  }

  private insertAfter(): NormalKeyResult {
    const insertCount = this.takeCount(1);
    this.selectedRegister = undefined;
    enterInsertAtSelections(this.editor, (pos) => ({
      row: pos.row,
      column: Math.min(pos.column + 1, this.editor.lineLength(pos.row)),
    }));
    return handled({ enterInsert: true, insertCount });
  }

  private insertFirstNonWhitespace(): NormalKeyResult {
    const insertCount = this.takeCount(1);
    this.selectedRegister = undefined;
    enterInsertAtSelections(this.editor, (pos) => firstNonWhitespace(this.editor.line(pos.row), pos.row));
    return handled({ enterInsert: true, insertCount });
  }

  private insertEndOfLine(): NormalKeyResult {
    const insertCount = this.takeCount(1);
    this.selectedRegister = undefined;
    enterInsertAtSelections(this.editor, (pos) => ({ row: pos.row, column: this.editor.lineLength(pos.row) }));
    return handled({ enterInsert: true, insertCount });
  }

  private openLineBelow(): NormalKeyResult {
    const insertCount = this.takeCount(1);
    this.selectedRegister = undefined;
    openLine(this.editor, { above: false }, keepUndoTransactionOpen());
    return handled({ enterInsert: true, insertCount, insertSeparator: "\n" });
  }

  private openLineAbove(): NormalKeyResult {
    const insertCount = this.takeCount(1);
    this.selectedRegister = undefined;
    openLine(this.editor, { above: true }, keepUndoTransactionOpen());
    return handled({ enterInsert: true, insertCount, insertSeparator: "\n" });
  }

  private startReplace(): NormalKeyResult {
    this.pushReplace(this.takeCount(1));
    return handled();
  }

  private substituteCharacters(): NormalKeyResult {
    const count = this.takeCount(1);
    deleteCharacters(this.editor, this.registers, this.takeSelectedRegister(), count, keepUndoTransactionOpen());
    enterInsertAtSelections(this.editor, (pos) => pos);
    return handled({ enterInsert: true });
  }

  private substituteLines(): NormalKeyResult {
    this.handleLineOperator("change");
    return handled({ enterInsert: true });
  }

  private changeToEndOfLine(): NormalKeyResult {
    changeMotion(this.editor, this.registers, this.takeSelectedRegister(), { type: "endOfLine" }, this.takeCount(1));
    return handled({ enterInsert: true });
  }

  private deleteToEndOfLine(): NormalKeyResult {
    deleteMotion(this.editor, this.registers, this.takeSelectedRegister(), { type: "endOfLine" }, this.takeCount(1));
    return handled();
  }

  private deleteLeft(): NormalKeyResult {
    deleteCharactersBefore(this.editor, this.registers, this.takeSelectedRegister(), this.takeCount(1));
    return handled();
  }

  private joinLines(): NormalKeyResult {
    this.joinFromSelections({ insertWhitespace: true });
    return handled();
  }

  private increment(): NormalKeyResult {
    incrementNumbers(this.editor, this.takeCount(1));
    return handled();
  }

  private decrement(): NormalKeyResult {
    incrementNumbers(this.editor, -this.takeCount(1));
    return handled();
  }

  private deleteRight(): NormalKeyResult {
    deleteCharacters(this.editor, this.registers, this.takeSelectedRegister(), this.takeCount(1));
    return handled();
  }

  private toggleCase(): NormalKeyResult {
    toggleCaseCharacters(this.editor, this.takeCount(1));
    this.selectedRegister = undefined;
    return handled();
  }

  private pasteAfter(): NormalKeyResult {
    paste(this.editor, this.registers, this.takeSelectedRegister(), { before: false, count: this.takeCount(1) });
    return handled();
  }

  private pasteBefore(): NormalKeyResult {
    paste(this.editor, this.registers, this.takeSelectedRegister(), { before: true, count: this.takeCount(1) });
    return handled();
  }

  private moveDownFirstNonWhitespace(): NormalKeyResult {
    this.moveToLineFirstNonWhitespace(this.takeCount(1));
    this.selectedRegister = undefined;
    return handled();
  }

  private moveUpFirstNonWhitespace(): NormalKeyResult {
    this.moveToLineFirstNonWhitespace(-this.takeCount(1));
    this.selectedRegister = undefined;
    return handled();
  }

  // Zed: `motion::Vim::motion`, which combines counts, forced-motion state,
  // active operators, and mode-specific motion handling.
  applyMotion(motion: Motion, count: number): boolean {
    const pendingSurround = this.activeSurround();
    if (pendingSurround?.type === "addSurrounds" && pendingSurround.target === undefined) {
      const ranges = this.editor.getSelections().map(selection =>
        motionRange(this.editor, selectionHead(selection), motion, pendingSurround.count * count));
      this.replaceActiveSurround({ ...pendingSurround, target: { type: "ranges", ranges, linewise: false } });
      return false;
    }

    const pending = this.popEditOperator();

    if (pending === undefined) {
      const hostSelections = hostViewLineSelectionsForMotion(this.editor, motion, count, { displayLine: false, extend: false });
      if (hostSelections === undefined) this.moveSelections(motion, count);
      else this.editor.setSelections(hostSelections);
      this.selectedRegister = undefined;
      return false;
    } else {
      return this.applyOperatorToMotion(editOperatorForPending(pending), motion, pending.count * count);
    }
  }

  handleGKey(key: string): NormalKeyResult {
    if (key === "g") {
      const count = this.takeCount(1);
      if (this.activeEditOperator() !== undefined) {
        return handled({ enterInsert: this.applyLinewiseOperatorToRow(count - 1) });
      }
      this.moveToLine(count - 1);
      this.selectedRegister = undefined;
      return handled();
    }

    if ((key === "u" || key === "U" || key === "~") && this.activeEditOperator() === undefined) {
      this.pushConvert(convertTargetForKey(key), this.takeCount(1));
      return handled();
    }

    if (key === "J" && this.activeEditOperator() === undefined) {
      this.joinFromSelections({ insertWhitespace: false });
      return handled();
    }

    if ((key === "ctrl-a" || key === "ctrl-x") && this.activeEditOperator() === undefined) {
      const delta = (key === "ctrl-a" ? 1 : -1) * this.takeCount(1);
      incrementNumbers(this.editor, delta, delta);
      return handled();
    }

    if (key === "_") {
      return handled({ enterInsert: this.applyMotion({ type: "lastNonWhitespace" }, this.takeCount(1)) });
    }

    if ((key === "j" || key === "k") && this.activeEditOperator() === undefined) {
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
    const pending = this.activeIndent();
    if (pending === undefined) return;

    if (key === "i" || key === "a") {
      this.pushObject(key === "a");
      return;
    }

    this.popIndent();
    const direction = indentDirectionForPending(pending);
    if (key === keyForIndentDirection(direction)) {
      indentRanges(this.editor, currentLineRanges(this.editor, pending.count * this.takeCount(1)), direction);
      return;
    }

    const motion = motionForKey(key);
    if (motion === undefined) {
      this.clearPending();
      return;
    }
    const count = pending.count * this.takeCount(1);
    const ranges = this.editor.getSelections().map(selection => motionRange(this.editor, selectionHead(selection), motion, count));
    indentRanges(this.editor, ranges, direction);
  }

  private applyIndentTextObject(pending: PendingIndentOperator, object: TextObject, around: boolean): void {
    const objectCount = this.takeCount(1);
    const ranges = this.editor.getSelections().map(selection =>
      textObjectRange(this.editor, selectionHead(selection), object, {
        around,
        count: pending.count * objectCount,
      }));
    indentRanges(this.editor, ranges, indentDirectionForPending(pending));
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
    const pending = this.popReplace();
    if (pending === undefined || key.length === 0) return;
    if (key === "ctrl-k") {
      this.pushDigraph(pending.count);
      return;
    }
    replaceCharacters(this.editor, keyForInput(key), pending.count);
  }

  private handleDigraphKey(key: string): void {
    const pending = this.activeDigraph();
    if (pending === undefined) return;
    if (pending.first === undefined) {
      this.replaceActiveDigraph({ ...pending, first: keyForInput(key) });
      return;
    }
    this.popDigraph();
    replaceCharacters(this.editor, lookupDigraph(pending.first, keyForInput(key)), pending.count);
  }

  private handleSurroundKey(key: string): boolean {
    const pending = this.activeSurround();
    if (pending === undefined) return false;

    switch (pending.type) {
      case "deleteSurrounds":
        this.popSurround();
        deleteSurrounds(this.editor, key);
        return false;
      case "changeSurrounds":
        if (pending.fromKey === undefined) {
          this.replaceActiveSurround({ type: "changeSurrounds", fromKey: key });
        } else {
          this.popSurround();
          changeSurrounds(this.editor, pending.fromKey, key);
        }
        return false;
      case "addSurrounds":
        return this.handleAddSurroundsKey(pending, key);
    }
  }

  private handleAddSurroundsKey(pending: Extract<PendingSurroundOperator, { type: "addSurrounds" }>, key: string): boolean {
    if (pending.target?.type === "ranges") {
      this.popSurround();
      addSurrounds(this.editor, pending.target.ranges, key, { linewise: pending.target.linewise });
      return false;
    }

    const target = pending.target;
    if (target?.type === "object") {
      const object = textObjectForKey(key);
      if (object === undefined) {
        this.clearPending();
        return false;
      }
      const ranges = this.editor.getSelections().map(selection =>
        textObjectRange(this.editor, selectionHead(selection), object, { around: target.around }));
      this.replaceActiveSurround({ ...pending, target: { type: "ranges", ranges, linewise: false } });
      return false;
    }

    if (key === "i" || key === "a") {
      this.replaceActiveSurround({ ...pending, target: { type: "object", around: key === "a" } });
      return false;
    }
    if (key === "s") {
      const ranges = this.editor.getSelections().map(selection =>
        trimmedLineRange(this.editor, selectionHead(selection).row, pending.count));
      this.replaceActiveSurround({ ...pending, target: { type: "ranges", ranges, linewise: false } });
      return false;
    }
    const motion = motionForKey(key);
    if (motion !== undefined) {
      const ranges = this.editor.getSelections().map(selection =>
        motionRange(this.editor, selectionHead(selection), motion, pending.count));
      this.replaceActiveSurround({ ...pending, target: { type: "ranges", ranges, linewise: false } });
      return false;
    }
    this.clearPending();
    return false;
  }

  private handleConvertKey(key: string): void {
    const pending = this.activeConvert();
    if (pending === undefined) return;

    if (key === "i" || key === "a") {
      this.pushObject(key === "a");
      return;
    }

    this.popConvert();
    const target = convertTargetForPending(pending);
    if (key === keyForConvertTarget(target)) {
      this.convertCurrentLines(target, pending.count * this.takeCount(1));
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
    convertRanges(this.editor, ranges, target, (_range, index) => cursors[index] ?? _range.start);
  }

  private applyConvertTextObject(pending: PendingConvertOperator, object: TextObject, around: boolean): void {
    const objectCount = this.takeCount(1);
    const ranges = this.editor.getSelections().map(selection =>
      textObjectRange(this.editor, selectionHead(selection), object, {
        around,
        count: pending.count * objectCount,
      }));
    convertRanges(this.editor, ranges, convertTargetForPending(pending));
  }

  private convertCurrentLines(target: ConvertTarget, count: number): void {
    const ranges = this.editor.getSelections().map(selection => {
      const row = selectionHead(selection).row;
      return lineRange(this.editor, row, count);
    });
    convertRanges(this.editor, ranges, target);
  }

  private handleTextObject(object: TextObject, around: boolean): boolean {
    const pendingTextObject = this.popObject();
    if (pendingTextObject === undefined) return false;

    const pendingOperator = this.popEditOperator();
    if (pendingOperator !== undefined) {
      const objectCount = this.takeCount(1);
      const count = pendingOperator.count * objectCount;
      const registerName = this.takeSelectedRegister();
      return applyTextObjectOperator(this.editor, this.registers, registerName, editOperatorForPending(pendingOperator), object, { around, count });
    }

    const pendingConvert = this.popConvert();
    if (pendingConvert !== undefined) {
      this.applyConvertTextObject(pendingConvert, object, around);
      return false;
    }

    const pendingIndent = this.popIndent();
    if (pendingIndent !== undefined) {
      this.applyIndentTextObject(pendingIndent, object, around);
      return false;
    }

    return false;
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
    const pending = this.popEditOperator();
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

    switch (pending.type) {
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
    const pending = this.popEditOperator();
    const pendingCount = pending?.count ?? 1;
    const count = pendingCount * postCount;

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
