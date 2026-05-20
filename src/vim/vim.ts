// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `vim::Vim`
// - translated concepts: main Vim state holder and high-level mode dispatch
// - intentional differences: GPUI action registration is replaced by direct key dispatch
//   from the VSCode patch / tests.

import { LineRange, executeCommand } from "./command.js";
import { AmbiguousRemapConflict, NoopKey, NormalizedRemapping, RemapResolver, VimConfiguration, defaultVimConfiguration, mergeVimConfiguration, remapModeForVimMode } from "./config.js";
import { lookupDigraph } from "./digraph.js";
import { VimEditorCapabilities, normalCursorPosition } from "./editor.js";
import { enterNormalMode, insertText, deleteToBeginningOfLine, deleteToPreviousWord } from "./insert.js";
import { FindMotion, Motion, reverseFindMotion } from "./motion.js";
import { NormalMode } from "./normal.js";
import { MarkState } from "./normal/mark.js";
import { NormalChordAction, NormalChordResolver } from "./normal/chord.js";
import { MacroState, RecordedSelection, RepeatState, VisualRepeatAction } from "./normal/repeat.js";
import { handleHostAction } from "./normal/scroll.js";
import { SearchState, searchUnderCursorMotion } from "./normal/search.js";
import { RegisterName, Registers, isSystemClipboardRegister, parseRegisterName } from "./registers.js";
import type { VimSystemClipboard } from "./registers.js";
import { ConvertTarget } from "./normal/convert.js";
import { indentRanges } from "./normal/indent.js";
import { replaceModeText } from "./replace.js";
import { SharedAction, SharedActionResolver } from "./shared_action.js";
import { KeyResult, Operator, VimMode, charwiseSelection, comparePositions, rangeOfSelection, selectionHead } from "./state.js";
import { VisualMode } from "./visual.js";

type PendingFind =
  | { type: "forward"; before: boolean; count: number }
  | { type: "backward"; after: boolean; count: number };

type PendingDigraph =
  | { target: "insert" | "replace"; first?: string }
  | { target: "find"; pending: PendingFind; first?: string };

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
  private configuration: VimConfiguration = defaultVimConfiguration;
  private remapResolver = new RemapResolver(this.configuration);
  private pendingCommand: string | undefined;
  private pendingDigraph: PendingDigraph | undefined;
  private pendingInsertRegister = false;
  private insertRepeatCount = 1;
  private insertRepeatText = "";
  private insertRepeatSeparator = "";
  private lastInsertPosition: ReturnType<typeof selectionHead> | undefined;
  private insertOrigin: VimMode["kind"] | undefined;
  private readonly normalMode: NormalMode;
  private readonly visualMode: VisualMode;

  constructor(private readonly editor: VimEditorCapabilities, configuration: Partial<VimConfiguration> = {}) {
    this.configuration = mergeVimConfiguration(configuration);
    this.remapResolver = new RemapResolver(this.configuration);
    this.registers.setUseSystemClipboard(this.configuration.useSystemClipboard);
    this.editor.setCursorStyle("block");
    this.normalMode = new NormalMode(editor, this.registers);
    this.visualMode = new VisualMode(editor, this.registers);
  }

  setConfiguration(configuration: Partial<VimConfiguration>): void {
    this.configuration = mergeVimConfiguration(configuration);
    this.remapResolver = new RemapResolver(this.configuration);
    this.registers.setUseSystemClipboard(this.configuration.useSystemClipboard);
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

  ambiguousRemapConflicts(): readonly AmbiguousRemapConflict[] {
    return this.remapResolver.ambiguousConflicts();
  }

  handleKeyOverride(key: string): boolean | undefined {
    return this.remapResolver.handleKeyOverride(key);
  }

  shouldHandleKey(key: string): boolean {
    const handleOverride = this.handleKeyOverride(key);
    if (handleOverride === false) return false;
    if (handleOverride === true) return true;

    if (isCtrlKey(key) && !this.remapResolver.isPending()) {
      const isMapped = this.remapResolver.hasMappingStartingWith(this.currentRemapMode(), key);
      if (!isMapped) {
        if (!this.configuration.useCtrlKeys) return false;
        if (!isBuiltInCtrlKey(key)) return false;
      }
    }

    return !((this.modeState.kind === "insert" || this.modeState.kind === "replace")
      && !this.shouldHandleInsertKey(key)
      && !this.status.pending);
  }

  shouldHandleInsertKey(key: string): boolean {
    return this.remapResolver.isPending()
      || this.remapResolver.hasMappings("insert")
      || key === "ctrl-k"
      || key === "ctrl-r"
      || key === "ctrl-w"
      || key === "ctrl-u"
      || this.isEscape(key);
  }

  syncFromEditorState({ render = true }: { render?: boolean } = {}): void {
    this.pendingFind = undefined;
    this.pendingUnmatched = undefined;
    this.sharedActionResolver.clearPending();
    this.remapResolver.clearPending();
    this.normalChordResolver.clearPending();
    this.markState.clearPending();
    this.searchState.clearPending();
    this.pendingCommand = undefined;
    this.pendingDigraph = undefined;
    this.pendingInsertRegister = false;
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
    return this.pendingFind !== undefined || this.pendingUnmatched !== undefined || this.pendingDigraph !== undefined || this.sharedActionResolver.isPending() || this.remapResolver.isPending() || this.normalChordResolver.isPending() || this.markState.isPending() || this.searchState.isPending() || this.pendingCommand !== undefined || this.pendingInsertRegister || (this.modeState.kind === "normal" && this.normalMode.isPending());
  }

  private pendingChord(): string {
    if (this.pendingCommand !== undefined) return `:${this.pendingCommand}`;
    if (this.pendingDigraph !== undefined) return "ctrl-k";
    if (this.pendingInsertRegister) return "ctrl-r";
    if (this.remapResolver.isPending()) return this.remapResolver.pendingChord();
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
    return this.onKeyInternal(key, { allowRemap: true });
  }

  async onKeyAsync(key: string, { clipboard }: { clipboard?: VimSystemClipboard } = {}): Promise<KeyResult> {
    return this.registers.withSystemClipboard(clipboard, async () => {
      await this.refreshSystemClipboardRegisterForKey(key);
      return this.onKeyInternal(key, { allowRemap: true });
    });
  }

  private async refreshSystemClipboardRegisterForKey(key: string): Promise<void> {
    const registerToRead = this.systemClipboardRegisterToReadForKey(key);
    if (registerToRead !== undefined) await this.registers.refreshSystemClipboardRegister(registerToRead.registerName);
  }

  private systemClipboardRegisterToReadForKey(key: string): { registerName: RegisterName | undefined } | undefined {
    if (this.pendingInsertRegister) {
      const registerName = parseRegisterName(key);
      return isSystemClipboardRegister(registerName) ? { registerName } : undefined;
    }

    if (this.modeState.kind === "normal") return this.normalMode.systemClipboardRegisterToReadForKey(key);
    if (this.isVisualMode()) return this.visualMode.systemClipboardRegisterToReadForKey(key);
    return undefined;
  }

  private onKeyInternal(key: string, { allowRemap }: { allowRemap: boolean }): KeyResult {
    if (!this.repeatState.isReplaying()) this.repeatState.maybeFinish({ mode: this.modeState.kind, isPending: this.isPending() });

    if (allowRemap && this.shouldResolveRemap()) {
      const resolution = this.remapResolver.handleKey(this.currentRemapMode(), key);
      switch (resolution.kind) {
        case "pending":
          return "handled";
        case "matched":
          this.executeRemapping(resolution.mapping);
          return "handled";
        case "replay":
          for (const replayKey of resolution.keys) this.onKeyInternal(replayKey, { allowRemap: false });
          return "handled";
        case "noMatch":
          break;
      }
    }

    if (this.pendingDigraph !== undefined) {
      this.handlePendingDigraphKey(key);
      return "handled";
    }

    if (this.pendingInsertRegister) {
      this.handlePendingInsertRegisterKey(key);
      return "handled";
    }

    if (this.isEscape(key)) {
      if (!this.repeatState.isReplaying()) this.repeatState.recordKey(key);
      if (!this.macroState.isReplaying()) this.macroState.recordKey(key);
      this.pendingFind = undefined;
      this.pendingDigraph = undefined;
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
        if (modeBeforeEscape === "insert" || modeBeforeEscape === "replace") {
          this.finishInsertOrReplaceSession(modeBeforeEscape);
        }
        enterNormalMode(this.editor, { moveLeft: modeBeforeEscape === "insert" || modeBeforeEscape === "replace" });
        if (modeBeforeEscape === "insert" && this.insertOrigin === "visualBlock") {
          this.collapseToFirstCursor();
        }
        this.insertOrigin = undefined;
        this.modeState = { dialect: this.modeState.dialect, kind: "normal" };
        if (modeBeforeEscape === "insert" || modeBeforeEscape === "replace") {
          this.editor.finishUndoTransaction();
        }
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
          if (!this.repeatState.isReplaying()) {
            this.repeatState.maybeStart(key, { mode: this.modeState.kind, pendingChord: this.normalMode.pendingChord() });
            this.repeatState.recordKey(key);
          }
          return "handled";
        case "action":
          if (!this.repeatState.isReplaying()) {
            this.repeatState.maybeStart(key, { mode: this.modeState.kind, pendingChord: this.normalMode.pendingChord() });
            this.repeatState.recordKey(key);
          }
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
      this.repeatState.replay(this.normalMode.takeCountForRepeat(), {
        runKey: key => this.onKey(key),
        runVisualAction: (selection, action) => this.replayVisualAction(selection, action),
      });
      return "handled";
    }

    if (!this.repeatState.isReplaying()) {
      this.repeatState.maybeStart(key, { mode: this.modeState.kind, pendingChord: this.normalMode.pendingChord() });
      this.repeatState.recordKey(key);
    }

    if (this.modeState.kind === "insert") {
      if (key === "ctrl-k") {
        this.pendingDigraph = { target: "insert" };
        return "handled";
      }
      if (key === "ctrl-r") {
        this.pendingInsertRegister = true;
        return "handled";
      }
      if (key === "ctrl-w") {
        deleteToPreviousWord(this.editor);
        return "handled";
      }
      if (key === "ctrl-u") {
        deleteToBeginningOfLine(this.editor);
        return "handled";
      }
      if (key.length === 1 || key === "\n") {
        insertText(this.editor, key);
        this.insertRepeatText += key;
        return "handled";
      }
      return "not-handled";
    }

    if (this.modeState.kind === "replace") {
      if (key === "ctrl-k") {
        this.pendingDigraph = { target: "replace" };
        return "handled";
      }
      if (key.length === 1 || key === "\n" || key === "enter") {
        const text = key === "enter" ? "\n" : key;
        replaceModeText(this.editor, text, 1);
        this.insertRepeatText += text;
        return "handled";
      }
      return "not-handled";
    }

    if (this.isMotionMode() && !this.modeIsExpectingRegisterName()) {
      const handled = this.handleSharedMotionKey(key);
      if (handled) return "handled";
    }

    if (this.modeState.kind === "normal" && !this.normalMode.hasPendingNonCount() && key === ":") {
      this.pendingCommand = "";
      return "handled";
    }

    if (
      this.modeState.kind === "visual"
      || this.modeState.kind === "visualLine"
      || this.modeState.kind === "visualBlock"
    ) {
      const result = this.visualMode.onKey(key);
      if (result.repeatAction !== undefined && !this.repeatState.isReplaying()) {
        this.repeatState.recordVisualAction(result.repeatAction.selection, result.repeatAction.action);
      }
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
      this.startInsertOrReplaceSession({ count: this.normalMode.takeCountForMotion(1), separator: "" });
      this.editor.setCursorStyle("block");
      this.modeState = { dialect: this.modeState.dialect, kind: "replace" };
      return "handled";
    }

    const normalResult = this.normalMode.onKey(key);
    if (normalResult.enterInsert) {
      this.insertOrigin = this.modeState.kind;
      this.startInsertOrReplaceSession({ count: normalResult.insertCount, separator: normalResult.insertSeparator });
      this.modeState = { dialect: this.modeState.dialect, kind: "insert" };
    }
    return normalResult.keyResult;
  }

  private enterInsertAtPrevious(): void {
    const position = this.lastInsertPosition;
    if (position !== undefined) this.editor.setSelections([charwiseSelection(position)]);
    this.editor.setCursorStyle("line");
    this.insertOrigin = this.modeState.kind;
    this.startInsertOrReplaceSession({ count: this.takeCountForMotion(1), separator: "" });
    this.modeState = { dialect: this.modeState.dialect, kind: "insert" };
  }

  private startInsertOrReplaceSession({ count, separator }: { count: number; separator: string }): void {
    this.insertRepeatCount = count;
    this.insertRepeatText = "";
    this.insertRepeatSeparator = separator;
  }

  private finishInsertOrReplaceSession(mode: "insert" | "replace"): void {
    this.lastInsertPosition = selectionHead(this.editor.getSelections()[0]);
    if (this.insertRepeatCount <= 1 || this.insertRepeatText.length === 0) {
      this.clearInsertOrReplaceSession();
      return;
    }
    const repeatedText = Array.from({ length: this.insertRepeatCount - 1 }, () => `${this.insertRepeatSeparator}${this.insertRepeatText}`).join("");
    if (mode === "replace") replaceModeText(this.editor, repeatedText, 1);
    else insertText(this.editor, repeatedText);
    this.lastInsertPosition = selectionHead(this.editor.getSelections()[0]);
    this.clearInsertOrReplaceSession();
  }

  private clearInsertOrReplaceSession(): void {
    this.insertRepeatCount = 1;
    this.insertRepeatText = "";
    this.insertRepeatSeparator = "";
  }

  private shouldResolveRemap(): boolean {
    if (this.remapResolver.isPending()) return true;
    return this.pendingFind === undefined
      && this.pendingUnmatched === undefined
      && !this.sharedActionResolver.isPending()
      && !this.normalChordResolver.isPending()
      && !this.markState.isPending()
      && !this.searchState.isPending()
      && this.pendingCommand === undefined
      && this.pendingDigraph === undefined
      && !this.pendingInsertRegister;
  }

  private currentRemapMode() {
    return remapModeForVimMode(this.modeState.kind, {
      operatorPending: this.modeState.kind === "normal" && this.normalMode.pendingOperatorName() !== undefined,
    });
  }

  private executeRemapping(mapping: NormalizedRemapping): void {
    const skipFirstRecursiveKey = mapping.recursive && isPrefixOrEqual(mapping.before, mapping.after);
    for (const [index, key] of mapping.after.entries()) {
      if (key === NoopKey) continue;
      this.onKeyInternal(key, { allowRemap: mapping.recursive && !(skipFirstRecursiveKey && index === 0) });
    }
    for (const command of mapping.commands) this.executeMappedCommand(command);
  }

  private executeMappedCommand(command: NormalizedRemapping["commands"][number]): void {
    if (typeof command === "string") {
      if (command.startsWith(":")) executeCommand(this.editor, command.slice(1), { runNormalKeys: (keys, range) => this.runNormalKeysForCommand(keys, range) });
      else this.editor.executeNativeCommand(command, [], { preserveVisualSelection: this.isVisualMode() });
      return;
    }

    if (command.command.startsWith(":")) {
      executeCommand(this.editor, command.command.slice(1), { runNormalKeys: (keys, range) => this.runNormalKeysForCommand(keys, range) });
    } else {
      this.editor.executeNativeCommand(command.command, commandArgs(command), { preserveVisualSelection: this.isVisualMode() });
    }
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
            this.applyMotion({ type: "down", displayLine: true }, this.takeCountForMotion(1));
            return;
          case "gk":
            this.applyMotion({ type: "up", displayLine: true }, this.takeCountForMotion(1));
            return;
        }
      case "normalGKey":
        if (this.modeState.kind === "normal") {
          this.normalMode.handleGKey(action.key);
        } else if (this.isVisualMode() && action.key === "J") {
          this.visualMode.joinSelections({ insertWhitespace: false });
          this.modeState = { dialect: this.modeState.dialect, kind: "normal" };
        } else if (this.isVisualMode() && (action.key === "u" || action.key === "U" || action.key === "~")) {
          this.visualMode.convertSelections(convertTargetForKey(action.key));
          this.modeState = { dialect: this.modeState.dialect, kind: "normal" };
        }
        return;
      case "insertAtPrevious":
        if (this.modeState.kind === "normal") this.enterInsertAtPrevious();
        return;
      case "page": {
        const selections = this.editor.moveByPages(
          action.key === "ctrl-u" || action.key === "ctrl-b" ? "up" : "down",
          this.takeCountForMotion(1),
          { halfPage: action.key === "ctrl-u" || action.key === "ctrl-d", extend: this.isVisualMode() });
        if (selections !== undefined) this.editor.setSelections(selections);
        if (this.isVisualMode()) this.visualMode.adoptSelectionFromHost();
        return;
      }
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
    if (key === "ctrl-k") {
      this.pendingDigraph = { target: "find", pending };
      return;
    }
    this.applyFindChar(pending, keyForInput(key));
  }

  private applyFindChar(pending: PendingFind, char: string): void {
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

  private handlePendingDigraphKey(key: string): void {
    const pending = this.pendingDigraph;
    if (pending === undefined) return;
    if (this.isEscape(key)) {
      this.pendingDigraph = undefined;
      return;
    }
    const input = keyForInput(key);
    if (pending.first === undefined) {
      this.pendingDigraph = { ...pending, first: input };
      return;
    }

    this.pendingDigraph = undefined;
    const text = lookupDigraph(pending.first, input);
    switch (pending.target) {
      case "insert":
        insertText(this.editor, text);
        this.insertRepeatText += text;
        return;
      case "replace":
        replaceModeText(this.editor, text, 1);
        this.insertRepeatText += text;
        return;
      case "find":
        this.applyFindChar(pending.pending, text);
        return;
    }
  }

  private handlePendingInsertRegisterKey(key: string): void {
    this.pendingInsertRegister = false;
    if (this.isEscape(key)) return;
    const registerName = parseRegisterName(key);
    if (registerName === undefined) return;
    insertText(this.editor, this.registers.read(registerName));
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

  private replayVisualAction(selection: RecordedSelection, action: VisualRepeatAction): void {
    switch (action.type) {
      case "indent": {
        const startRow = selectionHead(this.editor.getSelections()[0]).row;
        const rows = selection.type === "visualLine" ? selection.rows : 0;
        const endRow = Math.min(this.editor.lineCount() - 1, startRow + rows);
        indentRanges(
          this.editor,
          [{ start: { row: startRow, column: 0 }, end: { row: endRow, column: this.editor.lineLength(endRow) } }],
          action.direction
        );
        return;
      }
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

function keyForInput(key: string): string {
  return key === "space" ? " " : key;
}

function isPrefixOrEqual(prefix: readonly string[], full: readonly string[]): boolean {
  return prefix.length <= full.length && prefix.every((key, index) => key === full[index]);
}

function isCtrlKey(key: string): boolean {
  return key.startsWith("ctrl-");
}

function isBuiltInCtrlKey(key: string): boolean {
  switch (key) {
    case "ctrl-a":
    case "ctrl-b":
    case "ctrl-d":
    case "ctrl-e":
    case "ctrl-f":
    case "ctrl-i":
    case "ctrl-k":
    case "ctrl-o":
    case "ctrl-r":
    case "ctrl-u":
    case "ctrl-v":
    case "ctrl-w":
    case "ctrl-x":
    case "ctrl-y":
    case "ctrl-[":
    case "ctrl-left":
    case "ctrl-right":
    case "ctrl-home":
    case "ctrl-end":
      return true;
    default:
      return false;
  }
}

function commandArgs(command: { args?: unknown | unknown[] }): readonly unknown[] {
  if (command.args === undefined) return [];
  return Array.isArray(command.args) ? command.args : [command.args];
}

function convertTargetForKey(key: "u" | "U" | "~"): ConvertTarget {
  switch (key) {
    case "u":
      return "lower";
    case "U":
      return "upper";
    case "~":
      return "toggle";
  }
}

// Local test helper, analogous in spirit to Zed's test harness helpers in
// `test::vim_test_context::VimTestContext` rather than a production API.
export function runKeys(vim: Vim, keys: readonly string[]): void {
  for (const key of keys) {
    vim.onKey(key);
  }
}
