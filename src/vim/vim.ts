// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `vim::Vim`
// - translated concepts: main Vim state holder and high-level mode dispatch
// - intentional differences: GPUI action registration is replaced by direct key dispatch
//   from the VSCode patch / tests.

import { LineRange, executeCommand } from "./command.js";
import { VimEditorCapabilities } from "./editor.js";
import { enterNormalMode, insertText } from "./insert.js";
import { FindMotion, Motion, reverseFindMotion } from "./motion.js";
import { NormalMode } from "./normal.js";
import { MacroState, RepeatState } from "./normal/repeat.js";
import { SearchState } from "./normal/search.js";
import { RegisterName, Registers } from "./registers.js";
import { replaceModeText } from "./replace.js";
import { KeyResult, Operator, VimMode, comparePositions, selectionHead } from "./state.js";
import { VisualMode } from "./visual.js";

type PendingFind =
  | { type: "forward"; before: boolean; count: number }
  | { type: "backward"; after: boolean; count: number };

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
  private lastFind: FindMotion | undefined;
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
    this.modeState = { dialect: this.modeState.dialect, kind: "normal" };
  }

  private isPending(): boolean {
    return this.pendingFind !== undefined || this.searchState.isPending() || this.pendingCommand !== undefined || (this.modeState.kind === "normal" && this.normalMode.isPending());
  }

  private pendingChord(): string {
    if (this.pendingCommand !== undefined) return `:${this.pendingCommand}`;
    if (this.searchState.isPending()) return this.searchState.pendingChord();
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
      const motion = this.searchState.handleKey(key, this.registers);
      if (motion !== undefined) this.applyMotion(motion, 1);
      return "handled";
    }

    if (this.pendingFind !== undefined) {
      if (!this.repeatState.isReplaying()) this.repeatState.recordKey(key);
      this.handlePendingFindKey(key);
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
      this.searchState.start(key === "?");
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
