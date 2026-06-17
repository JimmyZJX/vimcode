// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `visual` module
// - translated concepts: visual-mode state and execution helpers for actions resolved
//   by keymap.ts, plus visual-line/block lowering and visual edits
// - intentional differences: this is still a model-buffer subset. Zed lowers visual
//   block mode through editor selections over a display map (`visual_block_motion`);
//   here we keep a compact semantic block state and lower to model edits/selections.

import { VimConfiguration } from "./config.js";
import type { VisualCommand, VisualModeKind } from "./keymap.js";
import { isEditorOwnedCharwiseSelection } from "./editor_state_sync.js";
import { VimEditorCapabilities, VimUndoTransaction, keepUndoTransactionOpen, normalCursorPosition, rangeText } from "./editor.js";
import { firstNonWhitespace, positionAfterInsertedText } from "./insert.js";
import { applyMotionWithGoal, hostViewLineSelectionsForMotion, lineRange, linewiseCursorAfterDelete, matchingPositionFromLine, Motion } from "./motion.js";
import { TextObject, textObjectForKey, textObjectRange } from "./object.js";
import { ConvertTarget, convertRanges } from "./normal/convert.js";
import { IndentDirection } from "./normal/indent.js";
import { RecordedSelection, VisualRepeatAction } from "./normal/repeat.js";
import { joinLines } from "./normal/join.js";
import { RegisterContent, RegisterName, RegisterPart, Registers, isSystemClipboardRegister } from "./registers.js";
import { VimOperatorStack } from "./operator.js";
import { OperatorTarget, applyOperatorToTarget } from "./operator_target.js";
import { canonicalVimSelection, canonicalizationChangesMeaning, characterCellEnd, lowerCharwiseGeometry, raiseCharwiseSelection } from "./selection_geometry.js";
import { addSurrounds } from "./surrounds.js";
import {
  KeyResult,
  Position,
  TextEdit,
  TextRange,
  VimSelection,
  VimSelectionGoal,
  charwiseSelection,
  comparePositions,
  rangeOfSelection,
  selectionHead,
} from "./state.js";

export type VisualResultMode = "normal" | "insert" | "visual" | "visualLine" | "visualBlock";
export type RestoredVisualMode = "visual" | "visualLine" | "visualBlock";

export type VisualKeyResult = {
  keyResult: KeyResult;
  exitVisual: boolean;
  enterInsert: boolean;
  nextMode?: VisualResultMode;
  repeatAction?: { selection: RecordedSelection; action: VisualRepeatAction };
  pendingRepeatChange?: { selection: RecordedSelection };
};

type CharwiseVisualState = {
  kind: "charwise";
  anchor: Position;
  head: Position; // Vim cursor position; inclusive.
  cursor?: Position;
  goal?: VimSelectionGoal;
};

type LinewiseVisualState = {
  kind: "linewise";
  anchorLine: number;
  // Vim keeps the raw column of the visual anchor even though linewise
  // selections cover whole lines; it shows through `gv`, `o`, and the
  // marked-state encoding of recorded Neovim fixtures.
  anchorColumn: number;
  headLine: number;
  headColumn: number;
  cursor?: Position;
  goal?: VimSelectionGoal;
};

type BlockwiseVisualState = {
  kind: "blockwise";
  anchor: Position;
  head: Position;
  goal?: VimSelectionGoal;
};

type VisualState = CharwiseVisualState | LinewiseVisualState | BlockwiseVisualState;
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
function handled(
  {
    exitVisual = false,
    enterInsert = false,
    nextMode,
    repeatAction,
    pendingRepeatChange,
  }: {
    exitVisual?: boolean;
    enterInsert?: boolean;
    nextMode?: VisualResultMode;
    repeatAction?: { selection: RecordedSelection; action: VisualRepeatAction };
    pendingRepeatChange?: { selection: RecordedSelection };
  } = {}
): VisualKeyResult {
  return { keyResult: "handled", exitVisual, enterInsert, nextMode, repeatAction, pendingRepeatChange };
}

export class VisualMode {
  private state: VisualState | undefined;
  private lastState: VisualState | undefined;

  private visualMultilineInsert: boolean;

  constructor(
    private readonly editor: VimEditorCapabilities,
    private readonly registers: Registers,
    private readonly registerSelection: RegisterSelection,
    private readonly countState: CountState,
    private readonly operatorStack: VimOperatorStack,
    configuration: Pick<VimConfiguration, "visualMultilineInsert">
  ) {
    this.visualMultilineInsert = configuration.visualMultilineInsert;
  }

  setConfiguration(configuration: Pick<VimConfiguration, "visualMultilineInsert">): void {
    this.visualMultilineInsert = configuration.visualMultilineInsert;
  }


  clearPending(): void {
    this.clearPendingStack();
    this.registerSelection.clear();
    this.countState.clear();
  }

  private clearPendingStack(): void {
    this.operatorStack.clear();
  }

  enter(kind: VisualState["kind"] = "charwise"): void {
    const selections = this.editor.getSelections();
    const selection = selections[0];
    const head = selectionHead(selection);
    this.clearPendingStack();
    this.registerSelection.clear();
    this.countState.clear();
    this.editor.setCursorStyle("line");
    switch (kind) {
      case "charwise":
        this.setCharwiseStates(selections.map(selection => {
          const head = selectionHead(selection);
          return { kind, anchor: head, head: initialCharwiseHead(this.editor, head) };
        }));
        break;
      case "linewise":
        this.state = { kind, anchorLine: head.row, anchorColumn: head.column, headLine: head.row, headColumn: head.column };
        this.syncEditorSelection();
        break;
      case "blockwise":
        this.state = { kind, anchor: head, head };
        this.syncEditorSelection();
        break;
    }
  }

  adoptSelection(selection: VimSelection, { canonicalize = false }: { canonicalize?: boolean } = {}): boolean {
    if (!this.adoptCharwiseSelection(selection, { allowEmpty: false })) return false;
    // Canonical write-back invariant: after adopting external selection state,
    // re-lower it through the shared cell geometry so native selections and the
    // adopted Vim state agree. Generic external sync only writes back when
    // canonicalization changes Vim meaning: rewriting equivalent shapes would
    // destroy in-progress native gesture state (e.g. the word-range anchor of a
    // double-click drag), and for equivalent shapes the rendered cursor already
    // matches the Vim cursor cell. Vim-triggered native commands can opt in to
    // canonicalizing equivalent shapes so the adapter caches explicit Vim
    // cursor-cell metadata for follow-up keys like Escape.
    const current = this.editor.getSelections();
    if (canonicalize || current.some(selection => canonicalizationChangesMeaning(this.editor, selection))) {
      this.editor.setSelections(current.map(selection => canonicalVimSelection(this.editor, selection)));
    }
    return true;
  }

  clearState(): void {
    this.state = undefined;
    this.clearPendingStack();
    this.registerSelection.clear();
    this.countState.clear();
  }

  exit(): void {
    const state = this.state;
    if (state !== undefined) this.rememberState(state);
    this.state = undefined;
    this.clearPendingStack();
    this.registerSelection.clear();
    this.countState.clear();
    this.editor.setCursorStyle("block");
    const selections = this.editor.getSelections();
    if (state === undefined || (state.kind !== "blockwise" && selections.length > 1)) {
      this.editor.setSelections(selections.map(selection => visualExitSelectionForEditorSelection(this.editor, selection)));
    } else {
      this.editor.setSelections([charwiseSelection(visualExitPosition(this.editor, state))]);
    }
  }

  handleUnhandledKey(): VisualKeyResult {
    this.exit();
    return handled({ exitVisual: true, nextMode: "normal" });
  }

  toggleMode(mode: VisualModeKind): VisualKeyResult {
    const state = this.state;
    if (state === undefined) return handled({ exitVisual: true });
    switch (mode) {
      case "visual":
        return this.toggleCharwise(state);
      case "visualLine":
        return this.toggleLinewise(state);
      case "visualBlock":
        return this.toggleBlockwise(state);
    }
  }

  handleCommand(command: VisualCommand): VisualKeyResult {
    const state = this.state;
    if (state === undefined) return handled({ exitVisual: true });
    switch (command.type) {
      case "insertAtSelection":
        return command.side === "start"
          ? this.insertBeforeOrAtBlockStart(state) ?? handled()
          : this.insertAfterOrAtBlockEnd(state) ?? handled();
      case "startSurround":
        return this.startSurround(state);
      case "indent":
        return this.indentKey(state, command.key);
      case "convert":
        this.convert(state, convertTargetForKey(command.key));
        return handled({ exitVisual: true, nextMode: "normal" });
      case "startTextObject":
        return this.startTextObject(command.around);
      case "otherEnd":
        return this.otherEnd(state, { rowAware: command.rowAware });
      case "yankLinewise":
        return this.yankLinewiseKey(state);
      case "yank":
        return this.yankKey(state);
      case "deleteToLineEnd":
        return this.deleteToLineEndKey(state);
      case "delete":
        return this.deleteKey(state);
      case "change":
        return this.changeKey(state);
      case "changeLines":
        // Vim `v_R`: the change always operates on whole lines.
        return this.changeKey(state.kind === "linewise" ? state : stateToLinewise(state));
      case "paste":
        return this.pasteKey(state);
      case "percentOrMatching":
        return this.percentKey(state) ?? handled();
    }
  }

  private toggleCharwise(state: VisualState): VisualKeyResult {
    if (state.kind === "charwise") {
      this.exit();
      return handled({ exitVisual: true, nextMode: "normal" });
    }
    this.state = stateToCharwise(this.editor, state);
    this.syncEditorSelection();
    return handled({ nextMode: "visual" });
  }

  private toggleLinewise(state: VisualState): VisualKeyResult {
    if (state.kind === "linewise") {
      this.exit();
      return handled({ exitVisual: true, nextMode: "normal" });
    }
    this.state = stateToLinewise(state);
    this.syncEditorSelection();
    return handled({ nextMode: "visualLine" });
  }

  private toggleBlockwise(state: VisualState): VisualKeyResult {
    if (state.kind === "blockwise") {
      this.exit();
      return handled({ exitVisual: true, nextMode: "normal" });
    }
    this.state = stateToBlockwise(state);
    this.syncEditorSelection();
    return handled({ nextMode: "visualBlock" });
  }

  private insertBeforeOrAtBlockStart(state: VisualState): VisualKeyResult | undefined {
    return this.enterVisualInsert(state, "start");
  }

  private insertAfterOrAtBlockEnd(state: VisualState): VisualKeyResult | undefined {
    return this.enterVisualInsert(state, "end");
  }

  private enterVisualInsert(state: VisualState, side: "start" | "end"): VisualKeyResult | undefined {
    if (state.kind === "blockwise") {
      this.rememberState(state);
      beginVisualUndoTransaction(this.editor, state);
      enterBlockInsert(this.editor, this.registers, undefined, state, { deleteSelection: false, side });
      this.state = undefined;
      this.editor.setCursorStyle("line");
      return handled({
        exitVisual: true,
        enterInsert: true,
        // Vim: `.` repeats a block insert over the same number of rows below
        // the cursor.
        pendingRepeatChange: {
          selection: { type: "visualBlock", rows: Math.abs(state.head.row - state.anchor.row), side },
        },
      });
    }

    if (this.visualMultilineInsert && (state.kind === "charwise" || state.kind === "linewise")) {
      this.rememberState(state);
      this.editor.beginUndoTransaction(visualCurrentUndoSelections(this.editor, state));
      this.editor.setSelections(visualMultilineInsertSelections(this.editor, state, { side }));
      this.state = undefined;
      this.editor.setCursorStyle("line");
      return handled({ exitVisual: true, enterInsert: true });
    }

    return undefined;
  }

  private startSurround(state: VisualState): VisualKeyResult {
    this.operatorStack.pushVisualAddSurrounds({
      ranges: visualSurroundRanges(this.editor, state),
      linewise: state.kind === "linewise",
      undoSelectionsBefore: visualCurrentUndoSelections(this.editor, state),
    });
    return handled();
  }

  private indentKey(state: VisualState, key: ">" | "<" | "="): VisualKeyResult {
    const direction = indentDirectionForKey(key);
    const repeatAction = visualIndentRepeatActionForState(this.editor, state, direction);
    this.indent(state, direction);
    return handled({ exitVisual: true, nextMode: "normal", repeatAction });
  }

  private startTextObject(around: boolean): VisualKeyResult {
    this.operatorStack.push({ type: "object", around });
    return handled();
  }

  private otherEnd(state: VisualState, { rowAware }: { rowAware: boolean }): VisualKeyResult {
    if (state.kind === "charwise") {
      this.setCharwiseStates(currentCharwiseVisualStates(this.editor, state).map(state => otherEndState(state, { rowAware }) as CharwiseVisualState));
    } else {
      this.state = otherEndState(state, { rowAware });
      this.syncEditorSelection();
    }
    return handled();
  }

  private yankLinewiseKey(state: VisualState): VisualKeyResult {
    const cursor = this.yankLinewise(state, this.takeSelectedRegister());
    if (cursor !== undefined) this.rememberState(state);
    this.state = undefined;
    this.editor.setCursorStyle("block");
    this.editor.setSelections([charwiseSelection(cursor ?? visualStartPosition(state))]);
    return handled({ exitVisual: true, nextMode: "normal" });
  }

  private yankKey(state: VisualState): VisualKeyResult {
    this.yank(state, this.takeSelectedRegister());
    if (state.kind === "blockwise") {
      this.finishNormalAtVisualStarts(state);
    } else {
      // [applyYank] already placed the cursor (Vim `v_y`: the start of the
      // yanked text); only the visual state needs cleaning up.
      if (this.state !== undefined) this.rememberState(this.state);
      this.clearState();
      this.editor.setCursorStyle("block");
    }
    return handled({ exitVisual: true, nextMode: "normal" });
  }

  private deleteToLineEndKey(state: VisualState): VisualKeyResult {
    this.rememberState(state);
    this.deleteToLineEnd(state, this.takeSelectedRegister());
    this.state = undefined;
    this.editor.setCursorStyle("block");
    return handled({ exitVisual: true, nextMode: "normal" });
  }

  private deleteKey(state: VisualState): VisualKeyResult {
    const selection = visualRepeatSelectionForState(this.editor, state);
    this.rememberState(state);
    this.delete(state, this.takeSelectedRegister());
    this.state = undefined;
    this.editor.setCursorStyle("block");
    return handled({ exitVisual: true, nextMode: "normal", repeatAction: { selection, action: { type: "delete" } } });
  }

  private changeKey(state: VisualState): VisualKeyResult {
    const selection = visualRepeatSelectionForState(this.editor, state);
    this.rememberState(state);
    this.change(state, this.takeSelectedRegister());
    this.state = undefined;
    this.editor.setCursorStyle("line");
    return handled({ exitVisual: true, enterInsert: true, nextMode: "insert", pendingRepeatChange: { selection } });
  }

  private pasteKey(state: VisualState): VisualKeyResult {
    const pastedState = this.paste(state, this.takeSelectedRegister());
    this.rememberState(pastedState ?? state);
    this.state = undefined;
    this.editor.setCursorStyle("block");
    return handled({ exitVisual: true, nextMode: "normal" });
  }

  private percentKey(state: VisualState): VisualKeyResult | undefined {
    if (this.countState.get().length > 0) {
      this.applyVisualMotion(state, { type: "goToPercentage", percent: this.takeCount(1) }, 1, { displayLine: false });
      return handled();
    }

    if (state.kind === "charwise") {
      const head = matchingPositionFromLine(this.editor, state.head);
      this.state = {
        ...state,
        head,
        cursor: visualMatchingCursor(this.editor, state, head),
        goal: undefined,
      };
      this.syncEditorSelection();
      return handled();
    }

    return undefined;
  }

  handlePendingSurroundKey(key: string): VisualKeyResult {
    const pendingSurround = this.operatorStack.popVisualOperator("visualAddSurrounds");
    if (pendingSurround === undefined) return handled();
    const undoTransaction = this.editor.beginUndoTransaction(pendingSurround.undoSelectionsBefore);
    try {
      addSurrounds(this.editor, pendingSurround.ranges, key, { linewise: pendingSurround.linewise });
    } finally {
      undoTransaction.finish();
    }
    this.state = undefined;
    this.editor.setCursorStyle("block");
    return handled({ exitVisual: true, nextMode: "normal" });
  }

  handlePendingTextObjectKey(key: string): VisualKeyResult {
    const pendingTextObject = this.operatorStack.popVisualOperator("object");
    const state = this.state;
    const object = textObjectForKey(key);
    if (state === undefined || object === undefined || pendingTextObject === undefined) {
      this.exit();
      return handled({ exitVisual: true, nextMode: "normal" });
    }

    const around = pendingTextObject.around;
    const count = this.takeCount(1);
    const states = state.kind === "charwise" ? currentCharwiseVisualStates(this.editor, state) : [state];
    if (states.some(state => object.type !== "paragraph" && this.editor.lineLength(visualObjectPosition(this.editor, state).row) === 0)) {
      this.syncEditorSelection();
      return handled();
    }

    if (object.type === "paragraph") {
      const range = textObjectRange(this.editor, visualObjectPosition(this.editor, state), object, { around, count });
      this.state = paragraphLinewiseStateForRange(state, range);
      this.syncEditorSelection();
      return handled({ nextMode: "visualLine" });
    }

    // Zed: `visual::visual_object` — objects extend the live selection. Word,
    // sentence, and quote objects keep visual block mode and move only the
    // head; bracket objects always become a charwise selection of the pair.
    if (state.kind === "blockwise" && !objectAlwaysExpandsBothWays(object)) {
      const range = textObjectRange(this.editor, visualObjectPosition(this.editor, state), object, { around, count });
      if (!rangeIsEmpty(range)) {
        const reversed = comparePositions(state.head, state.anchor) < 0;
        const singleCell = comparePositions(state.head, state.anchor) === 0;
        if (singleCell) {
          this.state = { ...state, anchor: range.start, head: inclusiveHeadForRangeEnd(this.editor, range), goal: undefined };
        } else {
          this.state = {
            ...state,
            head: reversed ? range.start : inclusiveHeadForRangeEnd(this.editor, range),
            goal: undefined,
          };
        }
        this.syncEditorSelection();
      }
      return handled();
    }

    const charwiseStates: CharwiseVisualState[] = state.kind === "charwise"
      ? (states as CharwiseVisualState[])
      : [{ kind: "charwise", anchor: visualObjectPosition(this.editor, state), head: visualObjectPosition(this.editor, state) }];
    this.setCharwiseStates(charwiseStates.map(charwiseState => this.objectExpandedState(charwiseState, object, around, count)));
    return handled({ nextMode: "visual" });
  }

  // Zed: the per-selection logic of `visual::visual_object`.
  private objectExpandedState(
    state: CharwiseVisualState,
    object: TextObject,
    around: boolean,
    count: number
  ): CharwiseVisualState {
    const position = visualObjectPosition(this.editor, state);
    const range = textObjectRange(this.editor, position, object, { around, count });
    if (rangeIsEmpty(range)) return state;

    const reversed = comparePositions(state.head, state.anchor) < 0;
    const singleCell = comparePositions(state.head, state.anchor) === 0;
    if (objectAlwaysExpandsBothWays(object) || singleCell) {
      const selectionStart = reversed ? state.head : state.anchor;
      const selectionEnd = reversed ? state.anchor : state.head;
      // Vim: pressing the same bracket object again expands the selection to
      // the enclosing pair. Zed re-queries from the exclusive head — one past
      // the inclusive end — which sits outside the already-selected pair.
      if (objectAlwaysExpandsBothWays(object)
        && comparePositions(range.start, selectionStart) === 0
        && comparePositions(inclusiveHeadForRangeEnd(this.editor, range), selectionEnd) === 0) {
        const requery = reversed
          ? state.head
          : { row: selectionEnd.row, column: Math.min(selectionEnd.column + 1, this.editor.lineLength(selectionEnd.row)) };
        const expanded = textObjectRange(this.editor, requery, object, { around, count });
        if (!rangeIsEmpty(expanded)) return charwiseStateForRange(this.editor, expanded);
        return state;
      }
      return charwiseStateForRange(this.editor, range);
    }
    if (reversed) return { kind: "charwise", anchor: state.anchor, head: range.start };
    return { kind: "charwise", anchor: state.anchor, head: inclusiveHeadForRangeEnd(this.editor, range) };
  }

  // Zed: `visual::visual_operate`-style commands lower the visual state to an
  // `OperatorTarget` and apply through the same dispatch as normal mode
  // (blockwise stays on bespoke helpers until the blockwise target variant
  // exists).
  private yank(state: VisualState, registerName: RegisterName | undefined): void {
    switch (state.kind) {
      case "charwise":
        applyOperatorToTarget(this.editor, this.registers, registerName, { type: "yank" }, visualCharwiseTarget(this.editor, state));
        break;
      case "linewise":
        // Vim `v_y`: the cursor moves to the start of the yanked lines.
        applyOperatorToTarget(this.editor, this.registers, registerName, { type: "yank" }, visualLinewiseTarget(state, { column: 0 }));
        break;
      case "blockwise":
        this.registers.writeYank(registerName, blockwiseText(this.editor, state), "blockwise");
        break;
    }
  }

  private yankLinewise(state: VisualState, registerName: RegisterName | undefined): Position | undefined {
    const bounds = visualLineBounds(this.editor, state);
    if (bounds === undefined) return undefined;

    const lines: string[] = [];
    for (let row = bounds.startRow; row <= bounds.endRow; row++) {
      lines.push(this.editor.line(row));
    }
    this.registers.writeYank(registerName, `${lines.join("\n")}\n`, "linewise");
    return { row: bounds.startRow, column: 0 };
  }

  private deleteToLineEnd(state: VisualState, registerName: RegisterName | undefined): void {
    if (state.kind === "blockwise") {
      const { startRow, endRow, startColumn } = blockBounds(state);
      const edits: TextEdit[] = [];
      const copied: string[] = [];
      for (let row = startRow; row <= endRow; row++) {
        const start = { row, column: Math.min(startColumn, this.editor.lineLength(row)) };
        const end = { row, column: this.editor.lineLength(row) };
        edits.push({ range: { start, end }, text: "" });
        copied.push(rangeText(this.editor, { start, end }));
      }
      this.registers.writeDelete(
        registerName,
        copied.join("\n"),
        "blockwise",
        copied.map(text => ({ text, kind: "blockwise" }))
      );
      const cursorColumn = Math.max(0, Math.min(startColumn, this.editor.lineLength(startRow)) - 1);
      this.editor.applyEdits(edits, [charwiseSelection({ row: startRow, column: cursorColumn })]);
      return;
    }

    const { startRow, endRow } = visualLineBounds(this.editor, state);
    const anchor = visualAnchorPosition(state);
    const count = endRow - startRow + 1;
    const range = lineRange(this.editor, startRow, count);
    const copied: string[] = [];
    for (let row = startRow; row <= endRow; row++) copied.push(this.editor.line(row));
    this.registers.writeDelete(registerName, `${copied.join("\n")}\n`, "linewise");
    this.editor.applyEdits(
      [{ range, text: "" }],
      [charwiseSelection(linewiseCursorAfterDelete(this.editor, startRow, anchor.column, count))]
    );
  }

  private delete(state: VisualState, registerName: RegisterName | undefined): void {
    switch (state.kind) {
      case "charwise": {
        const undoTransaction = this.editor.beginUndoTransaction(currentCharwiseVisualUndoSelections(this.editor, state));
        try {
          applyOperatorToTarget(this.editor, this.registers, registerName, { type: "delete" }, visualCharwiseTarget(this.editor, state));
        } finally {
          undoTransaction.finish();
        }
        break;
      }
      case "linewise": {
        const { startLine, endLine } = lineBounds(state);
        const undoTransaction = beginVisualUndoTransaction(this.editor, state);
        try {
          applyOperatorToTarget(this.editor, this.registers, registerName, { type: "delete" }, visualLinewiseTarget(state, {
            column: state.headColumn,
            // Vim `v_d` linewise: the cursor column clamps against the line
            // that follows the deleted range, not the first deleted line.
            cursor: linewiseCursorAfterDelete(this.editor, startLine, state.headColumn, endLine - startLine + 1),
          }));
        } finally {
          undoTransaction.finish();
        }
        break;
      }
      case "blockwise":
        deleteBlockwise(this.editor, this.registers, registerName, state, { collapse: true });
        break;
    }
  }

  private change(state: VisualState, registerName: RegisterName | undefined): void {
    switch (state.kind) {
      case "charwise":
        this.editor.beginUndoTransaction(currentCharwiseVisualUndoSelections(this.editor, state));
        applyOperatorToTarget(this.editor, this.registers, registerName, { type: "change" }, visualCharwiseTarget(this.editor, state));
        break;
      case "linewise":
        beginVisualUndoTransaction(this.editor, state);
        applyOperatorToTarget(this.editor, this.registers, registerName, { type: "change" }, visualLinewiseTarget(state, { column: state.headColumn }));
        break;
      case "blockwise":
        enterBlockInsert(this.editor, this.registers, registerName, state, { deleteSelection: true, side: "start" });
        break;
    }
  }

  joinSelections({ insertWhitespace }: { insertWhitespace: boolean }): void {
    if (this.state === undefined) return;
    this.join(this.state, { insertWhitespace });
  }

  private join(state: VisualState, { insertWhitespace }: { insertWhitespace: boolean }): void {
    this.rememberState(state);
    const { startRow, endRow } = visualLineBounds(this.editor, state);
    joinLines(this.editor, startRow, Math.max(1, endRow - startRow), { insertWhitespace });
    this.state = undefined;
    this.editor.setCursorStyle("block");
  }

  convertSelections(target: ConvertTarget): void {
    if (this.state === undefined) return;
    this.convert(this.state, target);
  }

  private convert(state: VisualState, target: ConvertTarget): void {
    this.rememberState(state);
    // Vim: a visual operator moves the cursor to the selection start before
    // changing text, so that is where `u` later restores it.
    beginVisualUndoTransaction(this.editor, state);
    switch (state.kind) {
      case "charwise":
        applyOperatorToTarget(this.editor, this.registers, undefined, { type: "convert", target }, visualCharwiseTarget(this.editor, state));
        break;
      case "linewise":
        applyOperatorToTarget(this.editor, this.registers, undefined, { type: "convert", target }, visualLinewiseTarget(state, { column: 0 }));
        break;
      case "blockwise":
        convertRanges(this.editor, visualConvertRanges(this.editor, state), target);
        break;
    }
    this.state = undefined;
    this.editor.setCursorStyle("block");
  }

  private indent(state: VisualState, direction: IndentDirection): void {
    this.rememberState(state);
    const cursor = visualIndentCursor(this.editor, state, direction);
    const { startRow, endRow } = visualLineBounds(this.editor, state);
    applyOperatorToTarget(this.editor, this.registers, undefined, { type: "indent", direction }, {
      kind: "linewise",
      rows: [{ startRow, endRow, column: cursor.column }],
    });
    // Vim `v_>`: the cursor lands on the visual start, shifted with the text.
    this.editor.setSelections([charwiseSelection(cursor)]);
    this.state = undefined;
    this.editor.setCursorStyle("block");
  }

  private paste(state: VisualState, registerName: RegisterName | undefined): VisualState | undefined {
    const content = this.registers.readContent(registerName);
    if (content.text.length === 0) return undefined;

    switch (state.kind) {
      case "charwise":
        return pasteOverCharwise(this.editor, this.registers, state, content);
      case "linewise":
        pasteOverLinewise(this.editor, this.registers, state, content);
        return undefined;
      case "blockwise":
        pasteOverBlockwise(this.editor, this.registers, state, content);
        return undefined;
    }
  }

  private applyVisualMotion(state: VisualState, motion: Motion, count: number, { displayLine }: { displayLine: boolean }): void {
    if (state.kind === "charwise") {
      const hostSelections = hostViewLineSelectionsForMotion(this.editor, motion, count, { displayLine, extend: true });
      if (hostSelections !== undefined) {
        this.editor.setSelections(hostSelections);
        this.adoptSelectionFromHost();
        return;
      }
      this.setCharwiseStates(currentCharwiseVisualStates(this.editor, state).map(state =>
        stateAfterMotion(this.editor, state, motion, count) as CharwiseVisualState));
      return;
    }
    if (state.kind === "linewise" && (motion.type === "up" || motion.type === "down")) {
      const hostSelections = hostViewLineSelectionsForMotion(this.editor, motion, count, { displayLine, extend: false });
      const hostSelection = hostSelections?.[0];
      if (hostSelection?.type === "charwise") {
        const head = selectionHead(hostSelection);
        this.state = { ...state, headLine: head.row, headColumn: head.column, goal: hostSelection.goal };
        this.syncEditorSelection();
        return;
      }
    }

    this.state = stateAfterMotion(this.editor, state, motion, count);
    this.syncEditorSelection();
  }

  private syncEditorSelection(): void {
    if (this.state === undefined) return;
    this.editor.setSelections([visualStateToEditorSelection(this.editor, this.state)]);
  }

  private setCharwiseStates(states: readonly CharwiseVisualState[]): void {
    const first = states[0];
    if (first === undefined) return;
    this.state = first;
    this.editor.setSelections(states.map(state => charwiseStateToEditorSelection(this.editor, state)));
  }

  adoptSelectionFromHost(): void {
    const selection = this.editor.getSelections()[0];
    if (selection === undefined) return;
    switch (selection.type) {
      case "charwise":
        this.adoptCharwiseSelection(selection, { allowEmpty: true });
        return;
      case "linewise":
        this.state = {
          kind: "linewise",
          anchorLine: selection.anchorLine,
          anchorColumn: selection.anchorColumn ?? 0,
          headLine: selection.headLine,
          headColumn: selection.cursor?.column ?? 0,
          cursor: selection.cursor,
          goal: selection.goal,
        };
        return;
      case "blockwise":
        this.state = {
          kind: "blockwise",
          anchor: selection.anchor,
          head: selection.cursor ?? selection.head,
          goal: selection.goal,
        };
        return;
    }
  }

  private adoptCharwiseSelection(
    selection: VimSelection,
    { allowEmpty }: { allowEmpty: boolean }
  ): boolean {
    if (selection.type !== "charwise") return false;
    if (!allowEmpty && comparePositions(selection.anchor, selection.head) === 0) return false;
    this.clearPendingStack();
    this.registerSelection.clear();
    this.countState.clear();
    this.state = externalSelectionToCharwiseState(this.editor, selection);
    this.editor.setCursorStyle("line");
    return true;
  }

  restoreLastSelection(): RestoredVisualMode | undefined {
    const lastState = this.lastState;
    if (lastState === undefined) return undefined;
    const currentState = this.state;
    if (currentState !== undefined) this.rememberState(currentState);
    this.state = lastState;
    this.lastState = currentState;
    this.clearPendingInteraction();
    this.editor.setCursorStyle("line");
    this.syncEditorSelection();
    return modeForState(lastState);
  }

  private finishNormalAtVisualStarts(state: VisualState): void {
    if (this.state !== undefined) this.rememberState(this.state);
    const selections = state.kind === "charwise"
      ? currentCharwiseVisualRanges(this.editor, state).map(range => charwiseSelection(range.start))
      : [charwiseSelection(visualStartPosition(state))];
    this.clearState();
    this.editor.setCursorStyle("block");
    this.editor.setSelections(selections);
  }

  private takeSelectedRegister(): RegisterName | undefined {
    return this.registerSelection.take();
  }

  private clearPendingInteraction(): void {
    this.clearPendingStack();
    this.registerSelection.clear();
    this.countState.clear();
  }

  private rememberState(state: VisualState): void {
    this.lastState = cloneVisualState(state);
  }

  applyMotion(motion: Motion, count: number): void {
    if (this.state === undefined) return;
    this.applyVisualMotion(this.state, motion, count, { displayLine: (motion.type === "up" || motion.type === "down") && motion.displayLine === true });
  }


  systemClipboardRegisterToReadForKey(key: string): { registerName: RegisterName | undefined } | undefined {
    if (key !== "p" && key !== "P") return undefined;
    const registerName = this.registerSelection.get();
    if (registerName === undefined || isSystemClipboardRegister(registerName)) {
      return { registerName };
    }
    return undefined;
  }

  private takeCount(defaultValue: number): number {
    return this.countState.take(defaultValue) ?? defaultValue;
  }
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
      throw new Error(`not a visual indent key: ${key}`);
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
      throw new Error(`not a visual convert key: ${key}`);
  }
}

function externalSelectionToCharwiseState(editor: VimEditorCapabilities, selection: Extract<VimSelection, { type: "charwise" }>): CharwiseVisualState {
  return { kind: "charwise", ...raiseCharwiseSelection(editor, selection) };
}

function visualExitSelectionForEditorSelection(editor: VimEditorCapabilities, selection: VimSelection): VimSelection {
  if (selection.type === "charwise") {
    return charwiseSelection(visualExitPosition(editor, externalSelectionToCharwiseState(editor, selection)));
  }
  return charwiseSelection(selectionHead(selection));
}

function initialCharwiseHead(_editor: VimEditorCapabilities, head: Position): Position {
  return head;
}

function visualObjectPosition(editor: VimEditorCapabilities, state: VisualState): Position {
  switch (state.kind) {
    case "charwise":
      if (isForwardCharwiseVisualState(state)
        && editor.lineLength(state.anchor.row) === 0
        && state.head.row === state.anchor.row + 1
        && state.head.column === 0) {
        return state.anchor;
      }
      return state.head;
    case "linewise":
      return linewiseCursor(editor, state);
    case "blockwise":
      return state.head;
  }
}

function visualMatchingCursor(editor: VimEditorCapabilities, state: CharwiseVisualState, match: Position): Position | undefined {
  if (match.row !== state.anchor.row && match.column === 0 && editor.lineLength(match.row) > 0) {
    return { row: match.row, column: 1 };
  }
  return undefined;
}

function stateAfterMotion(
  editor: VimEditorCapabilities,
  state: VisualState,
  motion: Motion,
  count: number
): VisualState {
  let current = state;
  for (let index = 0; index < count; index++) {
    switch (current.kind) {
      case "charwise":
        current = charwiseStateAfterMotion(editor, current, motion);
        break;
      case "linewise":
        current = linewiseStateAfterMotion(editor, current, motion);
        break;
      case "blockwise":
        current = blockwiseStateAfterMotion(editor, current, motion);
        break;
    }
  }
  return current;
}

function charwiseStateAfterMotion(
  editor: VimEditorCapabilities,
  state: CharwiseVisualState,
  motion: Motion
): CharwiseVisualState {
  if (motion.type === "right") {
    const head = charwiseRight(editor, state.head);
    return { ...state, head, cursor: undefined, goal: undefined };
  }
  if (motion.type === "endOfLine") {
    const head = { row: state.head.row, column: editor.lineLength(state.head.row) };
    return { ...state, head, cursor: undefined, goal: { type: "endOfLine" } };
  }
  const result = applyMotionWithGoal(editor, state.head, motion, 1, state.goal);
  return {
    ...state,
    head: result.position,
    cursor: undefined,
    goal: result.goal ?? (motion.type === "nextWordStart" ? { type: "modelColumn", column: result.position.column } : undefined),
  };
}

function charwiseRight(editor: VimEditorCapabilities, head: Position): Position {
  const lineLength = editor.lineLength(head.row);
  if (head.column < lineLength) return { row: head.row, column: head.column + 1 };
  return head;
}

function linewiseStateAfterMotion(
  editor: VimEditorCapabilities,
  state: LinewiseVisualState,
  motion: Motion
): LinewiseVisualState {
  switch (motion.type) {
    case "up":
      return { ...state, headLine: Math.max(0, state.headLine - 1), goal: undefined };
    case "down":
      return { ...state, headLine: Math.min(editor.lineCount() - 1, state.headLine + 1), goal: undefined };
    case "endOfDocument":
      return { ...state, headLine: editor.lineCount() - 1, goal: undefined };
    case "endOfLine":
      return { ...state, headColumn: editor.lineLength(state.headLine) };
    default: {
      const result = applyMotionWithGoal(editor, linewiseCursor(editor, state), motion, 1, state.goal);
      return { ...state, headLine: result.position.row, headColumn: result.position.column, goal: result.goal };
    }
  }
}

function blockwiseStateAfterMotion(
  editor: VimEditorCapabilities,
  state: BlockwiseVisualState,
  motion: Motion
): BlockwiseVisualState {
  const { position, goal } = applyMotionWithGoal(
    editor,
    state.head,
    motion,
    1,
    state.goal,
    { allowEndOfLine: true }
  );
  return { ...state, head: position, goal: motion.type === "endOfLine" ? { type: "endOfLine" } : goal };
}

function stateToCharwise(editor: VimEditorCapabilities, state: VisualState): CharwiseVisualState {
  switch (state.kind) {
    case "charwise":
      return state;
    case "linewise": {
      const cursor = linewiseCursor(editor, state);
      return { kind: "charwise", anchor: { row: state.anchorLine, column: state.headColumn }, head: cursor };
    }
    case "blockwise":
      return { kind: "charwise", anchor: state.anchor, head: state.head };
  }
}

function stateToLinewise(state: VisualState): LinewiseVisualState {
  switch (state.kind) {
    case "linewise":
      return state;
    case "charwise":
    case "blockwise":
      return {
        kind: "linewise",
        anchorLine: state.anchor.row,
        anchorColumn: state.anchor.column,
        headLine: state.head.row,
        headColumn: state.head.column,
      };
  }
}

function stateToBlockwise(state: VisualState): BlockwiseVisualState {
  switch (state.kind) {
    case "blockwise":
      return state;
    case "charwise":
      return { kind: "blockwise", anchor: state.anchor, head: state.head };
    case "linewise":
      return {
        kind: "blockwise",
        anchor: { row: state.anchorLine, column: state.headColumn },
        head: { row: state.headLine, column: state.headColumn },
      };
  }
}

function otherEndState(state: VisualState, { rowAware }: { rowAware: boolean }): VisualState {
  switch (state.kind) {
    case "charwise":
      return { ...state, anchor: state.head, head: state.anchor, goal: { type: "modelColumn", column: state.anchor.column } };
    case "linewise":
      return {
        ...state,
        anchorLine: state.headLine,
        anchorColumn: state.headColumn,
        headLine: state.anchorLine,
        headColumn: state.anchorColumn,
        cursor: undefined,
      };
    case "blockwise":
      return rowAware ? flipBlockOtherEndRowAware(state) : flipBlockOtherEnd(state);
  }
}

function flipBlockOtherEndRowAware(state: BlockwiseVisualState): BlockwiseVisualState {
  return { ...state, anchor: state.head, head: state.anchor, goal: { type: "modelColumn", column: state.anchor.column } };
}

function flipBlockOtherEnd(state: BlockwiseVisualState): BlockwiseVisualState {
  return {
    ...state,
    anchor: { row: state.anchor.row, column: state.head.column },
    head: { row: state.head.row, column: state.anchor.column },
    goal: { type: "modelColumn", column: state.anchor.column },
  };
}

export function visualKindForMode(mode: VisualModeKind): VisualState["kind"] {
  switch (mode) {
    case "visual":
      return "charwise";
    case "visualLine":
      return "linewise";
    case "visualBlock":
      return "blockwise";
  }
}

function modeForState(state: VisualState): RestoredVisualMode {
  switch (state.kind) {
    case "charwise":
      return "visual";
    case "linewise":
      return "visualLine";
    case "blockwise":
      return "visualBlock";
  }
}

function cloneVisualState(state: VisualState): VisualState {
  switch (state.kind) {
    case "charwise":
      return { ...state, anchor: { ...state.anchor }, head: { ...state.head }, goal: cloneGoal(state.goal) };
    case "linewise":
      return { ...state, cursor: state.cursor === undefined ? undefined : { ...state.cursor }, goal: cloneGoal(state.goal) };
    case "blockwise":
      return { ...state, anchor: { ...state.anchor }, head: { ...state.head }, goal: cloneGoal(state.goal) };
  }
}

function cloneGoal(goal: VimSelectionGoal | undefined): VimSelectionGoal | undefined {
  return goal === undefined ? undefined : { ...goal };
}

function visualStateToEditorSelection(editor: VimEditorCapabilities, state: VisualState): VimSelection {
  switch (state.kind) {
    case "charwise":
      return charwiseStateToEditorSelection(editor, state);
    case "linewise":
      return {
        type: "linewise",
        anchorLine: state.anchorLine,
        anchorColumn: state.anchorColumn,
        headLine: state.headLine,
        cursor: linewiseCursor(editor, state),
        goal: state.goal,
      };
    case "blockwise":
      return { type: "blockwise", anchor: state.anchor, head: state.head, cursor: state.head, goal: state.goal };
  }
}

function charwiseStateToEditorSelection(editor: VimEditorCapabilities, state: CharwiseVisualState): VimSelection {
  const lowered = lowerCharwiseGeometry(editor, state);
  return isForwardCharwiseVisualState(state) && state.cursor !== undefined
    ? { ...lowered, cursor: state.cursor }
    : lowered;
}

function charwiseVisualRange(editor: VimEditorCapabilities, state: CharwiseVisualState): TextRange {
  if (isForwardCharwiseVisualState(state)) {
    return {
      start: state.anchor,
      end: characterCellEnd(editor, state.head),
    };
  }

  return {
    start: state.head,
    end: characterCellEnd(editor, state.anchor),
  };
}

function isForwardCharwiseVisualState(state: CharwiseVisualState): boolean {
  return comparePositions(state.anchor, state.head) <= 0;
}

// Zed: `Object::always_expands_both_ways` — bracket/quote pairs replace both
// selection ends; word/sentence/paragraph objects only extend the head.
function objectAlwaysExpandsBothWays(object: TextObject): boolean {
  return object.type === "surround";
}

function rangeIsEmpty(range: TextRange): boolean {
  return range.start.row === range.end.row && range.start.column === range.end.column;
}

function charwiseStateForRange(editor: VimEditorCapabilities, range: TextRange): CharwiseVisualState {
  return {
    kind: "charwise",
    anchor: range.start,
    head: inclusiveHeadForRangeEnd(editor, range),
  };
}

// Vim: a linewise paragraph object moves the cursor to column zero of the
// object's last line. The raw visual anchor keeps its position; it only moves
// (to column zero of the object's first line) when the object starts above it.
function paragraphLinewiseStateForRange(state: VisualState, range: TextRange): LinewiseVisualState {
  const anchor = rawVisualAnchor(state);
  const anchorColumn = range.start.row < anchor.row ? 0 : anchor.column;
  return {
    kind: "linewise",
    anchorLine: range.start.row,
    anchorColumn,
    headLine: range.end.row,
    headColumn: 0,
    cursor: { row: range.end.row, column: 0 },
  };
}

function rawVisualAnchor(state: VisualState): Position {
  switch (state.kind) {
    case "charwise":
    case "blockwise":
      return state.anchor;
    case "linewise":
      return { row: state.anchorLine, column: state.anchorColumn };
  }
}

function inclusiveHeadForRangeEnd(editor: VimEditorCapabilities, range: TextRange): Position {
  if (range.end.row === range.start.row) {
    return { row: range.end.row, column: Math.max(range.start.column, range.end.column - 1) };
  }
  if (range.end.column > 0) {
    return { row: range.end.row, column: range.end.column - 1 };
  }
  return { row: range.end.row, column: 0 };
}

function visualIndentCursor(editor: VimEditorCapabilities, state: VisualState, direction: IndentDirection): Position {
  const start = visualStartPosition(state);
  switch (direction) {
    case "in":
      return { row: start.row, column: start.column + 4 };
    case "out":
      return { row: start.row, column: Math.max(0, start.column - Math.min(4, leadingWhitespaceLength(editor.line(start.row)))) };
    case "auto":
      return start;
  }
}

function leadingWhitespaceLength(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}

function visualRepeatSelectionForState(
  editor: VimEditorCapabilities,
  state: VisualState
): RecordedSelection {
  switch (state.kind) {
    case "charwise": {
      const range = charwiseVisualRange(editor, state);
      return {
        type: "charwise",
        rowDelta: range.end.row - range.start.row,
        columnDelta: range.end.column - range.start.column,
        endColumn: range.end.column,
      };
    }
    case "linewise": {
      const { startRow, endRow } = visualLineBounds(editor, state);
      return { type: "visualLine", rows: Math.max(0, endRow - startRow) };
    }
    case "blockwise":
      return { type: "none" };
  }
}

function visualIndentRepeatActionForState(
  editor: VimEditorCapabilities,
  state: VisualState,
  direction: IndentDirection
): { selection: RecordedSelection; action: VisualRepeatAction } {
  const { startRow, endRow } = visualLineBounds(editor, state);
  return {
    selection: { type: "visualLine", rows: Math.max(0, endRow - startRow) },
    action: { type: "indent", direction },
  };
}

function visualSurroundRanges(editor: VimEditorCapabilities, state: VisualState): readonly TextRange[] {
  return visualConvertRanges(editor, state);
}

// Zed: the visual fold-in — visual state lowers to an `OperatorTarget` so
// normal and visual mode apply operators through the same `apply*` modules.
function visualCharwiseTarget(editor: VimEditorCapabilities, state: CharwiseVisualState): OperatorTarget {
  return {
    kind: "charwise",
    targets: currentCharwiseVisualRanges(editor, state).map(range => ({ range, head: range.start })),
  };
}

function visualLinewiseTarget(
  state: LinewiseVisualState,
  { column, cursor }: { column: number; cursor?: Position }
): OperatorTarget {
  const { startLine, endLine } = lineBounds(state);
  return { kind: "linewise", rows: [{ startRow: startLine, endRow: endLine, column, cursor }] };
}

function visualConvertRanges(editor: VimEditorCapabilities, state: VisualState): readonly TextRange[] {
  switch (state.kind) {
    case "charwise":
      return currentCharwiseVisualRanges(editor, state);
    case "linewise": {
      const { startLine, endLine } = lineBounds(state);
      return [{ start: { row: startLine, column: 0 }, end: { row: endLine, column: editor.lineLength(endLine) } }];
    }
    case "blockwise": {
      const { startRow, endRow, startColumn, endColumn } = blockBounds(state);
      const ranges = [];
      for (let row = startRow; row <= endRow; row++) {
        ranges.push({
          start: { row, column: Math.min(startColumn, editor.lineLength(row)) },
          end: { row, column: Math.min(endColumn + 1, editor.lineLength(row)) },
        });
      }
      return ranges;
    }
  }
}

function visualLineBounds(editor: VimEditorCapabilities, state: VisualState): { startRow: number; endRow: number } {
  switch (state.kind) {
    case "charwise": {
      const range = charwiseVisualRange(editor, state);
      const endRow = range.end.column === 0 && range.end.row > range.start.row ? range.end.row - 1 : range.end.row;
      return { startRow: range.start.row, endRow };
    }
    case "linewise": {
      const { startLine, endLine } = lineBounds(state);
      return { startRow: startLine, endRow: endLine };
    }
    case "blockwise": {
      const { startRow, endRow } = blockBounds(state);
      return { startRow, endRow };
    }
  }
}

function visualUndoSelections(state: VisualState): readonly VimSelection[] {
  return [charwiseSelection(visualAnchorPosition(state))];
}

function visualAnchorPosition(state: VisualState): Position {
  switch (state.kind) {
    case "charwise":
      return state.anchor;
    case "linewise":
      return { row: state.anchorLine, column: 0 };
    case "blockwise":
      return state.anchor;
  }
}

function visualStartPosition(state: VisualState): Position {
  switch (state.kind) {
    case "charwise":
      return comparePositions(state.anchor, state.head) <= 0 ? state.anchor : state.head;
    case "linewise":
      return { row: Math.min(state.anchorLine, state.headLine), column: 0 };
    case "blockwise":
      return blockStart(state);
  }
}

function visualExitPosition(editor: VimEditorCapabilities, state: VisualState): Position {
  switch (state.kind) {
    case "charwise":
      if (
        editor.lineLength(state.anchor.row) === 0
        && state.head.row === state.anchor.row + 1
        && state.head.column === 0
      ) {
        return state.anchor;
      }
      return normalCursorPosition(editor, state.head);
    case "linewise":
      return linewiseCursor(editor, state);
    case "blockwise":
      return state.head;
  }
}

function linewiseCursor(editor: VimEditorCapabilities, state: LinewiseVisualState): Position {
  if (state.cursor !== undefined) return state.cursor;
  const row = state.headLine;
  return { row, column: Math.min(state.headColumn, Math.max(0, editor.lineLength(row) - 1)) };
}

function lineBounds(state: LinewiseVisualState): { startLine: number; endLine: number } {
  return {
    startLine: Math.min(state.anchorLine, state.headLine),
    endLine: Math.max(state.anchorLine, state.headLine),
  };
}

function linewiseText(editor: VimEditorCapabilities, state: LinewiseVisualState): string {
  const { startLine, endLine } = lineBounds(state);
  const lines: string[] = [];
  for (let row = startLine; row <= endLine; row++) {
    lines.push(editor.line(row));
  }
  return `${lines.join("\n")}\n`;
}

function linewiseEditRange(editor: VimEditorCapabilities, state: LinewiseVisualState): TextRange {
  const { startLine, endLine } = lineBounds(state);
  if (endLine + 1 < editor.lineCount()) {
    return { start: { row: startLine, column: 0 }, end: { row: endLine + 1, column: 0 } };
  }
  if (startLine > 0) {
    const previousLine = startLine - 1;
    return {
      start: { row: previousLine, column: editor.lineLength(previousLine) },
      end: { row: endLine, column: editor.lineLength(endLine) },
    };
  }
  return { start: { row: startLine, column: 0 }, end: { row: endLine, column: editor.lineLength(endLine) } };
}

function beginVisualUndoTransaction(editor: VimEditorCapabilities, state: VisualState): VimUndoTransaction {
  return editor.beginUndoTransaction(visualUndoSelections(state));
}

function openVisualChangeEditOptions() {
  return keepUndoTransactionOpen();
}

function pasteOverCharwise(
  editor: VimEditorCapabilities,
  registers: Registers,
  state: CharwiseVisualState,
  content: RegisterContent
): VisualState | undefined {
  const ranges = currentCharwiseVisualRanges(editor, state);
  const distributed = distributedRegisterParts(content, ranges.length);
  if (distributed !== undefined) {
    return pasteDistributedOverCharwise(editor, registers, state, ranges, distributed);
  }

  const range = charwiseVisualRange(editor, state);
  const deletedText = rangeText(editor, range);
  if (content.kind === "blockwise") {
    pasteBlockwiseOverCharwise(editor, registers, state, range, deletedText, content.text);
    return undefined;
  }

  const replacement = replacementForRegisterPart(content);
  const pastedRange = { start: range.start, end: positionAfterInsertedText(range.start, replacement.text) };

  registers.write(undefined, deletedText, "characterwise");
  beginVisualUndoTransaction(editor, state);
  editor.applyEdits([{ range, text: replacement.text }], [charwiseSelection(cursorAfterReplacement(range.start, replacement))]);
  return charwiseStateForRange(editor, pastedRange);
}

function distributedRegisterParts(content: RegisterContent, selectionCount: number): readonly RegisterPart[] | undefined {
  if (selectionCount <= 1) return undefined;
  if (content.parts?.length === selectionCount) return content.parts;

  const lines = linesForPlainTextDistribution(content.text, selectionCount);
  return lines === undefined ? undefined : lines.map(text => ({ text, kind: "characterwise" }));
}

function linesForPlainTextDistribution(text: string, selectionCount: number): readonly string[] | undefined {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withoutFinalLineSeparator = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const lines = withoutFinalLineSeparator.split("\n");
  return lines.length === selectionCount ? lines : undefined;
}

function pasteDistributedOverCharwise(
  editor: VimEditorCapabilities,
  registers: Registers,
  state: CharwiseVisualState,
  ranges: readonly TextRange[],
  parts: readonly RegisterPart[]
): VisualState | undefined {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  const deleted: string[] = [];
  let firstPastedRange: TextRange | undefined;

  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index];
    const part = parts[index];
    if (range === undefined || part === undefined) continue;
    const replacement = replacementForRegisterPart(part);
    deleted.push(rangeText(editor, range));
    edits.push({ range, text: replacement.text });
    selectionsAfter.push(charwiseSelection(cursorAfterReplacement(range.start, replacement)));
    firstPastedRange ??= { start: range.start, end: positionAfterInsertedText(range.start, replacement.text) };
  }

  if (deleted.length === 0) return undefined;
  registers.write(
    undefined,
    deleted.join("\n"),
    "characterwise",
    deleted.map(text => ({ text, kind: "characterwise" }))
  );
  const undoTransaction = editor.beginUndoTransaction(currentCharwiseVisualUndoSelections(editor, state));
  try {
    editor.applyEdits(edits, selectionsAfter);
  } finally {
    undoTransaction.finish();
  }
  return firstPastedRange === undefined ? undefined : charwiseStateForRange(editor, firstPastedRange);
}

type ReplacementText = { text: string; kind: RegisterPart["kind"] };

function replacementForRegisterPart(part: RegisterPart): ReplacementText {
  return {
    text: part.kind === "linewise" ? `\n${ensureTrailingNewline(part.text)}` : part.text,
    kind: part.kind,
  };
}

function cursorAfterReplacement(start: Position, replacement: ReplacementText): Position {
  return replacement.kind === "linewise"
    ? { row: start.row + 1, column: 0 }
    : cursorAtEndOfInsertedText(start, replacement.text);
}

function pasteBlockwiseOverCharwise(
  editor: VimEditorCapabilities,
  registers: Registers,
  state: CharwiseVisualState,
  range: TextRange,
  deletedText: string,
  text: string
): void {
  const blockLines = text.split("\n");
  const edits: TextEdit[] = [{ range, text: blockLines[0] ?? "" }];
  for (let index = 1; index < blockLines.length; index++) {
    const row = range.start.row + index;
    if (row >= editor.lineCount()) break;
    const insertAt = { row, column: Math.min(range.start.column, editor.lineLength(row)) };
    edits.push({ range: { start: insertAt, end: insertAt }, text: blockLines[index] });
  }
  registers.write(undefined, deletedText, "characterwise");
  beginVisualUndoTransaction(editor, state);
  editor.applyEdits(edits, [charwiseSelection({ row: range.start.row, column: range.start.column })]);
}

function pasteOverLinewise(
  editor: VimEditorCapabilities,
  registers: Registers,
  state: LinewiseVisualState,
  content: RegisterContent
): void {
  const range = linewiseEditRange(editor, state);
  const replacementText = content.kind === "linewise"
    ? ensureTrailingNewline(content.text)
    : `${content.text}\n`;
  const { startLine } = lineBounds(state);

  if (content.kind === "linewise") {
    registers.write(undefined, linewiseText(editor, state), "linewise");
  }

  beginVisualUndoTransaction(editor, state);
  editor.applyEdits([{ range, text: replacementText }], [charwiseSelection({ row: startLine, column: 0 })]);
}

function pasteOverBlockwise(
  editor: VimEditorCapabilities,
  _registers: Registers,
  state: BlockwiseVisualState,
  content: RegisterContent
): void {
  const blockLines = content.text.split("\n");
  if (blockLines.length === 0) return;

  const { startRow, endRow, startColumn } = blockBounds(state);
  const edits: TextEdit[] = [];

  for (let row = startRow; row <= endRow; row++) {
    const blockLine = content.kind === "blockwise"
      ? blockLines[row - startRow] ?? ""
      : blockLines[0];
    edits.push({ range: blockRangeForRow(editor, state, row), text: blockLine });
  }

  beginVisualUndoTransaction(editor, state);
  editor.applyEdits(edits, [charwiseSelection({ row: startRow, column: startColumn + blockLines[0].length - 1 })]);
}

function currentCharwiseVisualStates(
  editor: VimEditorCapabilities,
  state: CharwiseVisualState
): readonly CharwiseVisualState[] {
  const states = editor.getSelections().flatMap(selection =>
    selection.type === "charwise"
      ? [externalSelectionToCharwiseState(editor, selection)]
      : []);
  return states.length === 0 ? [state] : states;
}

function currentCharwiseVisualRanges(
  editor: VimEditorCapabilities,
  state: CharwiseVisualState
): readonly TextRange[] {
  const ranges = editor.getSelections().flatMap(selection => {
    if (selection.type !== "charwise") return [];
    if (isEditorOwnedCharwiseSelection(selection)) return [rangeOfSelection(selection)];
    return [charwiseVisualRange(editor, externalSelectionToCharwiseState(editor, selection))];
  });
  return ranges.length === 0 ? [charwiseVisualRange(editor, state)] : ranges;
}

function currentCharwiseVisualUndoSelections(
  editor: VimEditorCapabilities,
  state: CharwiseVisualState
): readonly VimSelection[] {
  const selections = editor.getSelections();
  return selections.length <= 1 ? visualUndoSelections(state) : selections;
}

function visualCurrentUndoSelections(
  editor: VimEditorCapabilities,
  state: VisualState
): readonly VimSelection[] {
  return state.kind === "charwise" ? currentCharwiseVisualUndoSelections(editor, state) : visualUndoSelections(state);
}

function deleteBlockwise(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  state: BlockwiseVisualState,
  { collapse }: { collapse: boolean }
): void {
  const { startRow, endRow, startColumn } = blockBounds(state);
  const edits: TextEdit[] = [];
  const deleted: string[] = [];

  for (let row = startRow; row <= endRow; row++) {
    const range = blockRangeForRow(editor, state, row);
    deleted.push(rangeText(editor, range));
    edits.push({ range, text: "" });
  }

  registers.writeDelete(
    registerName,
    deleted.join("\n"),
    "blockwise",
    deleted.map(text => ({ text, kind: "blockwise" }))
  );
  const selectionsAfter = collapse
    ? [charwiseSelection({ row: startRow, column: startColumn })]
    : blockInsertSelections(editor, state, { side: "start" });
  const undoTransaction = beginVisualUndoTransaction(editor, state);
  editor.applyEdits(
    edits,
    selectionsAfter,
    collapse ? {} : openVisualChangeEditOptions()
  );
  if (collapse) undoTransaction.finish();
}

function enterBlockInsert(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  state: BlockwiseVisualState,
  { deleteSelection, side }: { deleteSelection: boolean; side: "start" | "end" }
): void {
  if (deleteSelection) {
    deleteBlockwise(editor, registers, registerName, state, { collapse: false });
  } else {
    editor.setSelections(blockInsertSelections(editor, state, { side }));
  }
}

function visualMultilineInsertSelections(
  editor: VimEditorCapabilities,
  state: CharwiseVisualState | LinewiseVisualState,
  { side }: { side: "start" | "end" }
): VimSelection[] {
  if (state.kind === "linewise") {
    const { startLine, endLine } = lineBounds(state);
    const selections: VimSelection[] = [];
    for (let row = startLine; row <= endLine; row++) {
      const endColumn = startLine === endLine
        ? Math.min(state.headColumn + 1, editor.lineLength(row))
        : editor.lineLength(row);
      selections.push(charwiseSelection(side === "start" ? firstNonWhitespace(editor.line(row), row) : { row, column: endColumn }));
    }
    return selections;
  }

  return currentCharwiseVisualRanges(editor, state).flatMap(range => visualMultilineInsertSelectionsForRange(editor, range, { side }));
}

function visualMultilineInsertSelectionsForRange(
  editor: VimEditorCapabilities,
  range: TextRange,
  { side }: { side: "start" | "end" }
): VimSelection[] {
  const end = inclusiveHeadForRangeEnd(editor, range);
  const selections: VimSelection[] = [];
  for (let row = range.start.row; row <= end.row; row++) {
    if (side === "start") {
      selections.push(charwiseSelection(row === range.start.row ? range.start : firstNonWhitespace(editor.line(row), row)));
    } else {
      selections.push(charwiseSelection(row === end.row ? { row, column: Math.min(range.end.column, editor.lineLength(row)) } : { row, column: editor.lineLength(row) }));
    }
  }
  return selections;
}

function blockInsertSelections(
  editor: VimEditorCapabilities,
  state: BlockwiseVisualState,
  { side }: { side: "start" | "end" }
): VimSelection[] {
  const { startRow, endRow, startColumn, endColumn } = blockBounds(state);
  const selections: VimSelection[] = [];
  for (let row = startRow; row <= endRow; row++) {
    const column = side === "start"
      ? startColumn
      : state.goal?.type === "endOfLine" ? editor.lineLength(row) : endColumn + 1;
    selections.push(charwiseSelection({ row, column: Math.min(column, editor.lineLength(row)) }));
  }
  return selections;
}

function blockRanges(editor: VimEditorCapabilities, state: BlockwiseVisualState): TextRange[] {
  const { startRow, endRow } = blockBounds(state);
  const ranges: TextRange[] = [];
  for (let row = startRow; row <= endRow; row++) {
    ranges.push(blockRangeForRow(editor, state, row));
  }
  return ranges;
}

function blockRangeForRow(editor: VimEditorCapabilities, state: BlockwiseVisualState, row: number): TextRange {
  const { startColumn, endColumn } = blockBounds(state);
  const lineLength = editor.lineLength(row);
  return {
    start: { row, column: Math.min(startColumn, lineLength) },
    end: { row, column: state.goal?.type === "endOfLine"
      ? lineLength
      : Math.min(endColumn + 1, lineLength) },
  };
}

function blockwiseText(editor: VimEditorCapabilities, state: BlockwiseVisualState): string {
  return blockRanges(editor, state).map(range => rangeText(editor, range)).join("\n");
}

function blockBounds(state: BlockwiseVisualState): {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
} {
  return {
    startRow: Math.min(state.anchor.row, state.head.row),
    endRow: Math.max(state.anchor.row, state.head.row),
    startColumn: Math.min(state.anchor.column, state.head.column),
    endColumn: Math.max(state.anchor.column, state.head.column),
  };
}

function blockStart(state: BlockwiseVisualState): Position {
  const { startRow, startColumn } = blockBounds(state);
  return { row: startRow, column: startColumn };
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function cursorAtEndOfInsertedText(start: Position, text: string): Position {
  const after = positionAfterInsertedText(start, text);
  if (text.length === 0) return start;
  const lines = text.split("\n");
  if (lines.length === 1) return { row: after.row, column: Math.max(start.column, after.column - 1) };
  const lastLineLength = lines[lines.length - 1].length;
  return { row: after.row, column: Math.max(0, lastLineLength - 1) };
}
