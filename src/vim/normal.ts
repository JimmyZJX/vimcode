// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/normal.rs, assets/keymaps/vim.json
// - translated concepts: normal-mode execution helpers for actions resolved by
//   keymap.ts and the central Vim operator stack.
// - intentional differences: a few ambiguous fallback paths still live here while they
//   are migrated into semantic actions.

import type { NormalCommand } from "./keymap.js";
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
import { RegisterName, Registers, isSystemClipboardRegister } from "./registers.js";
import { replaceCharacters } from "./replace.js";
import { ConvertTarget, convertRanges, toggleCaseCharacters } from "./normal/convert.js";
import { IndentDirection, currentLineRanges, indentRanges } from "./normal/indent.js";
import { joinLines } from "./normal/join.js";
import { addSurrounds, changeSurrounds, deleteSurrounds } from "./surrounds.js";
import { KeyResult, Operator, TextRange, VimSelection, charwiseSelection, selectionHead } from "./state.js";
import {
  VimOperatorStack,
  PendingConvertOperator,
  PendingIndentOperator,
  PendingSurroundOperator,
  convertTargetForPending,
  editOperatorForPending,
  indentDirectionForPending,
} from "./operator.js";

type CountState = {
  get: () => string;
  append: (key: string) => void;
  take: (defaultValue: number | undefined) => number | undefined;
  clear: () => void;
};

type RegisterSelection = {
  get: () => RegisterName | undefined;
  take: () => RegisterName | undefined;
  clear: () => void;
};

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

  constructor(
    private readonly editor: VimEditorCapabilities,
    private readonly registers: Registers,
    private readonly registerSelection: RegisterSelection,
    private readonly countState: CountState,
    private readonly operatorStack: VimOperatorStack
  ) {}

  chordKey(key: string, { includeCount = false }: { includeCount?: boolean } = {}) {
    return {
      key,
      includeCount,
      countText: this.countState.get(),
      hasSelectedRegister: this.registerSelection.get() !== undefined,
    };
  }

  private replaceActiveSurround(surround: PendingSurroundOperator): void {
    if (!this.operatorStack.replaceActiveSurround(surround)) this.operatorStack.pushSurround(surround);
  }

  isPending(): boolean {
    return this.operatorStack.length > 0 || this.countState.get().length > 0;
  }

  pendingOperatorName(): Operator | undefined {
    const operator = this.operatorStack.activeEditOperator();
    return operator === undefined ? undefined : editOperatorForPending(operator);
  }

  systemClipboardRegisterToReadForKey(key: string): { registerName: RegisterName | undefined } | undefined {
    if (key !== "p" && key !== "P") return undefined;
    const registerName = this.registerSelection.get();
    if (registerName === undefined || isSystemClipboardRegister(registerName)) {
      return { registerName };
    }
    return undefined;
  }

  joinLines({ insertWhitespace }: { insertWhitespace: boolean }): NormalKeyResult {
    this.joinFromSelections({ insertWhitespace });
    return handled();
  }

  handleEditOperatorKey(operator: Operator, key: string): NormalKeyResult {
    if (this.operatorStack.activeEditOperator()?.type === operator) {
      return handled({ enterInsert: this.handleLineOperator(operator) });
    }
    // Zed: `vim::Vim::push_operator`.
    this.operatorStack.pushEditOperator(operator, this.takeCount(1), this.chordKey(key, { includeCount: true }));
    return handled();
  }

  handlePendingDigraphKey(key: string): NormalKeyResult {
    this.handleDigraphKey(key);
    return handled();
  }

  handlePendingReplaceKey(key: string): NormalKeyResult {
    this.handleReplaceKey(key);
    return handled();
  }

  handlePendingSurroundKey(key: string): NormalKeyResult {
    return handled({ enterInsert: this.handleSurroundKey(key) });
  }

  handlePendingSurroundPrefixKey(): NormalKeyResult {
    const activeOperator = this.operatorStack.activeEditOperator();
    if (activeOperator === undefined) return handled();
    switch (activeOperator.type) {
      case "yank":
        this.operatorStack.pushSurround({ type: "addSurrounds", count: activeOperator.count });
        this.operatorStack.popEditOperator();
        return handled();
      case "delete":
        this.operatorStack.pushSurround({ type: "deleteSurrounds" });
        this.operatorStack.popEditOperator();
        return handled();
      case "change":
        this.operatorStack.pushSurround({ type: "changeSurrounds" });
        this.operatorStack.popEditOperator();
        return handled();
    }
  }

  handlePendingConvertKey(key: string): NormalKeyResult {
    this.handleConvertKey(key);
    return handled();
  }

  handlePendingIndentKey(key: string): NormalKeyResult {
    this.handleIndentKey(key);
    return handled();
  }

  handlePendingTextObjectKey(key: string): NormalKeyResult {
    const pendingTextObject = this.operatorStack.activeObject();
    if (pendingTextObject === undefined) return handled();
    const object = textObjectForKey(key);
    if (object === undefined) {
      this.clearPending();
      return handled();
    }
    return handled({ enterInsert: this.handleTextObject(object, pendingTextObject.around) });
  }

  handleCommand(command: NormalCommand): NormalKeyResult {
    switch (command.type) {
      case "insertBefore":
        return this.insertBefore();
      case "insertAfter":
        return this.insertAfter();
      case "insertFirstNonWhitespace":
        return this.insertFirstNonWhitespace();
      case "insertEndOfLine":
        return this.insertEndOfLine();
      case "openLine":
        return command.above ? this.openLineAbove() : this.openLineBelow();
      case "pushReplace":
        return this.startReplace();
      case "substituteCharacters":
        return this.substituteCharacters();
      case "substituteLines":
        return this.substituteLines();
      case "changeToEndOfLine":
        return this.changeToEndOfLine();
      case "deleteToEndOfLine":
        return this.deleteToEndOfLine();
      case "deleteLeft":
        return this.deleteLeft();
      case "deleteRight":
        return this.deleteRight();
      case "toggleCase":
        return this.toggleCase();
      case "paste":
        return command.before ? this.pasteBefore() : this.pasteAfter();
      case "moveLineFirstNonWhitespace":
        this.moveToLineFirstNonWhitespace(command.direction === "down" ? this.takeCount(1) : -this.takeCount(1));
        this.registerSelection.clear();
        return handled();
      case "percentOrMatching": {
        const percent = this.takeCount(undefined);
        return percent === undefined
          ? handled({ enterInsert: this.applyMotion({ type: "matching" }, 1) })
          : handled({ enterInsert: this.applyMotion({ type: "goToPercentage", percent }, 1) });
      }
      case "goToLineOrEnd": {
        const maybeLine = this.takeCount(undefined);
        const targetRow = maybeLine === undefined ? this.editor.lineCount() - 1 : maybeLine - 1;
        if (this.operatorStack.activeEditOperator() !== undefined) {
          return handled({ enterInsert: this.applyLinewiseOperatorToRow(targetRow) });
        }
        this.moveToLine(targetRow);
        this.registerSelection.clear();
        return handled();
      }
      case "moveToNextLineStart":
        this.moveToNextLineStart();
        this.registerSelection.clear();
        return handled();
      case "moveWrappingLeft":
        this.moveSelections({ type: "wrappingLeft" }, this.takeCount(1));
        this.registerSelection.clear();
        return handled();
    }
  }

  pendingChord(): string {
    if (this.operatorStack.length > 0) {
      return `${this.operatorStack.chordText()}${this.countState.get()}`;
    }
    return this.countState.get();
  }

  clearPending(): void {
    this.countState.clear();
    this.operatorStack.clear();
    this.operatorStack.clearChordKeys();
    this.registerSelection.clear();
  }

  handleUnhandledKey(): NormalKeyResult {
    this.clearPending();
    return handled();
  }

  private insertBefore(): NormalKeyResult {
    const insertCount = this.takeCount(1);
    this.registerSelection.clear();
    enterInsertAtSelections(this.editor, (pos) => pos);
    return handled({ enterInsert: true, insertCount });
  }

  private insertAfter(): NormalKeyResult {
    const insertCount = this.takeCount(1);
    this.registerSelection.clear();
    enterInsertAtSelections(this.editor, (pos) => ({
      row: pos.row,
      column: Math.min(pos.column + 1, this.editor.lineLength(pos.row)),
    }));
    return handled({ enterInsert: true, insertCount });
  }

  private insertFirstNonWhitespace(): NormalKeyResult {
    const insertCount = this.takeCount(1);
    this.registerSelection.clear();
    enterInsertAtSelections(this.editor, (pos) => firstNonWhitespace(this.editor.line(pos.row), pos.row));
    return handled({ enterInsert: true, insertCount });
  }

  private insertEndOfLine(): NormalKeyResult {
    const insertCount = this.takeCount(1);
    this.registerSelection.clear();
    enterInsertAtSelections(this.editor, (pos) => ({ row: pos.row, column: this.editor.lineLength(pos.row) }));
    return handled({ enterInsert: true, insertCount });
  }

  private openLineBelow(): NormalKeyResult {
    const insertCount = this.takeCount(1);
    this.registerSelection.clear();
    openLine(this.editor, { above: false }, keepUndoTransactionOpen());
    return handled({ enterInsert: true, insertCount, insertSeparator: "\n" });
  }

  private openLineAbove(): NormalKeyResult {
    const insertCount = this.takeCount(1);
    this.registerSelection.clear();
    openLine(this.editor, { above: true }, keepUndoTransactionOpen());
    return handled({ enterInsert: true, insertCount, insertSeparator: "\n" });
  }

  private startReplace(): NormalKeyResult {
    this.operatorStack.pushReplace(this.takeCount(1), this.chordKey("r", { includeCount: true }));
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

  private deleteRight(): NormalKeyResult {
    deleteCharacters(this.editor, this.registers, this.takeSelectedRegister(), this.takeCount(1));
    return handled();
  }

  private toggleCase(): NormalKeyResult {
    toggleCaseCharacters(this.editor, this.takeCount(1));
    this.registerSelection.clear();
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

  // Zed: `motion::Vim::motion`, which combines counts, forced-motion state,
  // active operators, and mode-specific motion handling.
  applyMotion(motion: Motion, count: number): boolean {
    const pendingSurround = this.operatorStack.activeSurround();
    if (pendingSurround?.type === "addSurrounds" && pendingSurround.target === undefined) {
      const ranges = this.editor.getSelections().map(selection =>
        motionRange(this.editor, selectionHead(selection), motion, pendingSurround.count * count));
      this.replaceActiveSurround({ ...pendingSurround, target: { type: "ranges", ranges, linewise: false } });
      return false;
    }

    const pending = this.operatorStack.popEditOperator();

    if (pending === undefined) {
      const hostSelections = hostViewLineSelectionsForMotion(this.editor, motion, count, { displayLine: false, extend: false });
      if (hostSelections === undefined) this.moveSelections(motion, count);
      else this.editor.setSelections(hostSelections);
      this.registerSelection.clear();
      return false;
    } else {
      return this.applyOperatorToMotion(editOperatorForPending(pending), motion, pending.count * count);
    }
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
    const pending = this.operatorStack.activeIndent();
    if (pending === undefined) return;

    if (key === "i" || key === "a") {
      this.operatorStack.pushObject(key === "a", this.chordKey(key));
      return;
    }

    this.operatorStack.popIndent();
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
    this.registerSelection.clear();
  }

  private handleReplaceKey(key: string): void {
    const pending = this.operatorStack.popReplace();
    if (pending === undefined || key.length === 0) return;
    if (key === "ctrl-k") {
      this.operatorStack.pushDigraph(pending.count, this.chordKey("ctrl-k"));
      return;
    }
    replaceCharacters(this.editor, keyForInput(key), pending.count);
  }

  private handleDigraphKey(key: string): void {
    const pending = this.operatorStack.activeDigraph();
    if (pending === undefined) return;
    if (pending.first === undefined) {
      this.operatorStack.pushChordKey(key);
      this.operatorStack.replaceActiveDigraph({ ...pending, first: keyForInput(key) });
      return;
    }
    this.operatorStack.popDigraph();
    replaceCharacters(this.editor, lookupDigraph(pending.first, keyForInput(key)), pending.count);
  }

  private handleSurroundKey(key: string): boolean {
    const pending = this.operatorStack.activeSurround();
    if (pending === undefined) return false;

    switch (pending.type) {
      case "deleteSurrounds":
        this.operatorStack.popSurround();
        deleteSurrounds(this.editor, key);
        return false;
      case "changeSurrounds":
        if (pending.fromKey === undefined) {
          this.operatorStack.pushChordKey(key);
          this.replaceActiveSurround({ type: "changeSurrounds", fromKey: key });
        } else {
          this.operatorStack.popSurround();
          changeSurrounds(this.editor, pending.fromKey, key);
        }
        return false;
      case "addSurrounds":
        return this.handleAddSurroundsKey(pending, key);
    }
  }

  private handleAddSurroundsKey(pending: Extract<PendingSurroundOperator, { type: "addSurrounds" }>, key: string): boolean {
    if (pending.target?.type === "ranges") {
      this.operatorStack.popSurround();
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
      this.operatorStack.pushChordKey(key);
      this.replaceActiveSurround({ ...pending, target: { type: "object", around: key === "a" } });
      return false;
    }
    if (key === "s") {
      this.operatorStack.pushChordKey(key);
      const ranges = this.editor.getSelections().map(selection =>
        trimmedLineRange(this.editor, selectionHead(selection).row, pending.count));
      this.replaceActiveSurround({ ...pending, target: { type: "ranges", ranges, linewise: false } });
      return false;
    }
    const motion = motionForKey(key);
    if (motion !== undefined) {
      this.operatorStack.pushChordKey(key);
      const ranges = this.editor.getSelections().map(selection =>
        motionRange(this.editor, selectionHead(selection), motion, pending.count));
      this.replaceActiveSurround({ ...pending, target: { type: "ranges", ranges, linewise: false } });
      return false;
    }
    this.clearPending();
    return false;
  }

  private handleConvertKey(key: string): void {
    const pending = this.operatorStack.activeConvert();
    if (pending === undefined) return;

    if (key === "i" || key === "a") {
      this.operatorStack.pushObject(key === "a", this.chordKey(key));
      return;
    }

    this.operatorStack.popConvert();
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
    const pendingTextObject = this.operatorStack.popObject();
    if (pendingTextObject === undefined) return false;

    const pendingOperator = this.operatorStack.popEditOperator();
    if (pendingOperator !== undefined) {
      const objectCount = this.takeCount(1);
      const count = pendingOperator.count * objectCount;
      const registerName = this.takeSelectedRegister();
      return applyTextObjectOperator(this.editor, this.registers, registerName, editOperatorForPending(pendingOperator), object, { around, count });
    }

    const pendingConvert = this.operatorStack.popConvert();
    if (pendingConvert !== undefined) {
      this.applyConvertTextObject(pendingConvert, object, around);
      return false;
    }

    const pendingIndent = this.operatorStack.popIndent();
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
    const pending = this.operatorStack.popEditOperator();
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
    const pending = this.operatorStack.popEditOperator();
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
    return this.countState.take(defaultValue);
  }

  private takeSelectedRegister(): RegisterName | undefined {
    return this.registerSelection.take();
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
