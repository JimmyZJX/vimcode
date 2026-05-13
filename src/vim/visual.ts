// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `visual` module
// - translated concepts: visual-mode state, visual motion extension, visual-line and
//   visual-block lowering, and visual delete/yank/change/paste operations
// - intentional differences: this is still a model-buffer subset. Zed lowers visual
//   block mode through editor selections over a display map (`visual_block_motion`);
//   here we keep a compact semantic block state and lower to model edits/selections.

import { VimEditorCapabilities, rangeText } from "./editor.js";
import { positionAfterInsertedText } from "./insert.js";
import { applyMotionWithGoal, Motion, motionForKey } from "./motion.js";
import { textObjectForKey, textObjectRange } from "./object.js";
import { cursorAfterDeletingRange, deleteRange } from "./normal/delete.js";
import { RegisterContent, Registers } from "./registers.js";
import { addSurrounds } from "./surrounds.js";
import {
  KeyResult,
  Position,
  TextEdit,
  TextRange,
  VimSelection,
  charwiseSelection,
  comparePositions,
  selectionHead,
} from "./state.js";

type VisualResultMode = "normal" | "insert" | "visual" | "visualLine" | "visualBlock";

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
  goalColumn?: number;
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
  goalColumn?: number;
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
  private pendingTextObject: PendingTextObject | undefined;
  private pendingSurround: { ranges: readonly TextRange[]; linewise: boolean } | undefined;
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

  exit(): void {
    const state = this.state;
    this.state = undefined;
    this.pendingTextObject = undefined;
    this.pendingSurround = undefined;
    this.countBuffer = "";
    this.editor.setCursorStyle("block");
    if (state === undefined) {
      this.editor.setSelections(this.editor.getSelections().map(selection => charwiseSelection(selectionHead(selection))));
    } else {
      this.editor.setSelections([charwiseSelection(visualExitPosition(this.editor, state))]);
    }
  }

  onKey(key: string): VisualKeyResult {
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

        if (state.kind === "blockwise" && key === "I") {
      enterBlockInsert(this.editor, this.registers, state, { deleteSelection: false });
      this.state = undefined;
      this.editor.setCursorStyle("line");
      return handled({ exitVisual: true, enterInsert: true });
    }

    if (key === "S") {
      this.pendingSurround = surroundTargetForState(this.editor, state);
      return handled();
    }

    if (key === "i" || key === "a") {
      this.pendingTextObject = { around: key === "a" };
      return handled();
    }

    if (state.kind === "blockwise" && (key === "o" || key === "O")) {
      this.state = key === "o" ? flipBlockOtherEndRowAware(state) : flipBlockOtherEnd(state);
      this.syncEditorSelection();
      return handled();
    }

    if (key === "y" || key === "Y") {
      this.yank(state);
      this.finishNormalAt(visualStartPosition(state));
      return handled({ exitVisual: true, nextMode: "normal" });
    }

    if (key === "d" || key === "x") {
      this.delete(state);
      this.state = undefined;
      this.editor.setCursorStyle("block");
      return handled({ exitVisual: true, nextMode: "normal" });
    }

    if (key === "c" || key === "s") {
      this.change(state);
      this.state = undefined;
      this.editor.setCursorStyle("line");
      return handled({ exitVisual: true, enterInsert: true, nextMode: "insert" });
    }

    if (key === "p" || key === "P") {
      this.paste(state);
      this.state = undefined;
      this.editor.setCursorStyle("block");
      return handled({ exitVisual: true, nextMode: "normal" });
    }

    const motion = visualMotionForKey(key);
    if (motion !== undefined) {
      this.state = stateAfterMotion(this.editor, state, motion, this.takeCount(1));
      this.syncEditorSelection();
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

    if (this.editor.lineLength(state.anchor.row) === 0) {
      this.syncEditorSelection();
      return handled();
    }

    const range = textObjectRange(this.editor, state.head, object, { around: pendingTextObject.around });
    this.state = charwiseStateForRange(this.editor, range);
    this.syncEditorSelection();
    return handled();
  }

  private yank(state: VisualState): void {
    switch (state.kind) {
      case "charwise":
        this.registers.write(undefined, rangeText(this.editor, charwiseVisualRange(this.editor, state)), "characterwise");
        break;
      case "linewise":
        this.registers.write(undefined, linewiseText(this.editor, state), "linewise");
        break;
      case "blockwise":
        this.registers.write(undefined, blockwiseText(this.editor, state), "blockwise");
        break;
    }
  }

  private delete(state: VisualState): void {
    switch (state.kind) {
      case "charwise":
        deleteRange(
          this.editor,
          this.registers,
          undefined,
          () => charwiseVisualRange(this.editor, state),
          cursorAfterDeletingRange
        );
        break;
      case "linewise":
        deleteLinewise(this.editor, this.registers, state);
        break;
      case "blockwise":
        deleteBlockwise(this.editor, this.registers, state, { collapse: true });
        break;
    }
  }

  private change(state: VisualState): void {
    switch (state.kind) {
      case "charwise":
        deleteRange(
          this.editor,
          this.registers,
          undefined,
          () => charwiseVisualRange(this.editor, state),
          (_editor, range) => range.start
        );
        break;
      case "linewise":
        changeLinewise(this.editor, this.registers, state);
        break;
      case "blockwise":
        enterBlockInsert(this.editor, this.registers, state, { deleteSelection: true });
        break;
    }
  }

  private paste(state: VisualState): void {
    const content = this.registers.readContent(undefined);
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

  private syncEditorSelection(): void {
    if (this.state === undefined) return;
    this.editor.setSelections([visualStateToEditorSelection(this.editor, this.state)]);
  }

  private finishNormalAt(position: Position): void {
    this.state = undefined;
    this.pendingTextObject = undefined;
    this.pendingSurround = undefined;
    this.countBuffer = "";
    this.editor.setCursorStyle("block");
    this.editor.setSelections([charwiseSelection(position)]);
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

function initialCharwiseHead(editor: VimEditorCapabilities, head: Position): Position {
  if (editor.lineLength(head.row) === 0 && head.row + 1 < editor.lineCount()) {
    return { row: head.row + 1, column: 0 };
  }
  return head;
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
  const result = applyMotionWithGoal(editor, state.head, motion, 1, state.goalColumn);
  return {
    ...state,
    head: adjustCharwiseMotionHead(editor, state.head, result.position, motion),
    goalColumn: result.goalColumn ?? result.position.column,
  };
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
      return { ...state, headColumn: Math.max(0, editor.lineLength(state.headLine) - 1) };
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
  const { position, goalColumn } = applyMotionWithGoal(
    editor,
    state.head,
    motion,
    1,
    state.goalColumn,
    { allowEndOfLine: true }
  );
  return { ...state, head: position, goalColumn: goalColumn ?? position.column };
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

function flipBlockOtherEndRowAware(state: BlockwiseVisualState): BlockwiseVisualState {
  return { ...state, anchor: state.head, head: state.anchor, goalColumn: state.anchor.column };
}

function flipBlockOtherEnd(state: BlockwiseVisualState): BlockwiseVisualState {
  return {
    ...state,
    anchor: { row: state.anchor.row, column: state.head.column },
    head: { row: state.head.row, column: state.anchor.column },
    goalColumn: state.anchor.column,
  };
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
      return { type: "blockwise", anchor: state.anchor, head: state.head, cursor: state.head };
  }
}

function charwiseStateToEditorSelection(editor: VimEditorCapabilities, state: CharwiseVisualState): VimSelection {
  if (isForwardCharwiseVisualState(state)) {
    return {
      type: "charwise",
      anchor: state.anchor,
      head: exclusiveVisualHead(editor, state.head),
      cursor: state.head,
    };
  }

  return {
    type: "charwise",
    anchor: exclusiveVisualHead(editor, state.anchor),
    head: state.head,
    cursor: state.head,
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
  return { row: head.row, column: Math.min(head.column + 1, lineLength) };
}

function charwiseStateForRange(editor: VimEditorCapabilities, range: TextRange): CharwiseVisualState {
  return {
    kind: "charwise",
    anchor: range.start,
    head: inclusiveHeadForRangeEnd(editor, range),
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

function surroundTargetForState(editor: VimEditorCapabilities, state: VisualState): { ranges: readonly TextRange[]; linewise: boolean } {
  switch (state.kind) {
    case "charwise":
      return { ranges: [charwiseVisualRange(editor, state)], linewise: false };
    case "linewise":
      return { ranges: [linewiseEditRange(editor, state)], linewise: true };
    case "blockwise":
      return { ranges: blockRanges(editor, state), linewise: false };
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
      return state.head;
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
  state: LinewiseVisualState
): void {
  const { startLine } = lineBounds(state);
  const deletedLineCount = Math.abs(state.headLine - state.anchorLine) + 1;
  registers.write(undefined, linewiseText(editor, state), "linewise");
  editor.applyEdits(
    [{ range: linewiseEditRange(editor, state), text: "" }],
    [charwiseSelection(linewiseCursorAfterDelete(editor, startLine, state.headColumn, deletedLineCount))]
  );
}

function changeLinewise(
  editor: VimEditorCapabilities,
  registers: Registers,
  state: LinewiseVisualState
): void {
  const { startLine } = lineBounds(state);
  registers.write(undefined, linewiseText(editor, state), "linewise");
  editor.applyEdits(
    [{ range: linewiseEditRange(editor, state), text: "\n" }],
    [charwiseSelection({ row: startLine, column: 0 })]
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
    pasteBlockwiseOverCharwise(editor, registers, range, deletedText, content.text);
    return;
  }

  const replacementText = content.kind === "linewise" ? `\n${ensureTrailingNewline(content.text)}` : content.text;
  const cursor = content.kind === "linewise"
    ? { row: range.start.row + 1, column: 0 }
    : cursorAtEndOfInsertedText(range.start, replacementText);

  registers.write(undefined, deletedText, "characterwise");
  editor.applyEdits([{ range, text: replacementText }], [charwiseSelection(cursor)]);
}

function pasteBlockwiseOverCharwise(
  editor: VimEditorCapabilities,
  registers: Registers,
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

  editor.applyEdits(edits, [charwiseSelection({ row: startRow, column: startColumn + blockLines[0].length - 1 })]);
}

function deleteBlockwise(
  editor: VimEditorCapabilities,
  registers: Registers,
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

  registers.write(undefined, deleted.join("\n"), "blockwise");
  const selectionsAfter = collapse
    ? [charwiseSelection({ row: startRow, column: startColumn })]
    : blockInsertSelections(editor, state);
  editor.applyEdits(edits, selectionsAfter);
}

function enterBlockInsert(
  editor: VimEditorCapabilities,
  registers: Registers,
  state: BlockwiseVisualState,
  { deleteSelection }: { deleteSelection: boolean }
): void {
  if (deleteSelection) {
    deleteBlockwise(editor, registers, state, { collapse: false });
  } else {
    editor.setSelections(blockInsertSelections(editor, state));
  }
}

function blockInsertSelections(editor: VimEditorCapabilities, state: BlockwiseVisualState): VimSelection[] {
  const { startRow, endRow, startColumn } = blockBounds(state);
  const selections: VimSelection[] = [];
  for (let row = startRow; row <= endRow; row++) {
    selections.push(charwiseSelection({ row, column: Math.min(startColumn, editor.lineLength(row)) }));
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
