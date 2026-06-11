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
import { Motion, applyMotionWithGoal, hostViewLineSelectionsForMotion, lineRange } from "./motion.js";
import { TextObject, textObjectForKey, textObjectRange } from "./object.js";
import { deleteCharacters, deleteCharactersBefore } from "./normal/delete.js";
import { paste } from "./normal/paste.js";
import { OperatorTarget, RangeOperator, applyOperatorToTarget, lineOperatorTarget, operatorTarget, rowOperatorTarget, textObjectOperatorTarget } from "./operator_target.js";
import { RegisterName, Registers, isSystemClipboardRegister } from "./registers.js";
import { replaceCharacters } from "./replace.js";
import { toggleCaseCharacters } from "./normal/convert.js";
import { joinLines } from "./normal/join.js";
import { addSurrounds, changeSurrounds, deleteSurrounds } from "./surrounds.js";
import { KeyResult, Operator, TextRange, charwiseSelection, selectionHead } from "./state.js";
import {
  ForcedMotion,
  VimOperatorStack,
  PendingSurroundOperator,
  PendingSurroundTarget,
  rangeOperatorForPending,
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

  pendingOperatorName(): RangeOperator["type"] | undefined {
    const pending = this.operatorStack.activeRangeOperator();
    return pending === undefined ? undefined : rangeOperatorForPending(pending).type;
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
    // Zed: `vim::Vim::push_operator`. Doubling (`dd`) resolves through the
    // keymap's one line-operation rule before this action can fire.
    this.operatorStack.pushEditOperator(operator, this.takeCount(1), this.chordKey(key, { includeCount: true }));
    return handled();
  }

  // Zed: `vim::CurrentLine` — the one whole-line target for every doubled
  // range operator (`dd`/`cc`/`yy`/`guu`/`gugu`/`>>`/`yss`/...).
  handleLineOperation(): NormalKeyResult {
    const postCount = this.takeCount(1);

    // vim-surround `yss`: the line target is the trimmed current line.
    const pendingSurround = this.operatorStack.surroundAwaitingRange();
    if (pendingSurround !== undefined) {
      this.operatorStack.pushChordKey("s");
      const ranges = this.editor.getSelections().map(selection =>
        trimmedLineRange(this.editor, selectionHead(selection).row, pendingSurround.count * postCount));
      this.replaceActiveSurround({ ...pendingSurround, target: { ranges, linewise: false } });
      return handled();
    }

    const pending = this.operatorStack.popRangeOperator();
    if (pending === undefined) return handled();
    const registerName = this.takeSelectedRegister();
    const target = lineOperatorTarget(this.editor, pending.count * postCount);
    const outcome = applyOperatorToTarget(this.editor, this.registers, registerName, rangeOperatorForPending(pending), target);
    return handled({ enterInsert: outcome.enterInsert });
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
        if (this.operatorStack.activeRangeOperator() !== undefined) {
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
    // Vim `S`: synonym for `cc`.
    const target = lineOperatorTarget(this.editor, this.takeCount(1));
    const outcome = applyOperatorToTarget(this.editor, this.registers, this.takeSelectedRegister(), { type: "change" }, target);
    return handled({ enterInsert: outcome.enterInsert });
  }

  private changeToEndOfLine(): NormalKeyResult {
    return handled({ enterInsert: this.applyOperatorToMotion({ type: "change" }, { type: "endOfLine" }, this.takeCount(1)) });
  }

  private deleteToEndOfLine(): NormalKeyResult {
    this.applyOperatorToMotion({ type: "delete" }, { type: "endOfLine" }, this.takeCount(1));
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
    // Zed: `surrounds::Vim::add_surrounds` with `SurroundsType::Motion` — the
    // motion captures the surround range, then `ys` awaits the pair character.
    const pendingSurround = this.operatorStack.surroundAwaitingRange();
    if (pendingSurround !== undefined) {
      const target = operatorTarget(this.editor, motion, pendingSurround.count * count);
      this.replaceActiveSurround({ ...pendingSurround, target: surroundRangesForTarget(this.editor, target) });
      return false;
    }

    const pending = this.operatorStack.popRangeOperator();

    if (pending === undefined) {
      const hostSelections = hostViewLineSelectionsForMotion(this.editor, motion, count, { displayLine: false, extend: false });
      if (hostSelections === undefined) this.moveSelections(motion, count);
      else this.editor.setSelections(hostSelections);
      this.registerSelection.clear();
      return false;
    } else {
      return this.applyOperatorToMotion(rangeOperatorForPending(pending), motion, pending.count * count, pending.forcedMotion);
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
    // Range capture happens through the keymap (motions, objects, counts,
    // `yss` doubling); this waiting input only consumes the pair character.
    if (pending.target !== undefined) {
      this.operatorStack.popSurround();
      addSurrounds(this.editor, pending.target.ranges, key, { linewise: pending.target.linewise });
      return false;
    }
    this.clearPending();
    return false;
  }

  private handleTextObject(object: TextObject, around: boolean): boolean {
    const pendingTextObject = this.operatorStack.popObject();
    if (pendingTextObject === undefined) return false;

    // vim-surround `ysiw(`: the object captures the surround range.
    const pendingSurround = this.operatorStack.surroundAwaitingRange();
    if (pendingSurround !== undefined) {
      const count = pendingSurround.count * this.takeCount(1);
      const ranges = this.editor.getSelections().map(selection =>
        textObjectRange(this.editor, selectionHead(selection), object, { around, count }));
      this.replaceActiveSurround({ ...pendingSurround, target: { ranges, linewise: false } });
      return false;
    }

    const pending = this.operatorStack.popRangeOperator();
    if (pending === undefined) return false;

    const operator = rangeOperatorForPending(pending);
    const count = pending.count * this.takeCount(1);
    const registerName = this.takeSelectedRegister();
    const target = textObjectOperatorTarget(this.editor, object, {
      around,
      count,
      forChange: operator.type === "change",
    });
    return applyOperatorToTarget(this.editor, this.registers, registerName, operator, target).enterInsert;
  }

  // Zed: `normal::Vim::normal_motion`; the motion produces an `OperatorTarget`
  // and one dispatch applies the active operator to it.
  private applyOperatorToMotion(operator: RangeOperator, motion: Motion, count: number, forcedMotion?: ForcedMotion): boolean {
    const registerName = this.takeSelectedRegister();
    const target = operatorTarget(this.editor, motion, count, { forcedMotion, forChange: operator.type === "change" });
    return applyOperatorToTarget(this.editor, this.registers, registerName, operator, target).enterInsert;
  }

  private applyLinewiseOperatorToRow(targetRow: number): boolean {
    const pending = this.operatorStack.popRangeOperator();
    if (pending === undefined) return false;

    const registerName = this.takeSelectedRegister();
    const target = rowOperatorTarget(this.editor, targetRow);
    return applyOperatorToTarget(this.editor, this.registers, registerName, rangeOperatorForPending(pending), target).enterInsert;
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

// Lower an `OperatorTarget` to the surround capture shape: charwise targets
// wrap in place, linewise targets wrap whole lines with the pair on its own
// lines (vim-surround `yS`-style placement).
function surroundRangesForTarget(editor: VimEditorCapabilities, target: OperatorTarget): PendingSurroundTarget {
  switch (target.kind) {
    case "charwise":
      return { ranges: target.targets.map(({ range }) => range), linewise: false };
    case "linewise":
      return {
        ranges: target.rows.map(({ startRow, endRow }) => ({
          start: { row: startRow, column: 0 },
          end: { row: endRow, column: editor.lineLength(endRow) },
        })),
        linewise: true,
      };
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
