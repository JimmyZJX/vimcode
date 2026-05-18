// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `visual` module
// - translated concepts: visual-mode state, visual motion extension, visual-line and
//   visual-block lowering, and visual delete/yank/change/paste operations
// - intentional differences: this is still a model-buffer subset. Zed lowers visual
//   block mode through editor selections over a display map (`visual_block_motion`);
//   here we keep a compact semantic block state and lower to model edits/selections.

import { VimEditorCapabilities, normalCursorPosition, rangeText } from "./editor.js";
import { positionAfterInsertedText } from "./insert.js";
import { applyMotionWithGoal, hostViewLineSelectionsForMotion, Motion, motionForKey } from "./motion.js";
import { textObjectForKey, textObjectRange } from "./object.js";
import { cursorAfterDeletingRange, deleteRange } from "./normal/delete.js";
import { RegisterContent, RegisterName, Registers, parseRegisterName } from "./registers.js";
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
  selectionHead,
} from "./state.js";

export type VisualResultMode = "normal" | "insert" | "visual" | "visualLine" | "visualBlock";
export type RestoredVisualMode = "visual" | "visualLine" | "visualBlock";

export type VisualKeyResult = {
  keyResult: KeyResult;
  exitVisual: boolean;
  enterInsert: boolean;
  nextMode?: VisualResultMode;
};

type CharwiseVisualState = {
  kind: "charwise";
  anchor: Position;
  head: Position; // Vim cursor position; inclusive.
  goal?: VimSelectionGoal;
};

type LinewiseVisualState = {
  kind: "linewise";
  anchorLine: number;
  headLine: number;
  headColumn: number;
};

type BlockwiseVisualState = {
  kind: "blockwise";
  anchor: Position;
  head: Position;
  goal?: VimSelectionGoal;
};

type VisualState = CharwiseVisualState | LinewiseVisualState | BlockwiseVisualState;
type PendingTextObject = { around: boolean };
function handled(
  {
    exitVisual = false,
    enterInsert = false,
    nextMode,
  }: { exitVisual?: boolean; enterInsert?: boolean; nextMode?: VisualResultMode } = {}
): VisualKeyResult {
  return { keyResult: "handled", exitVisual, enterInsert, nextMode };
}

export class VisualMode {
  private state: VisualState | undefined;
  private lastState: VisualState | undefined;
  private pendingTextObject: PendingTextObject | undefined;
  private pendingSurround: { ranges: readonly TextRange[]; linewise: boolean } | undefined;
  private pendingRegister = false;
  private pendingPrefix: "g" | undefined;
  private selectedRegister: RegisterName | undefined;
  private countBuffer = "";

  constructor(
    private readonly editor: VimEditorCapabilities,
    private readonly registers: Registers
  ) {}

  enter(kind: VisualState["kind"] = "charwise"): void {
    const selection = this.editor.getSelections()[0];
    const head = selectionHead(selection);
    this.pendingTextObject = undefined;
    this.pendingSurround = undefined;
    this.pendingRegister = false;
    this.pendingPrefix = undefined;
    this.selectedRegister = undefined;
    this.countBuffer = "";
    switch (kind) {
      case "charwise":
        this.state = { kind, anchor: head, head: initialCharwiseHead(this.editor, head) };
        break;
      case "linewise":
        this.state = { kind, anchorLine: head.row, headLine: head.row, headColumn: head.column };
        break;
      case "blockwise":
        this.state = { kind, anchor: head, head };
        break;
    }
    this.editor.setCursorStyle("line");
    this.syncEditorSelection();
  }

  adoptSelection(selection: VimSelection, { render }: { render: boolean }): boolean {
    if (selection.type !== "charwise") return false;
    if (comparePositions(selection.anchor, selection.head) === 0) return false;
    this.pendingTextObject = undefined;
    this.pendingSurround = undefined;
    this.pendingRegister = false;
    this.pendingPrefix = undefined;
    this.selectedRegister = undefined;
    this.countBuffer = "";
    this.state = externalSelectionToCharwiseState(this.editor, selection);
    this.editor.setCursorStyle("line");
    if (render) this.syncEditorSelection();
    return true;
  }

  clearState(): void {
    this.state = undefined;
    this.pendingTextObject = undefined;
    this.pendingSurround = undefined;
    this.pendingRegister = false;
    this.pendingPrefix = undefined;
    this.selectedRegister = undefined;
    this.countBuffer = "";
  }

  exit(): void {
    const state = this.state;
    if (state !== undefined) this.rememberState(state);
    this.state = undefined;
    this.pendingTextObject = undefined;
    this.pendingSurround = undefined;
    this.pendingRegister = false;
    this.pendingPrefix = undefined;
    this.selectedRegister = undefined;
    this.countBuffer = "";
    this.editor.setCursorStyle("block");
    if (state === undefined) {
      this.editor.setSelections(this.editor.getSelections().map(selection => charwiseSelection(selectionHead(selection))));
    } else {
      this.editor.setSelections([charwiseSelection(visualExitPosition(this.editor, state))]);
    }
  }

  onKey(key: string): VisualKeyResult {
    if (this.pendingRegister) {
      this.pendingRegister = false;
      const registerName = parseRegisterName(key);
      if (registerName !== undefined) this.selectedRegister = registerName;
      return handled();
    }

    if (this.pendingSurround !== undefined) {
      const pending = this.pendingSurround;
      this.pendingSurround = undefined;
      addSurrounds(this.editor, pending.ranges, key, { linewise: pending.linewise });
      this.state = undefined;
      this.editor.setCursorStyle("block");
      return handled({ exitVisual: true, nextMode: "normal" });
    }

    if (this.pendingTextObject !== undefined) {
      return this.handlePendingTextObject(key);
    }

    const state = this.state;
    if (state === undefined) {
      return handled({ exitVisual: true });
    }

    if (isCountKey(key, this.countBuffer)) {
      this.countBuffer += key;
      return handled();
    }

    if (this.pendingPrefix === "g") {
      this.pendingPrefix = undefined;
      if (key === "j" || key === "k") {
        this.applyVisualMotion(state, { type: key === "j" ? "down" : "up" }, this.takeCount(1), { displayLine: true });
        return handled({ nextMode: "visual" });
      }
      this.exit();
      return handled({ exitVisual: true, nextMode: "normal" });
    }

    if (key === "g") {
      this.pendingPrefix = "g";
      return handled();
    }

    if (key === '"') {
      this.pendingRegister = true;
      return handled();
    }

    if (key === "v") {
      if (state.kind === "charwise") {
        this.exit();
        return handled({ exitVisual: true, nextMode: "normal" });
      }
      this.state = stateToCharwise(this.editor, state);
      this.syncEditorSelection();
      return handled({ nextMode: "visual" });
    }

    if (key === "V") {
      if (state.kind === "linewise") {
        this.exit();
        return handled({ exitVisual: true, nextMode: "normal" });
      }
      this.state = stateToLinewise(state);
      this.syncEditorSelection();
      return handled({ nextMode: "visualLine" });
    }

    if (key === "ctrl-v") {
      if (state.kind === "blockwise") {
        this.exit();
        return handled({ exitVisual: true, nextMode: "normal" });
      }
      this.state = stateToBlockwise(state);
      this.syncEditorSelection();
      return handled({ nextMode: "visualBlock" });
    }

    if (state.kind === "blockwise" && (key === "I" || key === "A")) {
      this.rememberState(state);
      enterBlockInsert(this.editor, this.registers, undefined, state, {
        deleteSelection: false,
        side: key === "I" ? "start" : "end",
      });
      this.state = undefined;
      this.editor.setCursorStyle("line");
      return handled({ exitVisual: true, enterInsert: true });
    }

    if (key === "S") {
      this.rememberState(state);
      substituteLineForState(this.editor, this.registers, this.takeSelectedRegister(), state);
      this.state = undefined;
      this.editor.setCursorStyle("line");
      return handled({ exitVisual: true, enterInsert: true, nextMode: "insert" });
    }

    if (key === "i" || key === "a") {
      this.pendingTextObject = { around: key === "a" };
      return handled();
    }

    if (key === "o" || key === "O") {
      this.state = otherEndState(state, { rowAware: key === "o" });
      this.syncEditorSelection();
      return handled();
    }

    if (key === "y" || key === "Y") {
      this.yank(state, this.takeSelectedRegister());
      this.finishNormalAt(visualStartPosition(state));
      return handled({ exitVisual: true, nextMode: "normal" });
    }

    if (key === "d" || key === "x") {
      this.rememberState(state);
      this.delete(state, this.takeSelectedRegister());
      this.state = undefined;
      this.editor.setCursorStyle("block");
      return handled({ exitVisual: true, nextMode: "normal" });
    }

    if (key === "c" || key === "s") {
      this.rememberState(state);
      this.change(state, this.takeSelectedRegister());
      this.state = undefined;
      this.editor.setCursorStyle("line");
      return handled({ exitVisual: true, enterInsert: true, nextMode: "insert" });
    }

    if (key === "p" || key === "P") {
      this.rememberState(state);
      this.paste(state, this.takeSelectedRegister());
      this.state = undefined;
      this.editor.setCursorStyle("block");
      return handled({ exitVisual: true, nextMode: "normal" });
    }

    const motion = visualMotionForKey(key);
    if (motion !== undefined) {
      this.applyVisualMotion(state, motion, this.takeCount(1), { displayLine: false });
      return handled();
    }

    this.exit();
    return handled({ exitVisual: true, nextMode: "normal" });
  }

  private handlePendingTextObject(key: string): VisualKeyResult {
    const pendingTextObject = this.pendingTextObject;
    this.pendingTextObject = undefined;
    const state = this.state;
    const object = textObjectForKey(key);
    if (pendingTextObject === undefined || state === undefined || object === undefined) {
      this.exit();
      return handled({ exitVisual: true, nextMode: "normal" });
    }

    if (state.kind !== "charwise") {
      this.syncEditorSelection();
      return handled();
    }

    if (object.type !== "paragraph" && this.editor.lineLength(state.anchor.row) === 0) {
      this.syncEditorSelection();
      return handled();
    }

    const range = textObjectRange(this.editor, visualObjectHead(this.editor, state), object, { around: pendingTextObject.around, count: this.takeCount(1) });
    if (object.type === "paragraph") {
      this.state = paragraphLinewiseStateForRange(this.editor, range);
      this.syncEditorSelection();
      return handled({ nextMode: "visualLine" });
    }
    this.state = charwiseStateForRange(this.editor, range);
    this.syncEditorSelection();
    return handled();
  }

  private yank(state: VisualState, registerName: RegisterName | undefined): void {
    switch (state.kind) {
      case "charwise":
        this.registers.writeYank(registerName, rangeText(this.editor, charwiseVisualRange(this.editor, state)), "characterwise");
        break;
      case "linewise":
        this.registers.writeYank(registerName, linewiseText(this.editor, state), "linewise");
        break;
      case "blockwise":
        this.registers.writeYank(registerName, blockwiseText(this.editor, state), "blockwise");
        break;
    }
  }

  private delete(state: VisualState, registerName: RegisterName | undefined): void {
    switch (state.kind) {
      case "charwise":
        deleteRange(
          this.editor,
          this.registers,
          registerName,
          () => charwiseVisualRange(this.editor, state),
          cursorAfterDeletingRange,
          { selectionsBefore: visualUndoSelections(state) }
        );
        break;
      case "linewise":
        deleteLinewise(this.editor, this.registers, registerName, state);
        break;
      case "blockwise":
        deleteBlockwise(this.editor, this.registers, registerName, state, { collapse: true });
        break;
    }
  }

  private change(state: VisualState, registerName: RegisterName | undefined): void {
    switch (state.kind) {
      case "charwise":
        deleteRange(
          this.editor,
          this.registers,
          registerName,
          () => charwiseVisualRange(this.editor, state),
          (_editor, range) => range.start,
          { selectionsBefore: visualUndoSelections(state) }
        );
        break;
      case "linewise":
        changeLinewise(this.editor, this.registers, registerName, state);
        break;
      case "blockwise":
        enterBlockInsert(this.editor, this.registers, registerName, state, { deleteSelection: true, side: "start" });
        break;
    }
  }

  private paste(state: VisualState, registerName: RegisterName | undefined): void {
    const content = this.registers.readContent(registerName);
    if (content.text.length === 0) return;

    switch (state.kind) {
      case "charwise":
        pasteOverCharwise(this.editor, this.registers, state, content);
        break;
      case "linewise":
        pasteOverLinewise(this.editor, this.registers, state, content);
        break;
      case "blockwise":
        pasteOverBlockwise(this.editor, this.registers, state, content);
        break;
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
    }

    this.state = stateAfterMotion(this.editor, state, motion, count);
    this.syncEditorSelection();
  }

  private syncEditorSelection(): void {
    if (this.state === undefined) return;
    this.editor.setSelections([visualStateToEditorSelection(this.editor, this.state)]);
  }

  adoptSelectionFromHost(): void {
    const selection = this.editor.getSelections()[0];
    if (selection?.type === "charwise") this.adoptSelection(selection, { render: false });
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

  private finishNormalAt(position: Position): void {
    if (this.state !== undefined) this.rememberState(this.state);
    this.state = undefined;
    this.pendingTextObject = undefined;
    this.pendingSurround = undefined;
    this.pendingRegister = false;
    this.pendingPrefix = undefined;
    this.selectedRegister = undefined;
    this.countBuffer = "";
    this.editor.setCursorStyle("block");
    this.editor.setSelections([charwiseSelection(position)]);
  }

  private takeSelectedRegister(): RegisterName | undefined {
    const registerName = this.selectedRegister;
    this.selectedRegister = undefined;
    return registerName;
  }

  private clearPendingInteraction(): void {
    this.pendingTextObject = undefined;
    this.pendingSurround = undefined;
    this.pendingRegister = false;
    this.pendingPrefix = undefined;
    this.selectedRegister = undefined;
    this.countBuffer = "";
  }

  private rememberState(state: VisualState): void {
    this.lastState = cloneVisualState(state);
  }

  applyMotion(motion: Motion, count: number): void {
    if (this.state === undefined) return;
    this.applyVisualMotion(this.state, motion, count, { displayLine: (motion.type === "up" || motion.type === "down") && motion.displayLine === true });
  }

  takeCountForMotion(defaultValue: number): number {
    return this.takeCount(defaultValue);
  }

  isExpectingRegisterName(): boolean {
    return this.pendingRegister;
  }

  private takeCount(defaultValue: number): number {
    if (this.countBuffer.length === 0) return defaultValue;
    const count = Number(this.countBuffer);
    this.countBuffer = "";
    return count;
  }
}

function isCountKey(key: string, countBuffer: string): boolean {
  if (!/^\d$/.test(key)) return false;
  return key !== "0" || countBuffer.length > 0;
}

function externalSelectionToCharwiseState(editor: VimEditorCapabilities, selection: Extract<VimSelection, { type: "charwise" }>): CharwiseVisualState {
  if (comparePositions(selection.anchor, selection.head) <= 0) {
    return {
      kind: "charwise",
      anchor: selection.anchor,
      head: previousVisualPosition(editor, selection.head),
      goal: selection.goal,
    };
  }
  return {
    kind: "charwise",
    anchor: previousVisualPosition(editor, selection.anchor),
    head: selection.head,
    goal: selection.goal,
  };
}

function previousVisualPosition(editor: VimEditorCapabilities, position: Position): Position {
  if (position.column > 0) return { row: position.row, column: position.column - 1 };
  if (position.row > 0) return { row: position.row - 1, column: Math.max(0, editor.lineLength(position.row - 1) - 1) };
  return position;
}

function initialCharwiseHead(editor: VimEditorCapabilities, head: Position): Position {
  if (editor.lineLength(head.row) === 0 && head.row + 1 < editor.lineCount()) {
    return { row: head.row + 1, column: 0 };
  }
  return head;
}

function visualObjectHead(editor: VimEditorCapabilities, state: CharwiseVisualState): Position {
  if (isForwardCharwiseVisualState(state)
    && editor.lineLength(state.anchor.row) === 0
    && state.head.row === state.anchor.row + 1
    && state.head.column === 0) {
    return state.anchor;
  }
  return state.head;
}

function visualMotionForKey(key: string): Motion | undefined {
  if (key === "G") return { type: "endOfDocument" };
  return motionForKey(key);
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
    return { ...state, head, goal: undefined };
  }
  if (motion.type === "endOfLine") {
    const head = { row: state.head.row, column: editor.lineLength(state.head.row) };
    return { ...state, head, goal: { type: "endOfLine" } };
  }
  const result = applyMotionWithGoal(editor, state.head, motion, 1, state.goal);
  const head = adjustCharwiseMotionHead(editor, state.head, result.position, motion);
  return {
    ...state,
    head,
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
      return { ...state, headLine: Math.max(0, state.headLine - 1) };
    case "down":
      return { ...state, headLine: Math.min(editor.lineCount() - 1, state.headLine + 1) };
    case "endOfDocument":
      return { ...state, headLine: editor.lineCount() - 1 };
    case "endOfLine":
      return { ...state, headColumn: editor.lineLength(state.headLine) };
    default: {
      const { position } = applyMotionWithGoal(editor, linewiseCursor(editor, state), motion, 1);
      return { ...state, headLine: position.row, headColumn: position.column };
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
  return { ...state, head: position, goal };
}

function adjustCharwiseMotionHead(
  editor: VimEditorCapabilities,
  previousHead: Position,
  rawHead: Position,
  motion: Motion
): Position {
  if (motion.type === "nextWordStart" && rawHead.row === previousHead.row && rawHead.column > previousHead.column) {
    const line = editor.line(rawHead.row);
    if (rawHead.column > 0 && /\s/.test(line[rawHead.column - 1])) {
      return { row: rawHead.row, column: rawHead.column - 1 };
    }
  }
  return rawHead;
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
      return { kind: "linewise", anchorLine: state.anchor.row, headLine: state.head.row, headColumn: state.head.column };
    case "blockwise":
      return { kind: "linewise", anchorLine: state.anchor.row, headLine: state.head.row, headColumn: state.head.column };
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
      return { ...state, anchorLine: state.headLine, headLine: state.anchorLine };
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
      return { ...state };
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
        headLine: state.headLine,
        cursor: linewiseCursor(editor, state),
      };
    case "blockwise":
      return { type: "blockwise", anchor: state.anchor, head: state.head, cursor: state.head, goal: state.goal };
  }
}

function charwiseStateToEditorSelection(editor: VimEditorCapabilities, state: CharwiseVisualState): VimSelection {
  if (isForwardCharwiseVisualState(state)) {
    return {
      type: "charwise",
      anchor: state.anchor,
      head: exclusiveVisualHead(editor, state.head),
      cursor: state.head,
      goal: state.goal,
    };
  }

  return {
    type: "charwise",
    anchor: exclusiveVisualHead(editor, state.anchor),
    head: state.head,
    cursor: state.head,
    goal: state.goal,
  };
}

function charwiseVisualRange(editor: VimEditorCapabilities, state: CharwiseVisualState): TextRange {
  if (isForwardCharwiseVisualState(state)) {
    return {
      start: state.anchor,
      end: exclusiveVisualHead(editor, state.head),
    };
  }

  return {
    start: state.head,
    end: exclusiveVisualHead(editor, state.anchor),
  };
}

function isForwardCharwiseVisualState(state: CharwiseVisualState): boolean {
  return comparePositions(state.anchor, state.head) <= 0;
}

function exclusiveVisualHead(editor: VimEditorCapabilities, head: Position): Position {
  const lineLength = editor.lineLength(head.row);
  if (lineLength === 0) return head;
  if (head.column < lineLength) return { row: head.row, column: head.column + 1 };
  if (head.row + 1 < editor.lineCount()) return { row: head.row + 1, column: 0 };
  return head;
}

function charwiseStateForRange(editor: VimEditorCapabilities, range: TextRange): CharwiseVisualState {
  return {
    kind: "charwise",
    anchor: range.start,
    head: inclusiveHeadForRangeEnd(editor, range),
  };
}

function paragraphLinewiseStateForRange(editor: VimEditorCapabilities, range: TextRange): LinewiseVisualState {
  const endLineLength = editor.lineLength(range.end.row);
  return {
    kind: "linewise",
    anchorLine: range.start.row,
    headLine: range.end.row,
    headColumn: range.start.row === range.end.row || endLineLength === 0 ? 0 : 1,
  };
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

function substituteLineForState(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  state: VisualState
): void {
  switch (state.kind) {
    case "charwise": {
      const range = charwiseVisualRange(editor, state);
      const lineState: LinewiseVisualState = {
        kind: "linewise",
        anchorLine: range.start.row,
        headLine: range.end.column === 0 && range.end.row > range.start.row ? range.end.row - 1 : range.end.row,
        headColumn: range.start.column,
      };
      changeLinewise(editor, registers, registerName, lineState);
      return;
    }
    case "linewise":
      changeLinewise(editor, registers, registerName, state);
      return;
    case "blockwise": {
      const { startRow, endRow } = blockBounds(state);
      changeLinewise(editor, registers, registerName, {
        kind: "linewise",
        anchorLine: startRow,
        headLine: endRow,
        headColumn: 0,
      });
      return;
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
  const row = state.headLine;
  if (editor.lineLength(row) === 0 && row + 1 < editor.lineCount()) return { row: row + 1, column: 0 };
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

function deleteLinewise(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  state: LinewiseVisualState
): void {
  const { startLine } = lineBounds(state);
  const deletedLineCount = Math.abs(state.headLine - state.anchorLine) + 1;
  registers.writeDelete(registerName, linewiseText(editor, state), "linewise");
  editor.applyEdits(
    [{ range: linewiseEditRange(editor, state), text: "" }],
    [charwiseSelection(linewiseCursorAfterDelete(editor, startLine, state.headColumn, deletedLineCount))],
    { selectionsBefore: visualUndoSelections(state) }
  );
}

function changeLinewise(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  state: LinewiseVisualState
): void {
  const { startLine } = lineBounds(state);
  registers.writeDelete(registerName, linewiseText(editor, state), "linewise");
  editor.applyEdits(
    [{ range: linewiseEditRange(editor, state), text: "\n" }],
    [charwiseSelection({ row: startLine, column: 0 })],
    { selectionsBefore: visualUndoSelections(state) }
  );
}

function linewiseCursorAfterDelete(
  editor: VimEditorCapabilities,
  startLine: number,
  column: number,
  deletedLineCount: number
): Position {
  const lineCountBeforeDelete = editor.lineCount();
  const deletingThroughLastLine = startLine + deletedLineCount >= lineCountBeforeDelete;
  const rowAfterDelete = deletingThroughLastLine && startLine > 0
    ? startLine - 1
    : Math.min(startLine, Math.max(0, lineCountBeforeDelete - deletedLineCount));
  const targetLineLengthBeforeDelete = deletingThroughLastLine
    ? editor.lineLength(rowAfterDelete)
    : editor.lineLength(Math.min(startLine + deletedLineCount, lineCountBeforeDelete - 1));
  return { row: rowAfterDelete, column: Math.min(column, Math.max(0, targetLineLengthBeforeDelete - 1)) };
}

function pasteOverCharwise(
  editor: VimEditorCapabilities,
  registers: Registers,
  state: CharwiseVisualState,
  content: RegisterContent
): void {
  const range = charwiseVisualRange(editor, state);
  const deletedText = rangeText(editor, range);
  if (content.kind === "blockwise") {
    pasteBlockwiseOverCharwise(editor, registers, state, range, deletedText, content.text);
    return;
  }

  const replacementText = content.kind === "linewise" ? `\n${ensureTrailingNewline(content.text)}` : content.text;
  const cursor = content.kind === "linewise"
    ? { row: range.start.row + 1, column: 0 }
    : cursorAtEndOfInsertedText(range.start, replacementText);

  registers.write(undefined, deletedText, "characterwise");
  editor.applyEdits([{ range, text: replacementText }], [charwiseSelection(cursor)], { selectionsBefore: visualUndoSelections(state) });
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
  editor.applyEdits(edits, [charwiseSelection({ row: range.start.row, column: range.start.column })], { selectionsBefore: visualUndoSelections(state) });
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

  editor.applyEdits([{ range, text: replacementText }], [charwiseSelection({ row: startLine, column: 0 })], { selectionsBefore: visualUndoSelections(state) });
}

function pasteOverBlockwise(
  editor: VimEditorCapabilities,
  _registers: Registers,
  state: BlockwiseVisualState,
  content: RegisterContent
): void {
  const blockLines = content.text.split("\n");
  if (blockLines.length === 0) return;

  const { startRow, endRow, startColumn, endColumn } = blockBounds(state);
  const edits: TextEdit[] = [];

  for (let row = startRow; row <= endRow; row++) {
    const blockLine = content.kind === "blockwise"
      ? blockLines[row - startRow] ?? ""
      : blockLines[0];
    edits.push({
      range: {
        start: { row, column: Math.min(startColumn, editor.lineLength(row)) },
        end: { row, column: Math.min(endColumn + 1, editor.lineLength(row)) },
      },
      text: blockLine,
    });
  }

  editor.applyEdits(edits, [charwiseSelection({ row: startRow, column: startColumn + blockLines[0].length - 1 })], { selectionsBefore: visualUndoSelections(state) });
}

function deleteBlockwise(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  state: BlockwiseVisualState,
  { collapse }: { collapse: boolean }
): void {
  const { startRow, endRow, startColumn, endColumn } = blockBounds(state);
  const edits: TextEdit[] = [];
  const deleted: string[] = [];

  for (let row = startRow; row <= endRow; row++) {
    const range = {
      start: { row, column: Math.min(startColumn, editor.lineLength(row)) },
      end: { row, column: Math.min(endColumn + 1, editor.lineLength(row)) },
    };
    deleted.push(rangeText(editor, range));
    edits.push({ range, text: "" });
  }

  registers.writeDelete(registerName, deleted.join("\n"), "blockwise");
  const selectionsAfter = collapse
    ? [charwiseSelection({ row: startRow, column: startColumn })]
    : blockInsertSelections(editor, state, { side: "start" });
  editor.applyEdits(edits, selectionsAfter, { selectionsBefore: visualUndoSelections(state) });
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

function blockInsertSelections(
  editor: VimEditorCapabilities,
  state: BlockwiseVisualState,
  { side }: { side: "start" | "end" }
): VimSelection[] {
  const { startRow, endRow, startColumn, endColumn } = blockBounds(state);
  const column = side === "start" ? startColumn : endColumn + 1;
  const selections: VimSelection[] = [];
  for (let row = startRow; row <= endRow; row++) {
    selections.push(charwiseSelection({ row, column: Math.min(column, editor.lineLength(row)) }));
  }
  return selections;
}

function blockRanges(editor: VimEditorCapabilities, state: BlockwiseVisualState): TextRange[] {
  const { startRow, endRow, startColumn, endColumn } = blockBounds(state);
  const ranges: TextRange[] = [];
  for (let row = startRow; row <= endRow; row++) {
    ranges.push({
      start: { row, column: Math.min(startColumn, editor.lineLength(row)) },
      end: { row, column: Math.min(endColumn + 1, editor.lineLength(row)) },
    });
  }
  return ranges;
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
