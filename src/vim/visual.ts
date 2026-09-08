// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `visual` module
// - translated concepts: visual-mode state and execution helpers for actions resolved
//   by keymap.ts, plus visual-line/block lowering and visual edits
// - intentional differences: this is still a model-buffer subset. Zed lowers visual
//   block mode through editor selections over a display map (`visual_block_motion`);
//   here we keep a compact semantic block state and lower to model edits/selections.

import { graphemeStart, nextGraphemeBoundary, previousGraphemeBoundary } from "./grapheme.js";
import { VimConfiguration } from "./config.js";
import { isEditorOwnedCharwiseSelection } from "./editor_state_sync.js";
import { VimEditorCapabilities, VimUndoTransaction, keepUndoTransactionOpen, normalCursorPosition, rangeText } from "./editor.js";
import { firstNonWhitespace, positionAfterInsertedText } from "./insert.js";
import { applyMotionWithGoal, hostViewLineSelectionsForMotion, lineRange, linewiseCursorAfterDelete, matchingPositionFromLine, Motion } from "./motion.js";
import { TextObject, textObjectForKey, textObjectRange } from "./object.js";
import { ConvertTarget, convertRanges } from "./normal/convert.js";
import { incrementNumbers } from "./normal/increment.js";
import { IndentDirection } from "./normal/indent.js";
import { RecordedSelection, VisualRepeatAction } from "./normal/repeat.js";
import { replaceWithRegisterWouldEdit } from "./normal/replace_with_register.js";
import { joinLines } from "./normal/join.js";
import { applyComment } from "./normal/comment.js";
import { applyFormat } from "./normal/format.js";
import type { FormatOptions } from "./normal/format.js";
import { RegisterContent, RegisterName, RegisterPart, Registers } from "./registers.js";
import { ResolvedTarget, applyOperatorToTarget } from "./operator_target.js";
import { canonicalVimSelection, canonicalizationChangesMeaning, characterCellEnd, lowerCharwiseGeometry, raiseCharwiseSelection } from "./selection_geometry.js";
import { addSurrounds, addTagSurrounds } from "./surrounds.js";
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

export type VisualModeKind = "visual" | "visualLine" | "visualBlock";

// The visual-mode command vocabulary [VisualMode.handleCommand] executes,
// produced by the typed visual grammar (visual_handler.ts).
export type VisualCommand =
  | { type: "insertAtSelection"; side: "start" | "end" }
  | { type: "indent"; key: ">" | "<" | "="; count?: number }
  | { type: "convert"; key: "u" | "U" | "~" }
  | { type: "otherEnd"; rowAware: boolean }
  | { type: "yankLinewise" }
  | { type: "yank" }
  | { type: "deleteToLineEnd" }
  | { type: "delete" }
  | { type: "change" }
  | { type: "changeLines" }
  | { type: "paste"; preserveSourceRegister: boolean }
  | { type: "replaceWithRegister" }
  | { type: "percentOrMatching" };

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

// Proof that a command tore down the visual session (state cleared, block
// cursor restored). Produced only by [VisualMode.endSession], so a
// visual-grammar command routed through `exitVisualEffect` (visual_handler.ts)
// cannot compile without the teardown: the "left visual mode with the session
// alive" bug class becomes a type error instead of a runtime ghost. The
// unique-symbol brand prevents constructing the proof outside this module.
declare const visualSessionEndBrand: unique symbol;
export type VisualSessionEnd = { readonly [visualSessionEndBrand]: true };
const VISUAL_SESSION_END = {} as VisualSessionEnd;

export class VisualMode {
  private state: VisualState | undefined;
  private lastState: VisualState | undefined;

  private visualMultilineInsert: boolean;

  constructor(
    private readonly editor: VimEditorCapabilities,
    private readonly registers: Registers,
    private readonly registerSelection: RegisterSelection,
    private readonly countState: CountState,
    configuration: Pick<VimConfiguration, "visualMultilineInsert">
  ) {
    this.visualMultilineInsert = configuration.visualMultilineInsert;
  }

  setConfiguration(configuration: Pick<VimConfiguration, "visualMultilineInsert">): void {
    this.visualMultilineInsert = configuration.visualMultilineInsert;
  }


  enter(kind: VisualState["kind"] = "charwise"): void {
    const selections = this.editor.getSelections();
    const selection = selections[0];
    const head = selectionHead(selection);
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
    this.registerSelection.clear();
    this.countState.clear();
  }

  // The active visual kind as a [VimMode], or undefined when not in visual mode.
  // Used by the framework visual grammar to compute the target mode of a
  // mode-toggling key (`v`/`V`/`ctrl-v`).
  currentMode(): RestoredVisualMode | undefined {
    if (this.state === undefined) return undefined;
    switch (this.state.kind) {
      case "charwise":
        return "visual";
      case "linewise":
        return "visualLine";
      case "blockwise":
        return "visualBlock";
    }
  }

  exit(): void {
    const state = this.state;
    if (state !== undefined) this.rememberState(state);
    this.state = undefined;
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

  // [registerOverride] lets the framework visual grammar supply the selected
  // register directly (its `"a` prefix lives in the executor, not the legacy
  // [registerSelection]). When omitted, the register is taken from
  // [registerSelection] as before.
  handleCommand(command: VisualCommand, registerOverride?: RegisterName): VisualKeyResult {
    const state = this.state;
    if (state === undefined) return handled({ exitVisual: true });
    switch (command.type) {
      case "insertAtSelection":
        return command.side === "start"
          ? this.insertBeforeOrAtBlockStart(state) ?? handled()
          : this.insertAfterOrAtBlockEnd(state) ?? handled();
      case "indent":
        return this.indentKey(state, command.key, command.count ?? 1);
      case "convert":
        this.convert(state, convertTargetForKey(command.key));
        return handled({ exitVisual: true, nextMode: "normal" });
      case "otherEnd":
        return this.otherEnd(state, { rowAware: command.rowAware });
      case "yankLinewise":
        return this.yankLinewiseKey(state, registerOverride);
      case "yank":
        return this.yankKey(state, registerOverride);
      case "deleteToLineEnd":
        return this.deleteToLineEndKey(state, registerOverride);
      case "delete":
        return this.deleteKey(state, registerOverride);
      case "change":
        return this.changeKey(state, registerOverride);
      case "changeLines":
        // Vim `v_R`: the change always operates on whole lines.
        return this.changeKey(state.kind === "linewise" ? state : stateToLinewise(state), registerOverride);
      case "paste":
        return this.pasteKey(state, registerOverride, { preserveSourceRegister: command.preserveSourceRegister });
      case "replaceWithRegister":
        return this.replaceWithRegisterKey(state, registerOverride);
      case "percentOrMatching":
        return this.percentKey(state);
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

  // Vim `v_>`: the count multiplies the shift ("{count} times 'shiftwidth'").
  private indentKey(state: VisualState, key: ">" | "<" | "=", count: number): VisualKeyResult {
    const direction = indentDirectionForKey(key);
    const repeatAction = visualIndentRepeatActionForState(this.editor, state, direction, count);
    this.indent(state, direction, count);
    return handled({ exitVisual: true, nextMode: "normal", repeatAction });
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

  private yankLinewiseKey(state: VisualState, registerOverride?: RegisterName): VisualKeyResult {
    const cursor = this.yankLinewise(state, this.takeSelectedRegister(registerOverride));
    if (cursor !== undefined) this.rememberState(state);
    this.state = undefined;
    this.editor.setCursorStyle("block");
    this.editor.setSelections([charwiseSelection(cursor ?? visualStartPosition(state))]);
    return handled({ exitVisual: true, nextMode: "normal" });
  }

  private yankKey(state: VisualState, registerOverride?: RegisterName): VisualKeyResult {
    this.yank(state, this.takeSelectedRegister(registerOverride));
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

  private deleteToLineEndKey(state: VisualState, registerOverride?: RegisterName): VisualKeyResult {
    this.rememberState(state);
    this.deleteToLineEnd(state, this.takeSelectedRegister(registerOverride));
    this.state = undefined;
    this.editor.setCursorStyle("block");
    return handled({ exitVisual: true, nextMode: "normal" });
  }

  private deleteKey(state: VisualState, registerOverride?: RegisterName): VisualKeyResult {
    const selection = visualRepeatSelectionForState(this.editor, state);
    this.rememberState(state);
    this.delete(state, this.takeSelectedRegister(registerOverride));
    this.state = undefined;
    this.editor.setCursorStyle("block");
    return handled({ exitVisual: true, nextMode: "normal", repeatAction: { selection, action: { type: "delete" } } });
  }

  private changeKey(state: VisualState, registerOverride?: RegisterName): VisualKeyResult {
    const selection = visualRepeatSelectionForState(this.editor, state);
    this.rememberState(state);
    this.change(state, this.takeSelectedRegister(registerOverride));
    this.state = undefined;
    this.editor.setCursorStyle("line");
    return handled({ exitVisual: true, enterInsert: true, nextMode: "insert", pendingRepeatChange: { selection } });
  }

  private pasteKey(
    state: VisualState,
    registerOverride: RegisterName | undefined,
    { preserveSourceRegister }: { preserveSourceRegister: boolean }
  ): VisualKeyResult {
    const pastedState = this.paste(state, this.takeSelectedRegister(registerOverride), { preserveSourceRegister });
    this.rememberState(pastedState ?? state);
    this.state = undefined;
    this.editor.setCursorStyle("block");
    return handled({ exitVisual: true, nextMode: "normal" });
  }

  private replaceWithRegisterKey(state: VisualState, registerOverride?: RegisterName): VisualKeyResult {
    if (state.kind === "blockwise") return handled();
    const registerName = this.takeSelectedRegister(registerOverride);
    if (this.registers.readContentIfPresent(registerName) === undefined) return handled();
    const selection = visualRepeatSelectionForState(this.editor, state);
    this.rememberState(state);
    const target = state.kind === "charwise"
      ? visualCharwiseTarget(this.editor, state)
      : visualLinewiseTarget(state, { column: 0 });
    const didEdit = replaceWithRegisterWouldEdit(this.editor, this.registers, registerName, target);
    applyOperatorToTarget(
      this.editor,
      this.registers,
      registerName,
      { type: "replaceWithRegister" },
      target
    );
    this.state = undefined;
    this.editor.setCursorStyle("block");
    return handled({
      exitVisual: true,
      nextMode: "normal",
      repeatAction: didEdit
        ? { selection, action: { type: "replaceWithRegister", registerName } }
        : undefined,
    });
  }

  private percentKey(state: VisualState): VisualKeyResult {
    // Legacy path: the count lives in [countState].
    const count = this.countState.get().length > 0 ? this.takeCount(1) : undefined;
    return this.percentOrMatchingForState(state, count);
  }

  // Framework `%`: with a count it is go-to-percentage; without, it extends a
  // charwise selection to the matching bracket. The count is supplied explicitly
  // (the framework owns the count) rather than read from the legacy [countState].
  percentOrMatching(count: number | undefined): VisualKeyResult {
    const state = this.state;
    if (state === undefined) return handled();
    return this.percentOrMatchingForState(state, count);
  }

  private percentOrMatchingForState(state: VisualState, count: number | undefined): VisualKeyResult {
    if (count !== undefined) {
      this.applyVisualMotion(state, { type: "goToPercentage", percent: count }, 1, { displayLine: false });
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

    return handled();
  }

  // Framework path: surround the current visual selection with the pair named by
  // [pairKey] (vim-surround `S{char}`). Combines the legacy range capture and
  // apply into one step, reading the live selection — no operator stack (nothing
  // edits the buffer between `S` and the pair key, so the ranges are unchanged).
  addSurround(pairKey: string): VisualKeyResult {
    return this.addSurroundWith(state =>
      addSurrounds(this.editor, visualSurroundRanges(this.editor, state), pairKey, { linewise: state.kind === "linewise" })
    );
  }

  // Visual `St`/`S<`: wrap the selection in a typed tag (vim-surround tag
  // entry mode).
  addTagSurround(tagBody: string): VisualKeyResult {
    return this.addSurroundWith(state =>
      addTagSurrounds(this.editor, visualSurroundRanges(this.editor, state), tagBody, { linewise: state.kind === "linewise" })
    );
  }

  private addSurroundWith(apply: (state: VisualState) => void): VisualKeyResult {
    const state = this.state;
    if (state === undefined) return handled();
    withUndoTransaction(this.editor, visualCurrentUndoSelections(this.editor, state), () => apply(state));
    this.state = undefined;
    this.editor.setCursorStyle("block");
    return handled({ exitVisual: true, nextMode: "normal" });
  }

  // Framework path: expand the live selection to the text object named by [key].
  // [around] (`i` vs `a`) and [count] are supplied directly, so no operator stack
  // is involved.
  applyTextObject(around: boolean, key: string, count: number): VisualKeyResult {
    const state = this.state;
    const object = textObjectForKey(key);
    if (state === undefined || object === undefined) {
      this.exit();
      return handled({ exitVisual: true, nextMode: "normal" });
    }

    // Linewise objects (paragraph, indent, entire) handle blank cursor lines
    // themselves; other objects fail on an empty line.
    const linewiseObject = object.type === "paragraph" || object.type === "indent" || object.type === "entire";
    const states = state.kind === "charwise" ? currentCharwiseVisualStates(this.editor, state) : [state];
    if (states.some(state => !linewiseObject && this.editor.lineLength(visualObjectPosition(this.editor, state).row) === 0)) {
      this.syncEditorSelection();
      return handled();
    }

    if (linewiseObject) {
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
          : { row: selectionEnd.row, column: nextGraphemeBoundary(this.editor.line(selectionEnd.row), selectionEnd.column) };
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
      case "blockwise": {
        const ranges = blockRanges(this.editor, state);
        const parts = ranges
          .map(range => ({ text: rangeText(this.editor, range), kind: "blockwise" as const }));
        if (parts.some(part => part.text.length > 0)) {
          this.registers.writeYank(registerName, parts.map(part => part.text).join("\n"), "blockwise", parts);
          // VSCodeVim `highlightedyank` (`YankVisualBlockMode.run`): one
          // highlight per block row.
          this.editor.highlightYankedRanges(ranges);
        }
        break;
      }
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
    // VSCodeVim `highlightedyank`: linewise yanks highlight the full lines.
    this.editor.highlightYankedRanges([{
      start: { row: bounds.startRow, column: 0 },
      end: { row: bounds.endRow, column: this.editor.lineLength(bounds.endRow) },
    }]);
    return { row: bounds.startRow, column: 0 };
  }

  private deleteToLineEnd(state: VisualState, registerName: RegisterName | undefined): void {
    if (state.kind === "blockwise") {
      const { startRow, endRow, startColumn } = blockBounds(state);
      const edits: TextEdit[] = [];
      const copied: string[] = [];
      for (let row = startRow; row <= endRow; row++) {
        const line = this.editor.line(row);
        const start = { row, column: blockStartColumnForLine(line, startColumn) };
        const end = { row, column: line.length };
        edits.push({ range: { start, end }, text: "" });
        copied.push(rangeText(this.editor, { start, end }));
      }
      const cursorColumn = Math.max(0, Math.min(startColumn, this.editor.lineLength(startRow)) - 1);
      this.editor.applyEdits(edits, [charwiseSelection({ row: startRow, column: cursorColumn })]);
      if (copied.some(text => text.length > 0)) {
        this.registers.writeDelete(
          registerName,
          copied.join("\n"),
          "blockwise",
          copied.map(text => ({ text, kind: "blockwise" }))
        );
      }
      return;
    }

    const { startRow, endRow } = visualLineBounds(this.editor, state);
    const anchor = visualAnchorPosition(state);
    const count = endRow - startRow + 1;
    const range = lineRange(this.editor, startRow, count);
    const copied: string[] = [];
    for (let row = startRow; row <= endRow; row++) copied.push(this.editor.line(row));
    this.editor.applyEdits(
      [{ range, text: "" }],
      [charwiseSelection(linewiseCursorAfterDelete(this.editor, startRow, anchor.column, count))]
    );
    this.registers.writeDelete(registerName, `${copied.join("\n")}\n`, "linewise");
  }

  private delete(state: VisualState, registerName: RegisterName | undefined): void {
    switch (state.kind) {
      case "charwise": {
        withUndoTransaction(this.editor, currentCharwiseVisualUndoSelections(this.editor, state), () =>
          applyOperatorToTarget(this.editor, this.registers, registerName, { type: "delete" }, visualCharwiseTarget(this.editor, state)));
        break;
      }
      case "linewise": {
        const { startLine, endLine } = lineBounds(state);
        withVisualUndoTransaction(this.editor, state, () =>
          applyOperatorToTarget(this.editor, this.registers, registerName, { type: "delete" }, visualLinewiseTarget(state, {
            column: state.headColumn,
            // Vim `v_d` linewise: the cursor column clamps against the line
            // that follows the deleted range, not the first deleted line.
            cursor: linewiseCursorAfterDelete(this.editor, startLine, state.headColumn, endLine - startLine + 1),
          })));
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

  // The single visual-session teardown: every command that exits visual mode
  // with an edit ends by returning this proof (see [VisualSessionEnd]).
  private endSession(): VisualSessionEnd {
    this.state = undefined;
    this.editor.setCursorStyle("block");
    return VISUAL_SESSION_END;
  }

  joinSelections({ insertWhitespace }: { insertWhitespace: boolean }): VisualSessionEnd {
    if (this.state === undefined) return this.endSession();
    return this.join(this.state, { insertWhitespace });
  }

  // Visual `gq`/`gw`: format the selected lines and exit visual. Like [join],
  // this owns the visual-session teardown (remember for `gv`, clear the state,
  // restore the block cursor) — the owner's normal-mode transition relies on
  // the command's effect having done it.
  formatSelections(options: FormatOptions): VisualSessionEnd {
    const state = this.state;
    if (state === undefined) return this.endSession();
    this.rememberState(state);
    const { startRow, endRow } = visualLineBounds(this.editor, state);
    applyFormat(this.editor, { kind: "linewise", rows: [{ startRow, endRow, column: 0 }] }, options);
    return this.endSession();
  }

  private join(state: VisualState, { insertWhitespace }: { insertWhitespace: boolean }): VisualSessionEnd {
    this.rememberState(state);
    const { startRow, endRow } = visualLineBounds(this.editor, state);
    joinLines(this.editor, startRow, Math.max(1, endRow - startRow), { insertWhitespace });
    return this.endSession();
  }

  convertSelections(target: ConvertTarget): VisualSessionEnd {
    if (this.state === undefined) return this.endSession();
    return this.convert(this.state, target);
  }

  // Visual `gc`/`gC` (vim-commentary): toggle line comments over the selected
  // rows, or a block comment over the exact charwise selection for `gC`. The
  // cursor lands on the selection start (like the plugin); the native command
  // applies asynchronously and restores it via [selectionsAfter].
  commentSelections({ block }: { block: boolean }): VisualSessionEnd {
    const state = this.state;
    if (state === undefined) return this.endSession();
    this.rememberState(state);
    let target: ResolvedTarget;
    if (block && state.kind === "charwise") {
      target = visualCharwiseTarget(this.editor, state);
    } else {
      const { startRow, endRow } = visualLineBounds(this.editor, state);
      target = { kind: "linewise", rows: [{ startRow, endRow, column: 0 }] };
    }
    const cursor =
      target.kind === "charwise"
        ? target.targets[0]?.range.start ?? visualAnchorPosition(state)
        : { row: target.rows[0].startRow, column: 0 };
    applyComment(this.editor, target, { block, cursorsAfter: [cursor] });
    return this.endSession();
  }

  // Vim `v_r{char}`: replace every character in the selection with [char],
  // preserving the line breaks (each line's own characters are replaced), then
  // collapse to normal with the cursor at the selection start. Mirrors Zed's
  // `Vim::visual_replace`, which splits each selection by display line and
  // replaces each grapheme with the typed text; `r<CR>` replaces with line
  // breaks the same way.
  replaceSelection(char: string): VisualKeyResult {
    const state = this.state;
    if (state === undefined) return handled({ exitVisual: true, nextMode: "normal" });
    this.rememberState(state);
    const replacement = char === "enter" ? "\n" : char;
    const ranges = replaceRanges(this.editor, state);
    const cursor = normalCursorPosition(this.editor, ranges[0]?.start ?? visualAnchorPosition(state));
    const edits: TextEdit[] = ranges.map(range => ({
      range,
      text: replacement.repeat(graphemeCellCount(this.editor.line(range.start.row), range.start.column, range.end.column)),
    }));
    withVisualUndoTransaction(this.editor, state, () =>
      this.editor.applyEdits(edits, [charwiseSelection(cursor)]));
    this.state = undefined;
    this.editor.setCursorStyle("block");
    return handled({ exitVisual: true, nextMode: "normal" });
  }

  // Vim visual `ctrl-a`/`ctrl-x` (and `g ctrl-a`/`g ctrl-x`): increment the
  // numbers in the selection. [delta] is the signed step; [cumulativeStep] adds
  // an extra multiple per matched number on successive lines (`g ctrl-a`), else
  // 0. Exits the visual selection (the caller transitions to normal).
  increment(delta: number, cumulativeStep: number): VisualSessionEnd {
    const state = this.state;
    if (state === undefined) return this.endSession();
    // Vim: a visual operator moves the cursor to the selection start before
    // changing text, so that is where `u` later restores it.
    const selection = this.editor.getSelections()[0];
    if (selection !== undefined) {
      this.editor.beginUndoTransaction([charwiseSelection(rangeOfSelection(selection).start)]);
    }
    incrementNumbers(this.editor, delta, cumulativeStep);
    this.editor.finishUndoTransaction();
    return this.endSession();
  }

  private convert(state: VisualState, target: ConvertTarget): VisualSessionEnd {
    this.rememberState(state);
    // Vim: a visual operator moves the cursor to the selection start before
    // changing text, so that is where `u` later restores it.
    withVisualUndoTransaction(this.editor, state, () => {
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
    });
    return this.endSession();
  }

  private indent(state: VisualState, direction: IndentDirection, count: number): void {
    this.rememberState(state);
    const cursor = visualIndentCursor(state);
    const { startRow, endRow } = visualLineBounds(this.editor, state);
    applyOperatorToTarget(this.editor, this.registers, undefined, { type: "indent", direction, count }, {
      kind: "linewise",
      rows: [{ startRow, endRow, column: cursor.column }],
    });
    // Vim `v_>`: the cursor lands on the visual start, column unshifted but
    // clamped to the shifted line's last cell.
    this.editor.setSelections([charwiseSelection(normalCursorPosition(this.editor, cursor))]);
    this.state = undefined;
    this.editor.setCursorStyle("block");
  }

  private paste(
    state: VisualState,
    registerName: RegisterName | undefined,
    { preserveSourceRegister }: { preserveSourceRegister: boolean }
  ): VisualState | undefined {
    const content = this.registers.readContent(registerName);
    if (content.text.length === 0) return undefined;

    switch (state.kind) {
      case "charwise":
        return pasteOverCharwise(this.editor, this.registers, state, content, { preserveSourceRegister });
      case "linewise":
        pasteOverLinewise(this.editor, this.registers, state, content, { preserveSourceRegister });
        return undefined;
      case "blockwise":
        pasteOverBlockwise(this.editor, this.registers, state, content, { preserveSourceRegister });
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

  private takeSelectedRegister(registerOverride?: RegisterName): RegisterName | undefined {
    if (registerOverride !== undefined) return registerOverride;
    return this.registerSelection.take();
  }

  private clearPendingInteraction(): void {
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
  // Zed's `visual_motion` passes `times` to `Motion::move_point` once. This
  // leaves each motion responsible for its own count semantics (`_` is
  // count - 1 rows, while `j` is count rows) instead of encoding them here.
  switch (state.kind) {
    case "charwise":
      return charwiseStateAfterMotion(editor, state, motion, count);
    case "linewise":
      return linewiseStateAfterMotion(editor, state, motion, count);
    case "blockwise":
      return blockwiseStateAfterMotion(editor, state, motion, count);
  }
}

function charwiseStateAfterMotion(
  editor: VimEditorCapabilities,
  state: CharwiseVisualState,
  motion: Motion,
  count: number
): CharwiseVisualState {
  if (motion.type === "right") {
    const head = charwiseRight(editor, state.head, count);
    return { ...state, head, cursor: undefined, goal: undefined };
  }
  if (motion.type === "endOfLine") {
    const row = Math.min(state.head.row + count - 1, editor.lineCount() - 1);
    const head = { row, column: editor.lineLength(row) };
    return { ...state, head, cursor: undefined, goal: { type: "endOfLine" } };
  }
  const result = applyMotionWithGoal(editor, state.head, motion, count, state.goal);
  return {
    ...state,
    head: result.position,
    cursor: undefined,
    goal: result.goal ?? (motion.type === "nextWordStart" ? { type: "modelColumn", column: result.position.column } : undefined),
  };
}

function charwiseRight(editor: VimEditorCapabilities, head: Position, count: number): Position {
  const line = editor.line(head.row);
  let column = head.column;
  for (let step = 0; step < count && column < line.length; step++) {
    column = nextGraphemeBoundary(line, column);
  }
  return { row: head.row, column };
}

function linewiseStateAfterMotion(
  editor: VimEditorCapabilities,
  state: LinewiseVisualState,
  motion: Motion,
  count: number
): LinewiseVisualState {
  switch (motion.type) {
    case "up":
      return { ...state, headLine: Math.max(0, state.headLine - count), goal: undefined };
    case "down":
      return { ...state, headLine: Math.min(editor.lineCount() - 1, state.headLine + count), goal: undefined };
    case "endOfDocument":
      return { ...state, headLine: editor.lineCount() - 1, goal: undefined };
    case "endOfLine": {
      const headLine = Math.min(state.headLine + count - 1, editor.lineCount() - 1);
      return { ...state, headLine, headColumn: editor.lineLength(headLine) };
    }
    default: {
      const result = applyMotionWithGoal(editor, linewiseCursor(editor, state), motion, count, state.goal);
      return { ...state, headLine: result.position.row, headColumn: result.position.column, goal: result.goal };
    }
  }
}

function blockwiseStateAfterMotion(
  editor: VimEditorCapabilities,
  state: BlockwiseVisualState,
  motion: Motion,
  count: number
): BlockwiseVisualState {
  const { position, goal } = applyMotionWithGoal(
    editor,
    state.head,
    motion,
    count,
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
      return { ...state, goal: cloneGoal(state.goal) };
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
  const endLine = editor.line(range.end.row);
  if (range.end.row === range.start.row) {
    return { row: range.end.row, column: Math.max(range.start.column, previousGraphemeBoundary(endLine, range.end.column)) };
  }
  if (range.end.column > 0) {
    return { row: range.end.row, column: previousGraphemeBoundary(endLine, range.end.column) };
  }
  return { row: range.end.row, column: 0 };
}

// Neovim `v_>` (probed): the cursor lands on the visual start's position with
// its column unshifted, clamped to the shifted line by the selection
// write-back — not shifted with the text, and not the first non-blank.
function visualIndentCursor(state: VisualState): Position {
  return visualStartPosition(state);
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
  direction: IndentDirection,
  count: number
): { selection: RecordedSelection; action: VisualRepeatAction } {
  const { startRow, endRow } = visualLineBounds(editor, state);
  return {
    selection: { type: "visualLine", rows: Math.max(0, endRow - startRow) },
    action: { type: "indent", direction, count },
  };
}

function visualSurroundRanges(editor: VimEditorCapabilities, state: VisualState): readonly TextRange[] {
  return visualConvertRanges(editor, state);
}

// Zed: the visual fold-in — visual state lowers to an `OperatorTarget` so
// normal and visual mode apply operators through the same `apply*` modules.
function visualCharwiseTarget(editor: VimEditorCapabilities, state: CharwiseVisualState): ResolvedTarget {
  return {
    kind: "charwise",
    targets: currentCharwiseVisualRanges(editor, state).map(range => ({ range, head: range.start })),
  };
}

function visualLinewiseTarget(
  state: LinewiseVisualState,
  { column, cursor }: { column: number; cursor?: Position }
): ResolvedTarget {
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
    case "blockwise":
      return blockRanges(editor, state);
  }
}

// Per-line, single-row ranges covering the selection, for `v_r` (replace every
// selected character). Unlike [visualConvertRanges] (whose linewise/charwise
// cases can return a multi-line range), every range here stays within one line,
// so replacing its text with a repeated char preserves the line breaks between
// them.
// The number of grapheme cells between two columns of [line]: `v_r` writes
// one replacement character per selected cell, not per UTF-16 unit (an emoji
// becomes one `x`, not two).
function graphemeCellCount(line: string, startColumn: number, endColumn: number): number {
  let cells = 0;
  let column = startColumn;
  while (column < endColumn) {
    const next = nextGraphemeBoundary(line, column);
    if (next <= column) break;
    column = next;
    cells++;
  }
  return cells;
}

function replaceRanges(editor: VimEditorCapabilities, state: VisualState): readonly TextRange[] {
  switch (state.kind) {
    case "charwise":
      return currentCharwiseVisualRanges(editor, state).flatMap(range => splitRangeByLine(editor, range));
    case "linewise": {
      const { startLine, endLine } = lineBounds(state);
      const ranges: TextRange[] = [];
      for (let row = startLine; row <= endLine; row++) {
        ranges.push({ start: { row, column: 0 }, end: { row, column: editor.lineLength(row) } });
      }
      return ranges;
    }
    case "blockwise":
      return blockRanges(editor, state);
  }
}

function splitRangeByLine(editor: VimEditorCapabilities, range: TextRange): readonly TextRange[] {
  if (range.start.row === range.end.row) return [range];
  const ranges: TextRange[] = [
    { start: range.start, end: { row: range.start.row, column: editor.lineLength(range.start.row) } },
  ];
  for (let row = range.start.row + 1; row < range.end.row; row++) {
    ranges.push({ start: { row, column: 0 }, end: { row, column: editor.lineLength(row) } });
  }
  ranges.push({ start: { row: range.end.row, column: 0 }, end: range.end });
  return ranges;
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

// The visual edits run as one undo unit anchored on the visual selection.
//
// Commands that finish editing before returning must go through
// [withUndoTransaction]/[withVisualUndoTransaction] so the transaction is
// finished with the command: a transaction left open makes every later edit
// coalesce into the same undo unit. Only commands that enter insert mode may
// call [beginVisualUndoTransaction] directly and leave the transaction open;
// it is finished when Escape leaves insert/replace mode (see
// [keepUndoTransactionOpen]).
function beginVisualUndoTransaction(editor: VimEditorCapabilities, state: VisualState): VimUndoTransaction {
  return editor.beginUndoTransaction(visualUndoSelections(state));
}

function withUndoTransaction<T>(
  editor: VimEditorCapabilities,
  selectionsBefore: readonly VimSelection[],
  run: () => T
): T {
  const undoTransaction = editor.beginUndoTransaction(selectionsBefore);
  try {
    return run();
  } finally {
    undoTransaction.finish();
  }
}

function withVisualUndoTransaction<T>(editor: VimEditorCapabilities, state: VisualState, run: () => T): T {
  return withUndoTransaction(editor, visualUndoSelections(state), run);
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

function openVisualChangeEditOptions() {
  return keepUndoTransactionOpen();
}

function recordVisualPasteDelete(
  registers: Registers,
  text: string,
  kind: RegisterPart["kind"],
  parts: readonly RegisterPart[] | undefined,
  { preserveSourceRegister }: { preserveSourceRegister: boolean }
): void {
  if (parts === undefined ? text.length === 0 : parts.every(part => part.text.length === 0)) return;
  if (preserveSourceRegister) registers.writeDeleteHistory(text, kind, parts);
  else registers.writeDelete(undefined, text, kind, parts);
}

function pasteOverCharwise(
  editor: VimEditorCapabilities,
  registers: Registers,
  state: CharwiseVisualState,
  content: RegisterContent,
  { preserveSourceRegister }: { preserveSourceRegister: boolean }
): VisualState | undefined {
  const ranges = currentCharwiseVisualRanges(editor, state);
  const distributed = distributedRegisterParts(content, ranges.length);
  if (distributed !== undefined) {
    return pasteDistributedOverCharwise(editor, registers, state, ranges, distributed, { preserveSourceRegister });
  }

  const range = charwiseVisualRange(editor, state);
  const deletedText = rangeText(editor, range);
  if (content.kind === "blockwise") {
    pasteBlockwiseOverCharwise(editor, registers, state, range, deletedText, content.text, { preserveSourceRegister });
    return undefined;
  }

  const replacement = replacementForRegisterPart(content);
  const pastedRange = { start: range.start, end: positionAfterInsertedText(range.start, replacement.text) };

  withVisualUndoTransaction(editor, state, () =>
    editor.applyEdits([{ range, text: replacement.text }], [charwiseSelection(cursorAfterReplacement(range.start, replacement))]));
  recordVisualPasteDelete(registers, deletedText, "characterwise", undefined, { preserveSourceRegister });
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
  parts: readonly RegisterPart[],
  { preserveSourceRegister }: { preserveSourceRegister: boolean }
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
  withUndoTransaction(editor, currentCharwiseVisualUndoSelections(editor, state), () =>
    editor.applyEdits(edits, selectionsAfter));
  recordVisualPasteDelete(
    registers,
    deleted.join("\n"),
    "characterwise",
    deleted.map(text => ({ text, kind: "characterwise" })),
    { preserveSourceRegister }
  );
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
  text: string,
  { preserveSourceRegister }: { preserveSourceRegister: boolean }
): void {
  const blockLines = text.split("\n");
  const edits: TextEdit[] = [{ range, text: blockLines[0] ?? "" }];
  for (let index = 1; index < blockLines.length; index++) {
    const row = range.start.row + index;
    if (row >= editor.lineCount()) break;
    const insertAt = { row, column: Math.min(range.start.column, editor.lineLength(row)) };
    edits.push({ range: { start: insertAt, end: insertAt }, text: blockLines[index] });
  }
  withVisualUndoTransaction(editor, state, () =>
    editor.applyEdits(edits, [charwiseSelection({ row: range.start.row, column: range.start.column })]));
  recordVisualPasteDelete(registers, deletedText, "characterwise", undefined, { preserveSourceRegister });
}

function pasteOverLinewise(
  editor: VimEditorCapabilities,
  registers: Registers,
  state: LinewiseVisualState,
  content: RegisterContent,
  { preserveSourceRegister }: { preserveSourceRegister: boolean }
): void {
  const range = linewiseEditRange(editor, state);
  const replacementText = content.kind === "linewise"
    ? ensureTrailingNewline(content.text)
    : `${content.text}\n`;
  const { startLine } = lineBounds(state);

  const deletedText = linewiseText(editor, state);
  withVisualUndoTransaction(editor, state, () =>
    editor.applyEdits([{ range, text: replacementText }], [charwiseSelection({ row: startLine, column: 0 })]));
  recordVisualPasteDelete(registers, deletedText, "linewise", undefined, { preserveSourceRegister });
}

function pasteOverBlockwise(
  editor: VimEditorCapabilities,
  registers: Registers,
  state: BlockwiseVisualState,
  content: RegisterContent,
  { preserveSourceRegister }: { preserveSourceRegister: boolean }
): void {
  const blockLines = content.text.split("\n");
  if (blockLines.length === 0) return;

  const { startRow, endRow, startColumn } = blockBounds(state);
  const edits: TextEdit[] = [];
  const deleted: string[] = [];

  for (let row = startRow; row <= endRow; row++) {
    const blockLine = content.kind === "blockwise"
      ? blockLines[row - startRow] ?? ""
      : blockLines[0];
    const range = blockRangeForRow(editor, state, row);
    deleted.push(rangeText(editor, range));
    edits.push({ range, text: blockLine });
  }

  withVisualUndoTransaction(editor, state, () =>
    editor.applyEdits(edits, [charwiseSelection({ row: startRow, column: startColumn + blockLines[0].length - 1 })]));
  recordVisualPasteDelete(
    registers,
    deleted.join("\n"),
    "blockwise",
    deleted.map(text => ({ text, kind: "blockwise" })),
    { preserveSourceRegister }
  );
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

  const selectionsAfter = collapse
    ? [charwiseSelection({ row: startRow, column: startColumn })]
    : blockInsertSelections(editor, state, { side: "start" });
  const undoTransaction = beginVisualUndoTransaction(editor, state);
  editor.applyEdits(
    edits,
    selectionsAfter,
    collapse ? {} : openVisualChangeEditOptions()
  );
  if (deleted.some(text => text.length > 0)) {
    registers.writeDelete(
      registerName,
      deleted.join("\n"),
      "blockwise",
      deleted.map(text => ({ text, kind: "blockwise" }))
    );
  }
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
    const line = editor.line(row);
    const column = side === "start"
      ? blockStartColumnForLine(line, startColumn)
      : state.goal?.type === "endOfLine" ? line.length : blockEndColumnForLine(line, endColumn);
    selections.push(charwiseSelection({ row, column }));
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
  const line = editor.line(row);
  const start = blockStartColumnForLine(line, startColumn);
  const end = state.goal?.type === "endOfLine" ? line.length : blockEndColumnForLine(line, endColumn);
  return {
    start: { row, column: start },
    end: { row, column: Math.max(start, end) },
  };
}

// Cluster-snapped block geometry: block cell columns are UTF-16 unit columns
// taken from the anchor/head rows, so on another row they can land inside a
// grapheme cluster (an emoji is one cell but several units). The block covers
// whole clusters — an edit must never split a surrogate pair or strip a
// combining mark.
function blockStartColumnForLine(line: string, startColumn: number): number {
  return graphemeStart(line, Math.min(startColumn, line.length));
}

// The end of the cluster containing the block's last cell column (exclusive).
function blockEndColumnForLine(line: string, endColumn: number): number {
  if (endColumn >= line.length) return line.length;
  return nextGraphemeBoundary(line, graphemeStart(line, endColumn));
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
  // The cursor lands on the last pasted character *cell* (cluster start).
  if (lines.length === 1) {
    return { row: after.row, column: Math.max(start.column, start.column + previousGraphemeBoundary(text, text.length)) };
  }
  const lastLine = lines[lines.length - 1];
  return { row: after.row, column: lastLine.length === 0 ? 0 : previousGraphemeBoundary(lastLine, lastLine.length) };
}
