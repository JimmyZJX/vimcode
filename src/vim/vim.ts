// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `vim::Vim`
// - translated concepts: main Vim state holder and high-level mode dispatch
// - intentional differences: GPUI action registration is replaced by direct key dispatch
//   from the VSCode patch / tests.

import { LineRange, executeCommand } from "./command.js";
import { AmbiguousRemapConflict, NoopKey, NormalizedRemapping, RemapResolver, VimConfiguration, defaultVimConfiguration, mergeVimConfiguration, remapModeForVimMode } from "./config.js";
import { lookupDigraph } from "./digraph.js";
import { collapseSelectionsToNormalCursors, collapseToPrimaryNormalCursor, hasMultipleCursorsOrSelection, reconcileCursorState } from "./editor_state_sync.js";
import { VimEditorCapabilities, keepUndoTransactionOpen, normalCursorPosition } from "./editor.js";
import { enterNormalMode, insertCharacterFromAdjacentLine, insertText, deleteToBeginningOfLine, deleteToPreviousWord } from "./insert.js";
import { FindMotion, Motion, reverseFindMotion } from "./motion.js";
import { NormalMode } from "./normal.js";
import type { NormalKeyResult } from "./normal.js";
import { NormalChordAction, NormalChordResolver } from "./normal/chord.js";
import { RecordedSelection, VisualRepeatAction } from "./normal/repeat.js";
import { incrementNumbers } from "./normal/increment.js";
import { handleHostAction } from "./normal/scroll.js";
import { searchUnderCursorMotion } from "./normal/search.js";
import { RegisterName, isSystemClipboardRegister, parseRegisterName } from "./registers.js";
import type { VimSystemClipboard } from "./registers.js";
import { ConvertTarget } from "./normal/convert.js";
import { indentRanges } from "./normal/indent.js";
import { replaceModeText } from "./replace.js";
import { SharedAction, SharedActionResolver } from "./shared_action.js";
import { KeyResult, Operator, Position, TextEdit, TextRange, VimMode, charwiseSelection, rangeOfSelection, selectionHead } from "./state.js";
import { VisualMode } from "./visual.js";
import type { VisualKeyResult, VisualResultMode } from "./visual.js";
import { VimGlobalState, VimModelState } from "./vim_state.js";

type PendingFindOperator =
  | { type: "findForward"; before: boolean; count: number }
  | { type: "findBackward"; after: boolean; count: number };

type PendingDigraphOperator =
  | { type: "digraph"; target: "insert" | "replace"; first?: string }
  | { type: "digraph"; target: "find"; pending: PendingFindOperator; first?: string };

type PendingLiteralOperator =
  | { type: "literal"; kind: "plain" }
  | { type: "literal"; kind: "decimal"; digits: string }
  | { type: "literal"; kind: "hex"; digits: string; maxDigits: number };

type PendingInsertRegisterOperator = { type: "insertRegister" };
type PendingMarkOperator = { type: "mark" };
type PendingJumpOperator = { type: "jump"; line: boolean };
type PendingRecordRegisterOperator = { type: "recordRegister" };
type PendingReplayRegisterOperator = { type: "replayRegister"; count: number };

type PendingVimOperator = PendingFindOperator | PendingDigraphOperator | PendingLiteralOperator | PendingInsertRegisterOperator | PendingMarkOperator | PendingJumpOperator | PendingRecordRegisterOperator | PendingReplayRegisterOperator;

type PendingUnmatched = { direction: "forward" | "backward"; count: number };

function pendingOperatorStatus(operator: PendingVimOperator): string {
  switch (operator.type) {
    case "findForward":
      return operator.before ? "t" : "f";
    case "findBackward":
      return operator.after ? "T" : "F";
    case "digraph":
      return operator.first === undefined ? "ctrl-k" : `ctrl-k${operator.first}`;
    case "literal":
      return operator.kind === "plain" ? "ctrl-v" : `ctrl-v${operator.digits}`;
    case "insertRegister":
      return "ctrl-r";
    case "mark":
      return "m";
    case "jump":
      return operator.line ? "'" : "`";
    case "recordRegister":
      return "q";
    case "replayRegister":
      return "@";
  }
}

const sharedMotionByKey: ReadonlyMap<Extract<SharedAction, { type: "motion" }>["key"], Motion> = new Map([
  ["gg", { type: "startOfDocument" }],
  ["gj", { type: "down", displayLine: true }],
  ["gk", { type: "up", displayLine: true }],
  ["g_", { type: "lastNonWhitespace" }],
  ["ge", { type: "previousWordEnd", bigWord: false }],
  ["gE", { type: "previousWordEnd", bigWord: true }],
]);

export type VimStatus = {
  mode: VimMode["kind"];
  pending: boolean;
  operator: Operator | undefined;
  chord: string;
  text: string;
  remapPending: boolean;
  remapTimeoutMs: number;
  insertPendingText: string | undefined;
};

export type EditorSyncResult = {
  mode: VimMode["kind"];
  selectionCount: number;
  visualSelectionFound: boolean;
  adoptedVisualSelection: boolean;
  reason: string;
};

export type KeyPlan = { run: (env?: { clipboard?: VimSystemClipboard }) => Promise<KeyResult> };

type PreparedKey = { key: string };

export { VimGlobalState, VimModelState };

// Zed: `vim::Vim`. This class is the local main state holder; GPUI
// entity/window fields are intentionally replaced by the injected
// `VimEditorCapabilities`.
export class Vim {
  private modeState: VimMode = { dialect: "vim", kind: "normal" };
  private pendingUnmatched: PendingUnmatched | undefined;
  private readonly sharedActionResolver = new SharedActionResolver();
  private readonly normalChordResolver = new NormalChordResolver();
  private modelState: VimModelState;
  private configuration: VimConfiguration = defaultVimConfiguration;
  private remapResolver = new RemapResolver(this.configuration);
  private pendingCommand: string | undefined;
  private searchOriginMode: VimMode["kind"] | undefined;
  private pendingStack: PendingVimOperator[] = [];
  private insertRepeatCount = 1;
  private insertRepeatText = "";
  private insertRepeatSeparator = "";
  private insertOrigin: VimMode["kind"] | undefined;
  private pendingVisualRepeatChange: { selection: RecordedSelection } | undefined;
  private readonly insertKeyHandlers: ReadonlyMap<string, () => KeyResult> = new Map([
    ["ctrl-k", () => this.startInsertDigraph()],
    ["ctrl-v", () => this.startPlainLiteral()],
    ["ctrl-r", () => this.startInsertRegister()],
    ["ctrl-w", () => this.deleteInsertPreviousWord()],
    ["ctrl-u", () => this.deleteInsertLineStart()],
    ["ctrl-y", () => this.insertCharacterFromAdjacentLine("above")],
    ["ctrl-e", () => this.insertCharacterFromAdjacentLine("below")],
  ]);
  private readonly replaceKeyHandlers: ReadonlyMap<string, () => KeyResult> = new Map([
    ["ctrl-k", () => this.startReplaceDigraph()],
  ]);
  private readonly normalMode: NormalMode;
  private readonly visualMode: VisualMode;

  constructor(
    private readonly editor: VimEditorCapabilities,
    configuration: Partial<VimConfiguration> = {},
    private readonly globalState: VimGlobalState = new VimGlobalState(),
    modelState: VimModelState = new VimModelState()
  ) {
    this.modelState = modelState;
    this.configuration = mergeVimConfiguration(configuration);
    this.remapResolver = new RemapResolver(this.configuration);
    this.globalState.registers.setUseSystemClipboard(this.configuration.useSystemClipboard);
    this.editor.setCursorStyle("block");
    this.normalMode = new NormalMode(editor, this.globalState.registers);
    this.visualMode = new VisualMode(editor, this.globalState.registers, this.configuration);
  }

  attachModelState(modelState: VimModelState): void {
    if (this.modelState === modelState) return;
    this.clearPendingForModelSwitch();
    this.modelState = modelState;
  }

  setConfiguration(configuration: Partial<VimConfiguration>): void {
    this.configuration = mergeVimConfiguration(configuration);
    this.remapResolver = new RemapResolver(this.configuration);
    this.globalState.registers.setUseSystemClipboard(this.configuration.useSystemClipboard);
    this.visualMode.setConfiguration(this.configuration);
  }

  private activePending<Type extends PendingVimOperator["type"]>(type: Type): Extract<PendingVimOperator, { type: Type }> | undefined {
    const item = this.pendingStack[this.pendingStack.length - 1];
    return item?.type === type ? item as Extract<PendingVimOperator, { type: Type }> : undefined;
  }

  private activeFind(): PendingFindOperator | undefined {
    const item = this.pendingStack[this.pendingStack.length - 1];
    return item?.type === "findForward" || item?.type === "findBackward" ? item : undefined;
  }

  private popFind(): PendingFindOperator | undefined {
    const item = this.activeFind();
    if (item === undefined) return undefined;
    this.pendingStack.pop();
    return item;
  }

  private popPending<Type extends PendingVimOperator["type"]>(type: Type): Extract<PendingVimOperator, { type: Type }> | undefined {
    const item = this.activePending(type);
    if (item === undefined) return undefined;
    this.pendingStack.pop();
    return item;
  }

  private replaceActiveDigraph(digraph: PendingDigraphOperator): void {
    const item = this.activePending("digraph");
    if (item === undefined) this.pendingStack.push(digraph);
    else this.pendingStack[this.pendingStack.length - 1] = digraph;
  }

  private replaceActiveLiteral(literal: PendingLiteralOperator): void {
    const item = this.activePending("literal");
    if (item === undefined) this.pendingStack.push(literal);
    else this.pendingStack[this.pendingStack.length - 1] = literal;
  }

  get mode(): VimMode {
    return this.modeState;
  }

  get modeName(): string {
    const suffix = this.isPending() && this.modeState.kind !== "search" && this.modeState.kind !== "command" ? "+" : "";
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
      remapPending: this.remapResolver.isPending(),
      remapTimeoutMs: this.configuration.timeout,
      insertPendingText: mode === "insert" || mode === "replace" ? this.remapResolver.pendingInsertText() : undefined,
    };
  }

  readRegister(name: RegisterName | undefined): string {
    return this.globalState.registers.read(name);
  }

  ambiguousRemapConflicts(): readonly AmbiguousRemapConflict[] {
    return this.remapResolver.ambiguousConflicts();
  }

  handleKeyOverride(key: string): boolean | undefined {
    return this.remapResolver.handleKeyOverride(key);
  }

  /** Test helper for asserting the synchronous key preflight decision.
      Production code should call [handleKey] and run the returned [KeyPlan]. */
  wouldHandleKeyForTest(key: string): boolean {
    return this.handleKey(key) !== null;
  }

  handleKey(key: string): KeyPlan | null {
    const preparedKey = this.prepareKey(key);
    if (preparedKey === null) return null;
    return {
      run: ({ clipboard }: { clipboard?: VimSystemClipboard } = {}) =>
        this.onKeyAsync(preparedKey.key, { clipboard }),
    };
  }

  private prepareKey(key: string): PreparedKey | null {
    const handleOverride = this.handleKeyOverride(key);
    if (handleOverride === false) return null;
    if (handleOverride === true) return { key };

    if (this.isEscape(key)) return this.shouldHandleEscapeKey() ? { key } : null;

    if (this.modeState.kind === "search") return this.shouldHandleSearchKey(key) ? { key } : null;

    if (isCtrlKey(key) && !this.remapResolver.isPending()) {
      const isMapped = this.remapResolver.hasMappingStartingWith(this.currentRemapMode(), key);
      if (!isMapped) {
        if (!this.configuration.useCtrlKeys) return null;
        if (!isBuiltInCtrlKey(key)) return null;
      }
    }

    if (this.modeState.kind === "command") return { key };

    if (this.modeState.kind === "insert" || this.modeState.kind === "replace") {
      return this.shouldPrepareInsertOrReplaceKey(key) ? { key } : null;
    }

    return { key };
  }

  private shouldPrepareInsertOrReplaceKey(key: string): boolean {
    return this.remapResolver.isPending()
      || this.remapResolver.hasMappingStartingWith(this.currentRemapMode(), key)
      || this.pendingStack.length > 0
      || key === "ctrl-k"
      || key === "ctrl-v"
      || key === "ctrl-r"
      || key === "ctrl-w"
      || key === "ctrl-u"
      || key === "ctrl-y"
      || key === "ctrl-e";
  }

  private shouldHandleSearchKey(key: string): boolean {
    return key.length === 1
      || key === "space"
      || key === "enter"
      || key === "backspace"
      || key === "delete"
      || key === "left"
      || key === "right"
      || key === "ctrl-left"
      || key === "ctrl-right"
      || key === "home"
      || key === "end"
      || key === "ctrl-backspace"
      || key === "ctrl-delete"
      || key === "ctrl-v"
      || key === "ctrl-y"
      || this.isEscape(key);
  }

  private shouldHandleEscapeKey(): boolean {
    return this.modeState.kind !== "normal"
      || this.hasMultipleCursorsOrSelection()
      || this.pendingUnmatched !== undefined
      || this.pendingStack.length > 0
      || this.sharedActionResolver.isPending()
      || this.remapResolver.isPending()
      || this.normalChordResolver.isPending()
      || this.globalState.search.isPending()
      || this.pendingCommand !== undefined
      || this.normalMode.isPending();
  }

  syncFromEditorState({ render = true }: { render?: boolean } = {}): EditorSyncResult {
    const modeBeforeSync = this.modeState.kind;
    const selections = this.editor.getSelections();
    const reconciliation = reconcileCursorState(
      { selections },
      { mode: this.modeState, selections }
    );

    if (reconciliation.modeKind === "visual") {
      const visualSelection = reconciliation.selections.find(selection => selection.type === "charwise");
      const adopted = visualSelection !== undefined
        && this.visualMode.adoptSelection(visualSelection, { render });
      if (adopted) {
        this.clearPendingForExternalModeChange();
        this.insertOrigin = undefined;
        this.modeState = { dialect: this.modeState.dialect, kind: "visual" };
        return { mode: this.modeState.kind, ...reconciliation };
      }
    }

    if (this.isVisualMode()) {
      this.visualMode.clearState();
    }
    this.insertOrigin = undefined;
    if (render) this.editor.setCursorStyle("block");
    const normalSelections = collapseSelectionsToNormalCursors(reconciliation.selections)
      .map(selection => {
        const normalSelection = charwiseSelection(normalCursorPosition(this.editor, selectionHead(selection)));
        return selection.goal === undefined ? normalSelection : { ...normalSelection, goal: selection.goal };
      });
    this.editor.setSelections(normalSelections);
    if (modeBeforeSync !== "search" && modeBeforeSync !== "command") {
      this.setMode("normal");
    }
    return {
      mode: this.modeState.kind,
      selectionCount: reconciliation.selectionCount,
      visualSelectionFound: reconciliation.visualSelectionFound,
      adoptedVisualSelection: false,
      reason: reconciliation.visualSelectionFound ? "failed to adopt visual selection" : reconciliation.reason,
    };
  }

  syncFromUndoRedoState({ render = true }: { render?: boolean } = {}): EditorSyncResult {
    return this.syncFromEditorState({ render });
  }

  private clearPendingForModelSwitch(): void {
    this.clearPendingGrammar({ closeSearchHighlights: false });
  }

  private clearPendingForExternalModeChange(): void {
    this.clearPendingGrammar({ closeSearchHighlights: true });
  }

  private clearPendingGrammar({ closeSearchHighlights }: { closeSearchHighlights: boolean }): void {
    const searchWasPending = this.globalState.search.isPending();
    this.pendingUnmatched = undefined;
    this.sharedActionResolver.clearPending();
    this.remapResolver.clearPending();
    this.normalChordResolver.clearPending();
    this.globalState.search.clearPending(this.editor, { restoreViewport: closeSearchHighlights });
    this.searchOriginMode = undefined;
    if (closeSearchHighlights && searchWasPending) this.editor.clearSearchHighlights();
    this.pendingCommand = undefined;
    this.pendingStack = [];
    this.normalMode.clearPending();
  }

  private isPending(): boolean {
    return this.pendingUnmatched !== undefined || this.pendingStack.length > 0 || this.sharedActionResolver.isPending() || this.remapResolver.isPending() || this.normalChordResolver.isPending() || this.globalState.search.isPending() || this.pendingCommand !== undefined || (this.modeState.kind === "normal" && this.normalMode.isPending());
  }

  private pendingChord(): string {
    if (this.pendingCommand !== undefined) return `:${this.pendingCommand}`;
    const pendingOperator = this.pendingStack[this.pendingStack.length - 1];
    if (pendingOperator !== undefined) return pendingOperatorStatus(pendingOperator);
    if (this.remapResolver.isPending()) return this.remapResolver.pendingChord();
    if (this.globalState.search.isPending()) return this.globalState.search.pendingChord();
    if (this.sharedActionResolver.isPending()) return `${this.modeState.kind === "normal" ? this.normalMode.pendingChord() : ""}${this.sharedActionResolver.pendingChord()}`;
    if (this.normalChordResolver.isPending()) return this.normalChordResolver.pendingChord();
    if (this.pendingUnmatched !== undefined) return this.pendingUnmatched.direction === "forward" ? "]" : "[";
    return this.modeState.kind === "normal" ? this.normalMode.pendingChord() : "";
  }

  // Zed: key dispatch normally arrives through GPUI actions registered by
  // `vim::Vim::action` and key contexts from `vim::Vim::extend_key_context`.
  // The VSCode patch calls this direct key entry point instead.
  onKey(key: string): KeyResult {
    return this.onKeyInternal(key, { allowRemap: true });
  }

  async onKeyAsync(key: string, { clipboard }: { clipboard?: VimSystemClipboard } = {}): Promise<KeyResult> {
    return this.globalState.registers.withSystemClipboard(clipboard, async () => {
      await this.refreshSystemClipboardRegisterForKey(key);
      return this.onKeyInternal(key, { allowRemap: true });
    });
  }

  private async refreshSystemClipboardRegisterForKey(key: string): Promise<void> {
    const registerToRead = this.systemClipboardRegisterToReadForKey(key);
    if (registerToRead !== undefined) await this.globalState.registers.refreshSystemClipboardRegister(registerToRead.registerName);
  }

  private systemClipboardRegisterToReadForKey(key: string): { registerName: RegisterName | undefined } | undefined {
    if (this.activePending("insertRegister") !== undefined) {
      const registerName = parseRegisterName(key);
      return isSystemClipboardRegister(registerName) ? { registerName } : undefined;
    }
    if (this.modeState.kind === "search" && (key === "ctrl-v" || key === "ctrl-y")) {
      return { registerName: "+" };
    }

    if (this.modeState.kind === "normal") return this.normalMode.systemClipboardRegisterToReadForKey(key);
    if (this.isVisualMode()) return this.visualMode.systemClipboardRegisterToReadForKey(key);
    return undefined;
  }

  private onKeyInternal(key: string, { allowRemap }: { allowRemap: boolean }): KeyResult {
    const textBefore = this.editor.getText();
    const modeBefore = this.modeState.kind;
    const result = this.onKeyInternalImpl(key, { allowRemap });
    if (this.editor.getText() !== textBefore) {
      this.modelState.changeList.record(this.editor, { insertMode: modeBefore === "insert" });
    }
    return result;
  }

  private onKeyInternalImpl(key: string, { allowRemap }: { allowRemap: boolean }): KeyResult {
    if (!this.globalState.repeat.isReplaying()) this.globalState.repeat.maybeFinish({ mode: this.modeState.kind, isPending: this.isPending() });

    if (allowRemap && this.shouldResolveRemap()) {
      const resolution = this.remapResolver.handleKey(this.currentRemapMode(), key);
      switch (resolution.kind) {
        case "pending":
          return "handled";
        case "matched":
          this.executeRemapping(resolution.mapping);
          return "handled";
        case "matchedWithReplay":
          this.executeRemapping(resolution.mapping);
          for (const replayKey of resolution.keys) this.onKeyInternal(replayKey, { allowRemap: true });
          return "handled";
        case "replay":
          this.replayTimedOutRemapKeys(resolution.keys);
          return "handled";
        case "handled":
          return "handled";
        case "noMatch":
          break;
      }
    }

    const pendingResult = this.handlePendingKey(key);
    if (pendingResult !== undefined) return pendingResult;
    if (this.isEscape(key)) return "not-handled";

    this.recordMacroKey(key);

    if (this.isMotionMode() && !this.modeIsExpectingRegisterName() && this.shouldResolveSharedAction(key)) {
      const sharedResolution = this.sharedActionResolver.handleKey(key);
      switch (sharedResolution.kind) {
        case "pending":
          if (!this.globalState.repeat.isReplaying()) {
            this.globalState.repeat.maybeStart(key, { mode: this.modeState.kind, pendingChord: this.normalMode.pendingChord() });
            this.globalState.repeat.recordKey(key);
          }
          return "handled";
        case "action":
          if (!this.globalState.repeat.isReplaying()) {
            this.globalState.repeat.maybeStart(key, { mode: this.modeState.kind, pendingChord: this.normalMode.pendingChord() });
            this.globalState.repeat.recordKey(key);
          }
          this.handleSharedAction(sharedResolution.action);
          return "handled";
        case "cancelled":
          if (!this.globalState.repeat.isReplaying()) this.globalState.repeat.recordKey(key);
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
      this.pendingStack.push({ type: "mark" });
      return "handled";
    }

    if (this.modeState.kind === "normal" && (!this.normalMode.isPending() || this.normalMode.pendingOperatorName() !== undefined) && (key === "'" || key === "`")) {
      this.pendingStack.push({ type: "jump", line: key === "'" });
      return "handled";
    }

    if (this.modeState.kind === "normal" && !this.normalMode.hasPendingNonCount() && (key === "]" || key === "[")) {
      this.pendingUnmatched = {
        direction: key === "]" ? "forward" : "backward",
        count: this.takeCountForMotion(1),
      };
      return "handled";
    }

    if (!this.globalState.repeat.isReplaying()
      && this.modeState.kind === "normal"
      && key === "."
      && (!this.normalMode.hasPendingNonCount() || this.normalMode.hasOnlySelectedRegisterPending())) {
      this.globalState.repeat.replay(this.normalMode.takeCountForRepeat(), {
        registerName: this.normalMode.takeSelectedRegisterForRepeat(),
        runKey: key => this.onKey(key),
        runVisualAction: (selection, action) => this.replayVisualAction(selection, action),
      });
      return "handled";
    }

    if (!this.globalState.repeat.isReplaying() && this.modeState.kind === "normal" && key === "." && this.normalMode.hasPendingNonCount()) {
      this.globalState.repeat.cancelCurrent();
    }

    if (!this.globalState.repeat.isReplaying()) {
      this.globalState.repeat.maybeStart(key, { mode: this.modeState.kind, pendingChord: this.normalMode.pendingChord() });
      this.globalState.repeat.recordKey(key);
    }

    if (this.modeState.kind === "insert") {
      const handler = this.insertKeyHandlers.get(key);
      if (handler !== undefined) return handler();
      const text = insertTextForKey(key);
      if (text !== undefined) {
        insertText(this.editor, text, this.insertEditOptions());
        this.insertRepeatText += text;
        return "handled";
      }
      return "not-handled";
    }

    if (this.modeState.kind === "replace") {
      const handler = this.replaceKeyHandlers.get(key);
      if (handler !== undefined) return handler();
      const text = insertTextForKey(key);
      if (text !== undefined) {
        replaceModeText(this.editor, text, 1, this.insertEditOptions());
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
      this.setMode("command");
      return "handled";
    }

    if (this.isVisualMode()) {
      const modeBefore = this.modeState.kind;
      const result = this.visualMode.onKey(key);
      return this.applyVisualResult(result, modeBefore);
    }

    if (this.modeState.kind !== "normal") {
      return "not-handled";
    }

    if (key === "v") {
      this.enterVisualMode("charwise", "visual");
      return "handled";
    }

    if (key === "V") {
      this.enterVisualMode("linewise", "visualLine");
      return "handled";
    }

    if (key === "ctrl-v") {
      this.enterVisualMode("blockwise", "visualBlock");
      return "handled";
    }

    if (key === "R") {
      this.enterReplaceMode({ count: this.normalMode.takeCountForMotion(1), separator: "" });
      return "handled";
    }

    return this.applyNormalResult(this.normalMode.onKey(key));
  }

  private handlePendingKey(key: string): KeyResult | undefined {
    if (this.activePending("digraph") !== undefined) {
      this.handlePendingDigraphKey(key);
      return "handled";
    }

    if (this.activePending("literal") !== undefined) {
      return this.handlePendingLiteralKey(key);
    }

    if (this.activePending("insertRegister") !== undefined) {
      this.handlePendingInsertRegisterKey(key);
      return "handled";
    }

    if (this.isEscape(key)) {
      if (!this.shouldHandleEscapeKey()) return undefined;
      this.recordEscapeKey();
      this.handleEscapeKey();
      return "handled";
    }

    const macroResult = this.handlePendingMacroKey(key);
    if (macroResult !== undefined) return macroResult;

    if (this.pendingCommand !== undefined) {
      this.handlePendingCommandKey(key);
      return "handled";
    }

    if (this.globalState.search.isPending()) {
      if (!this.shouldHandleSearchKey(key)) return "not-handled";
      this.recordRepeatKey(key);
      if (key === "ctrl-v" || key === "ctrl-y") {
        this.globalState.search.appendText(this.globalState.registers.read("+"), this.editor);
        return "handled";
      }
      const originMode = this.searchOriginMode ?? "normal";
      const motion = this.globalState.search.handleKey(key, this.globalState.registers, this.editor);
      if (motion !== undefined) {
        this.searchOriginMode = undefined;
        this.setMode(originMode === "visual" || originMode === "visualLine" || originMode === "visualBlock" ? originMode : "normal");
        this.applyMotion(motion, 1);
        this.editor.clearSearchHighlights();
      } else if (!this.globalState.search.isPending()) {
        this.searchOriginMode = undefined;
        this.setMode(originMode === "visual" || originMode === "visualLine" || originMode === "visualBlock" ? originMode : "normal");
      }
      return "handled";
    }

    if (this.activeFind() !== undefined) {
      this.recordRepeatKey(key);
      this.handlePendingFindKey(key);
      return "handled";
    }

    const pendingMark = this.activePending("mark");
    if (this.modeState.kind === "normal" && pendingMark !== undefined) {
      this.popPending("mark");
      this.modelState.marks.createMark(this.editor, key);
      return "handled";
    }

    const pendingJump = this.activePending("jump");
    if (this.modeState.kind === "normal" && pendingJump !== undefined) {
      this.popPending("jump");
      const motion = this.modelState.marks.jumpMotion(this.editor, key, { line: pendingJump.line });
      if (motion !== undefined) this.applyMotion(motion, 1);
      return "handled";
    }

    if (this.modeState.kind === "normal" && this.pendingUnmatched !== undefined) {
      const pending = this.pendingUnmatched;
      this.pendingUnmatched = undefined;
      if (key === "space") {
        this.insertEmptyLines(pending.direction === "backward" ? "above" : "below", pending.count);
        return "handled";
      }
      this.applyMotion(
        pending.direction === "forward"
          ? { type: "unmatchedForward", char: key }
          : { type: "unmatchedBackward", char: key },
        pending.count);
      return "handled";
    }

    return undefined;
  }

  private insertEmptyLines(side: "above" | "below", count: number): void {
    const selections = this.editor.getSelections();
    const edits: TextEdit[] = [];
    const selectionsAfter: ReturnType<typeof charwiseSelection>[] = [];
    for (const selection of selections) {
      const head = selectionHead(selection);
      const editPosition = emptyLineInsertPosition(this.editor, head, side);
      edits.push({ range: { start: editPosition, end: editPosition }, text: "\n".repeat(count) });
      const row = side === "above" ? head.row + count : head.row;
      selectionsAfter.push(charwiseSelection({ row, column: head.column }));
    }
    this.editor.applyEdits(edits, selectionsAfter);
  }

  private handlePendingMacroKey(key: string): KeyResult | undefined {
    const pendingRecordRegister = this.activePending("recordRegister");
    if (this.modeState.kind === "normal" && pendingRecordRegister !== undefined) {
      this.popPending("recordRegister");
      this.globalState.macro.startRecording(key);
      return "handled";
    }

    const pendingReplayRegister = this.activePending("replayRegister");
    if (this.modeState.kind === "normal" && pendingReplayRegister !== undefined) {
      this.popPending("replayRegister");
      this.recordMacroKey(key);
      this.globalState.macro.replayRegisterKey(key, pendingReplayRegister.count, key => this.onKey(key));
      return "handled";
    }

    if (this.modeState.kind === "normal" && this.globalState.macro.isRecording() && key === "q") {
      this.globalState.macro.stopRecording();
      return "handled";
    }

    if (this.modeState.kind === "normal" && key === "q") {
      this.pendingStack.push({ type: "recordRegister" });
      return "handled";
    }

    if (this.modeState.kind === "normal" && key === "@") {
      this.recordMacroKey(key);
      this.pendingStack.push({ type: "replayRegister", count: this.normalMode.takeCountForMotion(1) });
      return "handled";
    }

    if (this.modeState.kind === "normal" && key === "Q") {
      this.recordMacroKey(key);
      this.globalState.macro.replayLast(this.normalMode.takeCountForMotion(1), key => this.onKey(key));
      return "handled";
    }

    return undefined;
  }

  private handleEscapeKey(): void {
    this.clearPendingStateForEscape();
    if (this.isVisualMode()) {
      const selection = this.editor.getSelections()[0];
      if (selection !== undefined) this.modelState.marks.setVisualSelectionMarks(this.editor, selection);
      this.visualMode.exit();
      this.setMode("normal");
      return;
    }
    if (this.modeState.kind === "normal" && this.hasMultipleCursorsOrSelection()) {
      this.collapseToFirstCursor();
      return;
    }
    if (this.modeState.kind === "search" || this.modeState.kind === "command") {
      this.setMode("normal");
      return;
    }
    if (this.modeState.kind !== "normal") {
      const modeBeforeEscape = this.modeState.kind;
      if (modeBeforeEscape === "insert" || modeBeforeEscape === "replace") {
        this.finishInsertOrReplaceSession(modeBeforeEscape);
      }
      enterNormalMode(this.editor, { moveLeft: modeBeforeEscape === "insert" || modeBeforeEscape === "replace" });
      if (modeBeforeEscape === "insert" && this.insertOrigin === "visualBlock") {
        this.collapseToFirstCursor();
      }
      this.insertOrigin = undefined;
      this.setMode("normal");
      if (modeBeforeEscape === "insert" || modeBeforeEscape === "replace") {
        this.editor.finishUndoTransaction(this.editor.getSelections());
      }
    }
  }

  private clearPendingStateForEscape(): void {
    this.clearPendingGrammar({ closeSearchHighlights: true });
  }

  private recordEscapeKey(): void {
    this.recordRepeatKey("<escape>");
    this.recordMacroKey("<escape>");
  }

  private recordRepeatKey(key: string): void {
    if (!this.globalState.repeat.isReplaying()) this.globalState.repeat.recordKey(key);
  }

  private recordMacroKey(key: string): void {
    if (!this.globalState.macro.isReplaying() && !this.globalState.repeat.isReplaying()) this.globalState.macro.recordKey(key);
  }

  private applyVisualResult(result: VisualKeyResult, modeBefore: VimMode["kind"]): KeyResult {
    if (result.repeatAction !== undefined && !this.globalState.repeat.isReplaying()) {
      this.globalState.repeat.recordVisualAction(result.repeatAction.selection, result.repeatAction.action);
    }
    if (result.pendingRepeatChange !== undefined && !this.globalState.repeat.isReplaying()) {
      this.pendingVisualRepeatChange = result.pendingRepeatChange;
    }
    if (result.enterInsert) {
      this.enterInsertMode({ origin: modeBefore });
    } else if (result.nextMode !== undefined) {
      this.setMode(result.nextMode);
    } else if (result.exitVisual) {
      this.setMode("normal");
    }
    return result.keyResult;
  }

  private applyNormalResult(result: NormalKeyResult): KeyResult {
    if (result.enterInsert) {
      this.enterInsertMode({
        origin: this.modeState.kind,
        count: result.insertCount,
        separator: result.insertSeparator,
      });
    }
    return result.keyResult;
  }

  private enterVisualMode(kind: Parameters<VisualMode["enter"]>[0], mode: Extract<VisualResultMode, "visual" | "visualLine" | "visualBlock">): void {
    this.visualMode.enter(kind);
    this.setMode(mode);
  }

  private enterInsertMode({ origin, count = 1, separator = "" }: { origin: VimMode["kind"]; count?: number; separator?: string }): void {
    this.modelState.marks.setBuiltinMark(".", selectionHead(this.editor.getSelections()[0]));
    this.insertOrigin = origin;
    this.startInsertOrReplaceSession({ count, separator });
    this.setMode("insert");
  }

  private enterReplaceMode({ count, separator }: { count: number; separator: string }): void {
    this.startInsertOrReplaceSession({ count, separator });
    this.editor.setCursorStyle("block");
    this.setMode("replace");
  }

  private setMode(kind: Exclude<VimMode["kind"], "select">): void {
    this.modeState = { dialect: this.modeState.dialect, kind };
  }

  private enterInsertAtPrevious(): void {
    const position = this.modelState.lastInsertPosition;
    if (position !== undefined) this.editor.setSelections([charwiseSelection(position)]);
    this.editor.setCursorStyle("line");
    this.enterInsertMode({ origin: this.modeState.kind, count: this.takeCountForMotion(1) });
  }

  private startInsertOrReplaceSession({ count, separator }: { count: number; separator: string }): void {
    this.insertRepeatCount = count;
    this.insertRepeatText = "";
    this.insertRepeatSeparator = separator;
  }

  private finishInsertOrReplaceSession(mode: "insert" | "replace"): void {
    this.modelState.lastInsertPosition = selectionHead(this.editor.getSelections()[0]);
    this.modelState.marks.setBuiltinMark("^", this.modelState.lastInsertPosition);
    const pendingVisualRepeatChange = this.pendingVisualRepeatChange;
    if (pendingVisualRepeatChange !== undefined && !this.globalState.repeat.isReplaying()) {
      this.globalState.repeat.recordVisualAction(pendingVisualRepeatChange.selection, { type: "change", insertedText: this.insertRepeatText });
    }
    this.pendingVisualRepeatChange = undefined;
    if (this.insertRepeatCount <= 1 || this.insertRepeatText.length === 0) {
      this.clearInsertOrReplaceSession();
      return;
    }
    const repeatedText = Array.from({ length: this.insertRepeatCount - 1 }, () => `${this.insertRepeatSeparator}${this.insertRepeatText}`).join("");
    if (mode === "replace") replaceModeText(this.editor, repeatedText, 1, this.insertEditOptions());
    else insertText(this.editor, repeatedText, this.insertEditOptions());
    this.modelState.lastInsertPosition = selectionHead(this.editor.getSelections()[0]);
    this.clearInsertOrReplaceSession();
  }

  private clearInsertOrReplaceSession(): void {
    this.insertRepeatCount = 1;
    this.insertRepeatText = "";
    this.insertRepeatSeparator = "";
  }

  private insertEditOptions() {
    return keepUndoTransactionOpen();
  }

  private startInsertDigraph(): KeyResult {
    this.pendingStack.push({ type: "digraph", target: "insert" });
    return "handled";
  }

  private startReplaceDigraph(): KeyResult {
    this.pendingStack.push({ type: "digraph", target: "replace" });
    return "handled";
  }

  private startPlainLiteral(): KeyResult {
    this.pendingStack.push({ type: "literal", kind: "plain" });
    return "handled";
  }

  private startInsertRegister(): KeyResult {
    this.pendingStack.push({ type: "insertRegister" });
    return "handled";
  }

  private deleteInsertPreviousWord(): KeyResult {
    deleteToPreviousWord(this.editor, this.insertEditOptions());
    return "handled";
  }

  private deleteInsertLineStart(): KeyResult {
    deleteToBeginningOfLine(this.editor, this.insertEditOptions());
    return "handled";
  }

  private insertCharacterFromAdjacentLine(side: "above" | "below"): KeyResult {
    insertCharacterFromAdjacentLine(this.editor, side, this.insertEditOptions());
    return "handled";
  }

  private shouldResolveRemap(): boolean {
    if (this.remapResolver.isPending()) return true;
    return this.activeFind() === undefined
      && this.pendingUnmatched === undefined
      && !this.sharedActionResolver.isPending()
      && !this.normalChordResolver.isPending()
      && !this.globalState.search.isPending()
      && this.pendingCommand === undefined
      && this.pendingStack.length === 0;
  }

  private currentRemapMode() {
    return remapModeForVimMode(this.modeState.kind, {
      operatorPending: this.modeState.kind === "normal" && this.normalMode.pendingOperatorName() !== undefined,
    });
  }

  private replayTimedOutRemapKeys(keys: readonly string[]): void {
    keys.forEach((key, index) => {
      this.onKeyInternal(key, { allowRemap: index > 0 });
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
    const collapsed = collapseToPrimaryNormalCursor(this.editor.getSelections());
    if (collapsed.length > 0) this.editor.setSelections(collapsed);
  }

  private hasMultipleCursorsOrSelection(): boolean {
    return hasMultipleCursorsOrSelection(this.editor.getSelections());
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
      case "motion": {
        this.globalState.repeat.cancelCurrent();
        const motion = sharedMotionByKey.get(action.key);
        if (motion !== undefined) this.applyMotion(motion, this.takeCountForMotion(1));
        return;
      }
      case "normalGKey":
        if (this.modeState.kind === "normal") {
          this.normalMode.handleGKey(action.key);
        } else if (this.isVisualMode() && action.key === "J") {
          this.visualMode.joinSelections({ insertWhitespace: false });
          this.setMode("normal");
        } else if (this.isVisualMode() && (action.key === "u" || action.key === "U" || action.key === "~")) {
          this.visualMode.convertSelections(convertTargetForKey(action.key));
          this.setMode("normal");
        }
        return;
      case "insertAtPrevious":
        if (this.modeState.kind === "normal") this.enterInsertAtPrevious();
        return;
      case "page": {
        this.globalState.repeat.cancelCurrent();
        const selections = this.editor.moveByPages(
          action.key === "ctrl-u" || action.key === "ctrl-b" ? "up" : "down",
          this.takeCountForMotion(1),
          { halfPage: action.key === "ctrl-u" || action.key === "ctrl-d", extend: this.isVisualMode() });
        if (selections !== undefined) this.editor.setSelections(selections);
        if (this.isVisualMode()) this.visualMode.adoptSelectionFromHost();
        return;
      }
      case "restoreVisualSelection": {
        this.globalState.repeat.cancelCurrent();
        const nextMode = this.visualMode.restoreLastSelection();
        if (nextMode !== undefined) this.modeState = { dialect: this.modeState.dialect, kind: nextMode };
        return;
      }
      case "searchSelection":
        this.applySearchSelection({ reversed: action.reversed, count: this.takeCountForMotion(1) });
        return;
      case "incrementStep": {
        const count = this.takeCountForMotion(1);
        const delta = (action.direction === "increment" ? 1 : -1) * count;
        incrementNumbers(this.editor, delta, delta);
        if (this.isVisualMode()) {
          this.visualMode.clearState();
          this.editor.setCursorStyle("block");
          this.setMode("normal");
        }
        return;
      }
      case "changeList": {
        this.globalState.repeat.cancelCurrent();
        const position = this.modelState.changeList.move(this.takeCountForMotion(1), action.direction);
        if (position !== undefined) this.editor.setSelections([charwiseSelection(position)]);
        return;
      }
      case "multiCursor": {
        this.globalState.repeat.cancelCurrent();
        const count = this.takeCountForMotion(1);
        for (let index = 0; index < count; index++) {
          this.editor.executeNativeCommand(action.command, [], { syncSelectionAfter: true });
        }
        return;
      }
      case "native":
        this.globalState.repeat.cancelCurrent();
        this.editor.executeNativeCommand(action.command);
        this.syncFromEditorState({ render: false });
        return;
    }
  }

  private handleNormalChordAction(action: NormalChordAction): void {
    switch (action.type) {
      case "host":
      case "z": {
        handleHostAction(this.editor, action, defaultValue => this.takeCountForMotion(defaultValue));
        this.syncFromEditorState({ render: false });
        return;
      }

    }
  }

  private handleSharedMotionKey(key: string): boolean {
    if (key === "n" || key === "N") {
      const motion = this.globalState.search.repeat({ reversed: key === "N" });
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
          this.pendingStack.push({ type: "findForward", before: false, count });
          return true;
        case "t":
          this.pendingStack.push({ type: "findForward", before: true, count });
          return true;
        case "F":
          this.pendingStack.push({ type: "findBackward", after: false, count });
          return true;
        case "T":
          this.pendingStack.push({ type: "findBackward", after: true, count });
          return true;
      }
    }

    if (key === "/" || key === "?") {
      this.searchOriginMode = this.modeState.kind;
      this.globalState.search.start(key === "?", this.editor);
      this.setMode("search");
      return true;
    }

    if (key === "*" || key === "#") {
      const backwards = key === "#";
      const motion = this.modeState.kind === "normal"
        ? searchUnderCursorMotion(this.editor, this.globalState.search, this.globalState.registers, { backwards })
        : this.visualSearchMotion({ backwards });
      if (motion !== undefined) {
        if (this.isVisualMode()) {
          this.visualMode.clearState();
          this.editor.setCursorStyle("block");
          this.setMode("normal");
        }
        this.applyMotion(motion, this.takeCountForMotion(1));
        this.editor.clearSearchHighlights();
      }
      return true;
    }

    return false;
  }

  private visualSearchMotion({ backwards }: { backwards: boolean }): Motion | undefined {
    const selection = this.editor.getSelections()[0];
    if (selection === undefined) return undefined;
    const query = this.editor.getText(rangeOfSelection(selection));
    if (query.length === 0) return undefined;
    return this.globalState.search.setLast(query, backwards, this.globalState.registers, this.editor, { regex: false });
  }

  private handlePendingFindKey(key: string): void {
    const pending = this.popFind();
    if (pending === undefined) return;
    if (key === "ctrl-k") {
      this.pendingStack.push({ type: "digraph", target: "find", pending });
      return;
    }
    this.applyFindChar(pending, keyForInput(key));
  }

  private applyFindChar(pending: PendingFindOperator, char: string): void {
    const motion: FindMotion = pending.type === "findForward"
      ? { type: "findForward", before: pending.before, char }
      : { type: "findBackward", after: pending.after, char };
    this.globalState.lastFind = motion;
    this.applyMotion(motion, pending.count);
  }

  private repeatFind({ reversed }: { reversed: boolean }): void {
    if (this.globalState.lastFind === undefined) return;
    this.applyMotion(reversed ? reverseFindMotion(this.globalState.lastFind) : this.globalState.lastFind, this.takeCountForMotion(1));
  }

  private handlePendingDigraphKey(key: string): void {
    const pending = this.activePending("digraph");
    if (pending === undefined) return;
    if (this.isEscape(key)) {
      this.popPending("digraph");
      return;
    }
    const input = keyForInput(key);
    if (pending.first === undefined) {
      this.replaceActiveDigraph({ ...pending, first: input });
      return;
    }

    this.popPending("digraph");
    const text = lookupDigraph(pending.first, input);
    switch (pending.target) {
      case "insert":
        insertText(this.editor, text, this.insertEditOptions());
        this.insertRepeatText += text;
        return;
      case "replace":
        replaceModeText(this.editor, text, 1, this.insertEditOptions());
        this.insertRepeatText += text;
        return;
      case "find":
        this.applyFindChar(pending.pending, text);
        return;
    }
  }

  private handlePendingLiteralKey(key: string): KeyResult | undefined {
    const pending = this.activePending("literal");
    if (pending === undefined) return "handled";

    if (pending.kind === "plain") {
      if (key === "x") {
        return this.handlePendingLiteralKeyWithState({ type: "literal", kind: "hex", digits: "", maxDigits: 2 });
      }
      if (key === "u" || key === "U") {
        return this.handlePendingLiteralKeyWithState({ type: "literal", kind: "hex", digits: "", maxDigits: key === "u" ? 4 : 8 });
      }
      if (/^[0-9]$/.test(key)) {
        return this.handlePendingLiteralKeyWithState({ type: "literal", kind: "decimal", digits: key });
      }
      this.popPending("literal");
      this.insertLiteralText(literalTextForKey(key));
      return "handled";
    }

    if (pending.kind === "decimal") {
      if (/^[0-9]$/.test(key)) {
        return this.handlePendingLiteralKeyWithState({ ...pending, digits: pending.digits + key });
      }
      this.popPending("literal");
      this.insertLiteralCodepoint(Number(pending.digits));
      if (this.isEscape(key)) {
        this.recordEscapeKey();
        this.handleEscapeKey();
        return "handled";
      }
      const text = insertTextForKey(key);
      if (text !== undefined) this.insertLiteralText(text);
      return "handled";
    }

    if (/^[0-9a-fA-F]$/.test(key) && pending.digits.length + 1 < pending.maxDigits) {
      return this.handlePendingLiteralKeyWithState({ ...pending, digits: pending.digits + key });
    }
    if (/^[0-9a-fA-F]$/.test(key)) {
      this.popPending("literal");
      this.insertLiteralCodepoint(Number.parseInt(pending.digits + key, 16));
      return "handled";
    }
    this.popPending("literal");
    if (pending.digits.length > 0) this.insertLiteralCodepoint(Number.parseInt(pending.digits, 16));
    const text = insertTextForKey(key);
    if (text !== undefined) this.insertLiteralText(text);
    return "handled";
  }

  private handlePendingLiteralKeyWithState(next: PendingLiteralOperator): KeyResult {
    this.replaceActiveLiteral(next);
    if (next.kind === "decimal" && next.digits.length >= 3) {
      this.popPending("literal");
      this.insertLiteralCodepoint(Number(next.digits));
    }
    return "handled";
  }

  private insertLiteralCodepoint(codepoint: number): void {
    this.insertLiteralText(String.fromCodePoint(Math.max(0, codepoint)));
  }

  private insertLiteralText(text: string): void {
    if (this.modeState.kind === "replace") {
      replaceModeText(this.editor, text, 1, this.insertEditOptions());
    } else {
      insertText(this.editor, text, this.insertEditOptions());
    }
    this.insertRepeatText += text;
  }

  private handlePendingInsertRegisterKey(key: string): void {
    this.popPending("insertRegister");
    if (this.isEscape(key)) return;
    const registerName = parseRegisterName(key);
    if (registerName === undefined) return;
    insertText(this.editor, this.globalState.registers.read(registerName), this.insertEditOptions());
  }

  private handlePendingCommandKey(key: string): void {
    if (this.pendingCommand === undefined) return;
    if (key === "enter") {
      const command = this.pendingCommand;
      this.pendingCommand = undefined;
      this.setMode("normal");
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
      case "delete": {
        const range = this.rangeForRecordedSelection(selection);
        if (range === undefined) return;
        this.editor.applyEdits([{ range, text: "" }], [charwiseSelection(normalCursorPosition(this.editor, range.start))]);
        return;
      }
      case "change": {
        const range = this.rangeForRecordedSelection(selection);
        if (range === undefined) return;
        this.editor.applyEdits([{ range, text: action.insertedText }], [charwiseSelection(range.start)]);
        return;
      }
    }
  }

  private rangeForRecordedSelection(selection: RecordedSelection): TextRange | undefined {
    const start = selectionHead(this.editor.getSelections()[0]);
    switch (selection.type) {
      case "none":
        return undefined;
      case "charwise":
        return {
          start,
          end: selection.rowDelta === 0
            ? this.charwiseRepeatEnd(start, selection.columnDelta)
            : this.charwiseMultilineRepeatEnd(start, selection),
        };
      case "visualLine": {
        const endRow = Math.min(this.editor.lineCount() - 1, start.row + selection.rows);
        return { start: { row: start.row, column: 0 }, end: { row: endRow, column: this.editor.lineLength(endRow) } };
      }
    }
  }

  private charwiseRepeatEnd(start: ReturnType<typeof selectionHead>, columnDelta: number): ReturnType<typeof selectionHead> {
    const lineLength = this.editor.lineLength(start.row);
    if (start.column + columnDelta <= lineLength) {
      return { row: start.row, column: start.column + columnDelta };
    }
    if (start.row + 1 < this.editor.lineCount()) {
      return { row: start.row + 1, column: 0 };
    }
    return { row: start.row, column: lineLength };
  }

  private charwiseMultilineRepeatEnd(start: ReturnType<typeof selectionHead>, selection: Extract<RecordedSelection, { type: "charwise" }>): ReturnType<typeof selectionHead> {
    const targetRow = Math.min(start.row + selection.rowDelta, this.editor.lineCount() - 1);
    if (targetRow === start.row) {
      return { row: start.row, column: Math.min(start.column + 1, this.editor.lineLength(start.row)) };
    }
    return {
      row: targetRow,
      column: Math.min(selection.endColumn, this.editor.lineLength(targetRow)),
    };
  }

  private applySearchSelection({ reversed, count }: { reversed: boolean; count: number }): void {
    const includeStart = this.modeState.kind === "normal";
    const range = this.globalState.search.matchRangeForSelection(this.editor, { reversed, count, includeStart });
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

function emptyLineInsertPosition(
  editor: { lineLength: (row: number) => number },
  head: Position,
  side: "above" | "below"
): Position {
  return side === "above" ? { row: head.row, column: 0 } : { row: head.row, column: editor.lineLength(head.row) };
}

function keyForInput(key: string): string {
  return key === "space" ? " " : key;
}

function literalTextForKey(key: string): string {
  if (key === "tab") return "\t";
  if (key === "enter") return "\n";
  if (key === "escape" || key === "<escape" || key === "<escape>") return "\u001b";
  const control = /^ctrl-(.)$/.exec(key);
  if (control !== null) {
    if (control[1] === "j") return "\u0000";
    if (control[1] === "[") return "\u001b";
    return String.fromCodePoint(control[1].toLowerCase().charCodeAt(0) - "a".charCodeAt(0) + 1);
  }
  return keyForInput(key);
}

function insertTextForKey(key: string): string | undefined {
  if (key === "space") return " ";
  if (key === "enter") return "\n";
  if (key === "\n") return "\n";
  return key.length === 1 ? key : undefined;
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
    case "ctrl-n":
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
