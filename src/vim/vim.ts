// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `vim::Vim`
// - translated concepts: main Vim state holder and high-level mode dispatch
// - intentional differences: GPUI action registration is replaced by direct key dispatch
//   from the VSCode patch / tests.

import { LineRange, executeCommand } from "./command.js";
import { VimEditorCapabilities, normalCursorPosition } from "./editor.js";
import { enterNormalMode, insertText } from "./insert.js";
import { FindMotion, Motion, reverseFindMotion } from "./motion.js";
import { NormalMode } from "./normal.js";
import { MarkState } from "./normal/mark.js";
import { NormalChordAction, NormalChordResolver } from "./normal/chord.js";
import { MacroState, RepeatState } from "./normal/repeat.js";
import { handleHostAction } from "./normal/scroll.js";
import { SearchState, searchUnderCursorMotion } from "./normal/search.js";
import { RegisterName, Registers } from "./registers.js";
import { replaceModeText } from "./replace.js";
import { SharedAction, SharedActionResolver } from "./shared_action.js";
import { KeyResult, Operator, VimMode, charwiseSelection, comparePositions, rangeOfSelection, selectionHead } from "./state.js";
import { VisualMode } from "./visual.js";

type PendingFind =
  | { type: "forward"; before: boolean; count: number }
  | { type: "backward"; after: boolean; count: number };

type PendingUnmatched = { direction: "forward" | "backward"; count: number };

export type VimStatus = {
  mode: VimMode["kind"];
  pending: boolean;
  operator: Operator | undefined;
  chord: string;
  text: string;
};

// Zed: `vim::Vim`. This class is the local main state holder; GPUI
// entity/window fields are intentionally replaced by the injected
// `VimEditorCapabilities`.
export class Vim {
  private modeState: VimMode = { dialect: "vim", kind: "normal" };
  private readonly registers = new Registers();
  private pendingFind: PendingFind | undefined;
  private pendingUnmatched: PendingUnmatched | undefined;
  private lastFind: FindMotion | undefined;
  private readonly markState = new MarkState();
  private readonly sharedActionResolver = new SharedActionResolver();
  private readonly normalChordResolver = new NormalChordResolver();
  private readonly searchState = new SearchState();
  private readonly repeatState = new RepeatState();
  private readonly macroState = new MacroState();
  private pendingCommand: string | undefined;
  private replaceCount = 1;
  private insertOrigin: VimMode["kind"] | undefined;
  private readonly normalMode: NormalMode;
  private readonly visualMode: VisualMode;

  constructor(private readonly editor: VimEditorCapabilities) {
    this.editor.setCursorStyle("block");
    this.normalMode = new NormalMode(editor, this.registers);
    this.visualMode = new VisualMode(editor, this.registers);
  }

  get mode(): VimMode {
    return this.modeState;
  }

  get modeName(): string {
    const suffix = this.isPending() ? "+" : "";
    return `${this.modeState.dialect}:${this.modeState.kind}${suffix}`;
  }

  get status(): VimStatus {
    const chord = this.pendingChord();
    const mode = this.modeState.kind;
    return {
      mode,
      pending: this.isPending(),
      operator: this.modeState.kind === "normal" ? this.normalMode.pendingOperatorName() : undefined,
      chord,
      text: chord.length > 0 ? `${mode.toUpperCase()} ${chord}` : mode.toUpperCase(),
    };
  }

  readRegister(name: RegisterName | undefined): string {
    return this.registers.read(name);
  }

  syncFromEditorState({ render = true }: { render?: boolean } = {}): void {
    this.pendingFind = undefined;
    this.pendingUnmatched = undefined;
    this.sharedActionResolver.clearPending();
    this.normalChordResolver.clearPending();
    this.markState.clearPending();
    this.searchState.clearPending();
    this.pendingCommand = undefined;
    this.normalMode.clearPending();
    const selections = this.editor.getSelections();
    const visualSelection = selections.find(selection =>
      selection.type === "charwise" && comparePositions(selection.anchor, selection.head) !== 0);

    if (visualSelection !== undefined && this.visualMode.adoptSelection(visualSelection, { render })) {
      this.insertOrigin = undefined;
      this.modeState = { dialect: this.modeState.dialect, kind: "visual" };
      return;
    }

    if (this.isVisualMode()) {
      this.visualMode.clearState();
    }
    this.insertOrigin = undefined;
    if (render) this.editor.setCursorStyle("block");
    this.editor.setSelections(selections.map(selection => charwiseSelection(normalCursorPosition(this.editor, selectionHead(selection)))));
    this.modeState = { dialect: this.modeState.dialect, kind: "normal" };
  }

  private isPending(): boolean {
    return this.pendingFind !== undefined || this.pendingUnmatched !== undefined || this.sharedActionResolver.isPending() || this.normalChordResolver.isPending() || this.markState.isPending() || this.searchState.isPending() || this.pendingCommand !== undefined || (this.modeState.kind === "normal" && this.normalMode.isPending());
  }

  private pendingChord(): string {
    if (this.pendingCommand !== undefined) return `:${this.pendingCommand}`;
    if (this.searchState.isPending()) return this.searchState.pendingChord();
    if (this.markState.isPending()) return this.markState.pendingChord();
    if (this.sharedActionResolver.isPending()) return `${this.modeState.kind === "normal" ? this.normalMode.pendingChord() : ""}${this.sharedActionResolver.pendingChord()}`;
    if (this.normalChordResolver.isPending()) return this.normalChordResolver.pendingChord();
    if (this.pendingUnmatched !== undefined) return this.pendingUnmatched.direction === "forward" ? "]" : "[";
    if (this.pendingFind !== undefined) {
      const findKey = this.pendingFind.type === "forward"
        ? this.pendingFind.before ? "t" : "f"
        : this.pendingFind.after ? "T" : "F";
      return `${this.countPrefix()}${findKey}`;
    }
    return this.modeState.kind === "normal" ? this.normalMode.pendingChord() : "";
  }

  private countPrefix(): string {
    return "";
  }

  // Zed: key dispatch normally arrives through GPUI actions registered by
  // `vim::Vim::action` and key contexts from `vim::Vim::extend_key_context`.
  // The VSCode patch calls this direct key entry point instead.
  onKey(key: string): KeyResult {
    if (!this.repeatState.isReplaying()) this.repeatState.maybeFinish({ mode: this.modeState.kind, isPending: this.modeState.kind === "normal" && this.normalMode.isPending() });

    if (this.isEscape(key)) {
      if (!this.repeatState.isReplaying()) this.repeatState.recordKey(key);
      if (!this.macroState.isReplaying()) this.macroState.recordKey(key);
      this.pendingFind = undefined;
      this.searchState.clearPending();
      this.pendingCommand = undefined;
      this.normalMode.clearPending();
      if (
        this.modeState.kind === "visual"
        || this.modeState.kind === "visualLine"
        || this.modeState.kind === "visualBlock"
      ) {
        this.visualMode.exit();
        this.modeState = { dialect: this.modeState.dialect, kind: "normal" };
      } else if (this.modeState.kind !== "normal") {
        const modeBeforeEscape = this.modeState.kind;
        enterNormalMode(this.editor, { moveLeft: modeBeforeEscape === "insert" || modeBeforeEscape === "replace" });
        if (modeBeforeEscape === "insert" && this.insertOrigin === "visualBlock") {
          this.collapseToFirstCursor();
        }
        this.insertOrigin = undefined;
        this.modeState = { dialect: this.modeState.dialect, kind: "normal" };
      }
      return "handled";
    }

    if (this.modeState.kind === "normal" && this.macroState.wantsRecordRegister()) {
      this.macroState.handleRecordRegister(key);
      return "handled";
    }

    if (this.modeState.kind === "normal" && this.macroState.wantsReplayRegister()) {
      if (!this.macroState.isReplaying()) this.macroState.recordKey(key);
      this.macroState.replayRegisterKey(key, key => this.onKey(key));
      return "handled";
    }

    if (this.modeState.kind === "normal" && this.macroState.isRecording() && key === "q") {
      this.macroState.stopRecording();
      return "handled";
    }

    if (this.modeState.kind === "normal" && key === "q") {
      this.macroState.startRecordingPrefix();
      return "handled";
    }

    if (this.modeState.kind === "normal" && key === "@") {
      if (!this.macroState.isReplaying()) this.macroState.recordKey(key);
      this.macroState.startReplayPrefix(this.normalMode.takeCountForMotion(1));
      return "handled";
    }

    if (this.modeState.kind === "normal" && key === "Q") {
      if (!this.macroState.isReplaying()) this.macroState.recordKey(key);
      this.macroState.replayLast(this.normalMode.takeCountForMotion(1), key => this.onKey(key));
      return "handled";
    }

    if (!this.macroState.isReplaying()) this.macroState.recordKey(key);

    if (this.pendingCommand !== undefined) {
      this.handlePendingCommandKey(key);
      return "handled";
    }

    if (this.searchState.isPending()) {
      if (!this.repeatState.isReplaying()) this.repeatState.recordKey(key);
      const motion = this.searchState.handleKey(key, this.registers, this.editor);
      if (motion !== undefined) {
        this.applyMotion(motion, 1);
        this.editor.clearSearchHighlights();
      }
      return "handled";
    }

    if (this.pendingFind !== undefined) {
      if (!this.repeatState.isReplaying()) this.repeatState.recordKey(key);
      this.handlePendingFindKey(key);
      return "handled";
    }

    if (this.modeState.kind === "normal" && this.markState.isPending()) {
      const motion = this.markState.handleKey(this.editor, key);
      if (motion !== undefined) this.applyMotion(motion, 1);
      return "handled";
    }

    if (this.modeState.kind === "normal" && this.pendingUnmatched !== undefined) {
      const pending = this.pendingUnmatched;
      this.pendingUnmatched = undefined;
      this.applyMotion(
        pending.direction === "forward"
          ? { type: "unmatchedForward", char: key }
          : { type: "unmatchedBackward", char: key },
        pending.count);
      return "handled";
    }

    if (this.isMotionMode() && !this.modeIsExpectingRegisterName() && this.shouldResolveSharedAction(key)) {
      const sharedResolution = this.sharedActionResolver.handleKey(key);
      switch (sharedResolution.kind) {
        case "pending":
          if (!this.repeatState.isReplaying()) this.repeatState.recordKey(key);
          return "handled";
        case "action":
          if (!this.repeatState.isReplaying()) this.repeatState.recordKey(key);
          this.handleSharedAction(sharedResolution.action);
          return "handled";
        case "cancelled":
          if (!this.repeatState.isReplaying()) this.repeatState.recordKey(key);
          if (this.modeState.kind === "normal" && this.normalMode.pendingOperatorName() !== undefined) {
            this.normalMode.clearPending();
          }
          return "handled";
        case "noMatch":
          break;
      }
    }

    if (this.modeState.kind === "normal" && this.shouldResolveNormalChord()) {
      const chordResolution = this.normalChordResolver.handleKey(key);
      switch (chordResolution.kind) {
        case "pending":
          return "handled";
        case "action":
          this.handleNormalChordAction(chordResolution.action);
          return "handled";
        case "cancelled":
          return "handled";
        case "noMatch":
          break;
      }
    }

    if (this.modeState.kind === "normal" && !this.normalMode.isPending() && key === "m") {
      this.markState.startCreate();
      return "handled";
    }

    if (this.modeState.kind === "normal" && (!this.normalMode.isPending() || this.normalMode.pendingOperatorName() !== undefined) && (key === "'" || key === "`")) {
      this.markState.startJump({ line: key === "'" });
      return "handled";
    }

    if (this.modeState.kind === "normal" && !this.normalMode.isPending() && (key === "]" || key === "[")) {
      this.pendingUnmatched = {
        direction: key === "]" ? "forward" : "backward",
        count: this.takeCountForMotion(1),
      };
      return "handled";
    }

    if (!this.repeatState.isReplaying() && this.modeState.kind === "normal" && key === ".") {
      this.repeatState.replay(this.normalMode.takeCountForMotion(1), key => this.onKey(key));
      return "handled";
    }

    if (!this.repeatState.isReplaying()) {
      this.repeatState.maybeStart(key, { mode: this.modeState.kind, pendingChord: this.normalMode.pendingChord() });
      this.repeatState.recordKey(key);
    }

    if (this.modeState.kind === "insert") {
      if (key.length === 1 || key === "\n") {
        insertText(this.editor, key);
        return "handled";
      }
      return "not-handled";
    }

    if (this.modeState.kind === "replace") {
      if (key.length === 1 || key === "\n" || key === "enter") {
        replaceModeText(this.editor, key, this.replaceCount);
        return "handled";
      }
      return "not-handled";
    }

    if (this.isMotionMode() && !this.modeIsExpectingRegisterName()) {
      const handled = this.handleSharedMotionKey(key);
      if (handled) return "handled";
    }

    if (this.modeState.kind === "normal" && key === ":") {
      this.pendingCommand = "";
      return "handled";
    }

    if (
      this.modeState.kind === "visual"
      || this.modeState.kind === "visualLine"
      || this.modeState.kind === "visualBlock"
    ) {
      const result = this.visualMode.onKey(key);
      if (result.enterInsert) {
        this.insertOrigin = this.modeState.kind;
        this.modeState = { dialect: this.modeState.dialect, kind: "insert" };
      } else if (result.nextMode !== undefined) {
        this.modeState = { dialect: this.modeState.dialect, kind: result.nextMode };
      } else if (result.exitVisual) {
        this.modeState = { dialect: this.modeState.dialect, kind: "normal" };
      }
      return result.keyResult;
    }

    if (this.modeState.kind !== "normal") {
      return "not-handled";
    }

    if (key === "v") {
      this.visualMode.enter("charwise");
      this.modeState = { dialect: this.modeState.dialect, kind: "visual" };
      return "handled";
    }

    if (key === "V") {
      this.visualMode.enter("linewise");
      this.modeState = { dialect: this.modeState.dialect, kind: "visualLine" };
      return "handled";
    }

    if (key === "ctrl-v") {
      this.visualMode.enter("blockwise");
      this.modeState = { dialect: this.modeState.dialect, kind: "visualBlock" };
      return "handled";
    }

    if (key === "R") {
      this.replaceCount = this.normalMode.takeCountForMotion(1);
      this.editor.setCursorStyle("block");
      this.modeState = { dialect: this.modeState.dialect, kind: "replace" };
      return "handled";
    }

    const normalResult = this.normalMode.onKey(key);
    if (normalResult.enterInsert) {
      this.insertOrigin = this.modeState.kind;
      this.modeState = { dialect: this.modeState.dialect, kind: "insert" };
    }
    return normalResult.keyResult;
  }

  private collapseToFirstCursor(): void {
    const firstSelection = this.editor.getSelections()[0];
    if (firstSelection === undefined) return;
    this.editor.setSelections([{ type: "charwise", anchor: selectionHead(firstSelection), head: selectionHead(firstSelection) }]);
  }

  private shouldResolveSharedAction(key: string): boolean {
    if (this.sharedActionResolver.isPending()) return true;
    if (this.modeState.kind !== "normal") return true;
    if (this.normalMode.pendingOperatorName() !== undefined) return key === "g";
    return !this.normalMode.hasPendingNonCount();
  }

  private shouldResolveNormalChord(): boolean {
    return !this.normalMode.hasPendingNonCount() || this.normalChordResolver.isPending();
  }

  private handleSharedAction(action: SharedAction): void {
    switch (action.type) {
      case "motion":
        switch (action.key) {
          case "gg":
            this.applyMotion({ type: "startOfDocument" }, this.takeCountForMotion(1));
            return;
          case "gj":
            this.applyMotion({ type: "down" }, this.takeCountForMotion(1));
            return;
          case "gk":
            this.applyMotion({ type: "up" }, this.takeCountForMotion(1));
            return;
        }
      case "page":
        this.editor.moveByPages(
          action.key === "ctrl-u" || action.key === "ctrl-b" ? "up" : "down",
          this.takeCountForMotion(1),
          { halfPage: action.key === "ctrl-u" || action.key === "ctrl-d", extend: this.isVisualMode() });
        if (this.isVisualMode()) this.visualMode.adoptSelectionFromHost();
        else this.syncFromEditorState({ render: false });
        return;
      case "restoreVisualSelection": {
        const nextMode = this.visualMode.restoreLastSelection();
        if (nextMode !== undefined) this.modeState = { dialect: this.modeState.dialect, kind: nextMode };
        return;
      }
      case "searchSelection":
        this.applySearchSelection({ reversed: action.reversed, count: this.takeCountForMotion(1) });
        return;
      case "native":
        this.editor.executeNativeCommand(action.command);
        this.syncFromEditorState({ render: false });
        return;
    }
  }

  private handleNormalChordAction(action: NormalChordAction): void {
    switch (action.type) {
      case "host":
      case "z":
        handleHostAction(this.editor, action, defaultValue => this.takeCountForMotion(defaultValue));
        this.syncFromEditorState({ render: false });
        return;

    }
  }

  private handleSharedMotionKey(key: string): boolean {
    if (key === "n" || key === "N") {
      const motion = this.searchState.repeat({ reversed: key === "N" });
      if (motion !== undefined) this.applyMotion(motion, 1);
      return true;
    }

    if (key === ";" || key === ",") {
      this.repeatFind({ reversed: key === "," });
      return true;
    }

    if (key === "f" || key === "t" || key === "F" || key === "T") {
      const count = this.takeCountForMotion(1);
      switch (key) {
        case "f":
          this.pendingFind = { type: "forward", before: false, count };
          return true;
        case "t":
          this.pendingFind = { type: "forward", before: true, count };
          return true;
        case "F":
          this.pendingFind = { type: "backward", after: false, count };
          return true;
        case "T":
          this.pendingFind = { type: "backward", after: true, count };
          return true;
      }
    }

    if (key === "/" || key === "?") {
      this.searchState.start(key === "?", this.editor);
      return true;
    }

    if ((key === "*" || key === "#") && this.modeState.kind === "normal") {
      const motion = searchUnderCursorMotion(this.editor, this.searchState, this.registers, { backwards: key === "#" });
      if (motion !== undefined) {
        this.applyMotion(motion, this.takeCountForMotion(1));
        this.editor.clearSearchHighlights();
      }
      return true;
    }

    return false;
  }

  private handlePendingFindKey(key: string): void {
    const pending = this.pendingFind;
    this.pendingFind = undefined;
    if (pending === undefined) return;
    const char = key === "space" ? " " : key;
    const motion: FindMotion = pending.type === "forward"
      ? { type: "findForward", before: pending.before, char }
      : { type: "findBackward", after: pending.after, char };
    this.lastFind = motion;
    this.applyMotion(motion, pending.count);
  }

  private repeatFind({ reversed }: { reversed: boolean }): void {
    if (this.lastFind === undefined) return;
    this.applyMotion(reversed ? reverseFindMotion(this.lastFind) : this.lastFind, this.takeCountForMotion(1));
  }

  private handlePendingCommandKey(key: string): void {
    if (this.pendingCommand === undefined) return;
    if (key === "enter") {
      const command = this.pendingCommand;
      this.pendingCommand = undefined;
      executeCommand(this.editor, command, {
        runNormalKeys: (keys, range) => this.runNormalKeysForCommand(keys, range),
      });
      return;
    }
    if (key === "backspace") {
      this.pendingCommand = this.pendingCommand.slice(0, -1);
      return;
    }
    this.pendingCommand += key === "space" ? " " : key;
  }

  private runNormalKeysForCommand(keys: readonly string[], range: LineRange | undefined): void {
    const currentRow = selectionHead(this.editor.getSelections()[0]).row;
    const target = range ?? { startRow: currentRow, endRowInclusive: currentRow };
    for (let row = target.startRow; row <= target.endRowInclusive; row++) {
      this.editor.setSelections([{ type: "charwise", anchor: { row, column: 0 }, head: { row, column: 0 } }]);
      for (const key of keys) this.onKey(key);
      if (this.modeState.kind === "insert") this.onKey("<escape>");
    }
  }

  private applySearchSelection({ reversed, count }: { reversed: boolean; count: number }): void {
    const includeStart = this.modeState.kind === "normal";
    const range = this.searchState.matchRangeForSelection(this.editor, { reversed, count, includeStart });
    if (range === undefined) return;
    if (this.modeState.kind === "normal" && this.normalMode.pendingOperatorName() !== undefined) {
      const enterInsert = this.normalMode.applyMotion({ type: "searchMatch", range }, 1);
      if (enterInsert) this.modeState = { dialect: this.modeState.dialect, kind: "insert" };
      return;
    }

    const currentSelection = this.editor.getSelections()[0];
    if (this.isVisualMode() && currentSelection?.type === "charwise") {
      const currentRange = rangeOfSelection(currentSelection);
      this.editor.setSelections([reversed
        ? { type: "charwise", anchor: currentRange.end, head: range.start }
        : { type: "charwise", anchor: currentRange.start, head: range.end }]);
    } else {
      this.editor.setSelections([reversed
        ? { type: "charwise", anchor: range.end, head: range.start }
        : { type: "charwise", anchor: range.start, head: range.end }]);
    }
    if (this.visualMode.adoptSelection(this.editor.getSelections()[0], { render: true })) {
      this.modeState = { dialect: this.modeState.dialect, kind: "visual" };
    }
  }

  private applyMotion(motion: Motion, count: number): void {
    if (this.modeState.kind === "normal") {
      const enterInsert = this.normalMode.applyMotion(motion, count);
      if (enterInsert) this.modeState = { dialect: this.modeState.dialect, kind: "insert" };
    } else if (this.isVisualMode()) {
      this.visualMode.applyMotion(motion, count);
    }
  }

  private takeCountForMotion(defaultValue: number): number {
    if (this.modeState.kind === "normal") return this.normalMode.takeCountForMotion(defaultValue);
    if (this.isVisualMode()) return this.visualMode.takeCountForMotion(defaultValue);
    return defaultValue;
  }

  private isMotionMode(): boolean {
    return this.modeState.kind === "normal" || this.isVisualMode();
  }

  private modeIsExpectingRegisterName(): boolean {
    if (this.modeState.kind === "normal") return this.normalMode.isExpectingRegisterName();
    if (this.isVisualMode()) return this.visualMode.isExpectingRegisterName();
    return false;
  }

  private isVisualMode(): boolean {
    return this.modeState.kind === "visual" || this.modeState.kind === "visualLine" || this.modeState.kind === "visualBlock";
  }

  private isEscape(key: string): boolean {
    return key === "<escape>" || key === "escape" || key === "ctrl-[";
  }
}

// Local test helper, analogous in spirit to Zed's test harness helpers in
// `test::vim_test_context::VimTestContext` rather than a production API.
export function runKeys(vim: Vim, keys: readonly string[]): void {
  for (const key of keys) {
    vim.onKey(key);
  }
}
