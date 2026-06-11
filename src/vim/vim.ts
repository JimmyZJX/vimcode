// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `vim::Vim`
// - translated concepts: main Vim state holder and high-level mode dispatch
// - intentional differences: GPUI action registration is replaced by direct key dispatch
//   from the VSCode patch / tests.

import { LineRange, executeCommand } from "./command.js";
import { AmbiguousRemapConflict, NoopKey, NormalizedRemapping, RemapResolver, VimConfiguration, defaultVimConfiguration, mergeVimConfiguration, remapModeForVimMode } from "./config.js";
import type { RemapWhenEvaluator } from "./config.js";
import { lookupDigraph } from "./digraph.js";
import { collapseSelectionsToNormalCursors, collapseToPrimaryNormalCursor, hasMultipleCursorsOrSelection, reconcileCursorState } from "./editor_state_sync.js";
import { VimEditorCapabilities, keepUndoTransactionOpen, normalCursorPosition } from "./editor.js";
import { enterNormalMode, insertCharacterFromAdjacentLine, insertText, deleteToBeginningOfLine, deleteToPreviousWord } from "./insert.js";
import { resolveVimAction, VimAction, VimKeymapContext, VimKeymapPhase, VimKeymapResolver } from "./keymap.js";
import { FindMotion, Motion, reverseFindMotion } from "./motion.js";
import { NormalMode } from "./normal.js";
import type { NormalKeyResult } from "./normal.js";
import { VimOperatorStack, WaitingInput, convertTargetForPending, isRangeOperatorContext, isSelfEscapingWaitingInput, isTopLevelPendingOperator, pendingOperatorStatus } from "./operator.js";
import type { RangeOperator } from "./operator_target.js";
import type {
  PendingFindOperator,
  PendingLiteralOperator,
  TopLevelPendingOperator,
} from "./operator.js";
import { RecordedSelection, VisualRepeatAction } from "./normal/repeat.js";
import { incrementNumbers } from "./normal/increment.js";
import { isSearchInputKey, searchUnderCursorMotion } from "./normal/search.js";
import { RegisterName, isSystemClipboardRegister, parseRegisterName } from "./registers.js";
import type { VimSystemClipboard } from "./registers.js";
import { ConvertTarget } from "./normal/convert.js";
import { indentRanges } from "./normal/indent.js";
import { replaceModeText } from "./replace.js";
import { KeyDispatchResult, KeyResult, Position, TextEdit, TextRange, VimMode, charwiseSelection, isVisualModeKind, rangeOfSelection, selectionHead } from "./state.js";
import { VisualMode, visualKindForMode } from "./visual.js";
import type { VisualKeyResult, VisualResultMode } from "./visual.js";
import { VimGlobalState, VimModelState } from "./vim_state.js";

export type VimStatus = {
  mode: VimMode["kind"];
  pending: boolean;
  operator: RangeOperator["type"] | undefined;
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

export type KeyPlan = { run: (env?: { clipboard?: VimSystemClipboard }) => Promise<void> };

const alwaysActiveRemapWhen: RemapWhenEvaluator = () => true;

export { VimGlobalState, VimModelState };

// Zed: `vim::Vim`. This class is the local main state holder; GPUI
// entity/window fields are intentionally replaced by the injected
// `VimEditorCapabilities`.
export class Vim {
  private modeState: VimMode = { dialect: "vim", kind: "normal" };
  private readonly keymapResolver = new VimKeymapResolver();
  private readonly operatorStack = new VimOperatorStack();
  private modelState: VimModelState;
  private selectedRegister: RegisterName | undefined;
  private countBuffer = "";
  private configuration: VimConfiguration = defaultVimConfiguration;
  private remapResolver = new RemapResolver(this.configuration);
  private searchOriginMode: VimMode["kind"] | undefined;
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
    this.normalMode = new NormalMode(editor, this.globalState.registers, {
      get: () => this.selectedRegister,
      take: () => this.takeSelectedRegister(),
      clear: () => this.clearSelectedRegister(),
    }, {
      get: () => this.countBuffer,
      append: key => this.appendCountKey(key),
      take: defaultValue => defaultValue === undefined ? this.takeCount(undefined) : this.takeCount(defaultValue),
      clear: () => this.clearCount(),
    }, this.operatorStack);
    this.visualMode = new VisualMode(editor, this.globalState.registers, {
      get: () => this.selectedRegister,
      take: () => this.takeSelectedRegister(),
      clear: () => this.clearSelectedRegister(),
    }, {
      get: () => this.countBuffer,
      append: key => this.appendCountKey(key),
      take: defaultValue => defaultValue === undefined ? this.takeCount(undefined) : this.takeCount(defaultValue),
      clear: () => this.clearCount(),
    }, this.operatorStack, this.configuration);
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

  private takeSelectedRegister(): RegisterName | undefined {
    const registerName = this.selectedRegister;
    this.selectedRegister = undefined;
    return registerName;
  }

  private clearSelectedRegister(): void {
    this.selectedRegister = undefined;
  }

  private takeCount(defaultValue: number): number;
  private takeCount(defaultValue: undefined): number | undefined;
  private takeCount(defaultValue: number | undefined): number | undefined {
    if (this.countBuffer.length === 0) return defaultValue;
    const count = Number(this.countBuffer);
    this.countBuffer = "";
    return count;
  }

  private appendCountKey(key: string): void {
    this.countBuffer += key;
  }

  private clearCount(): void {
    this.countBuffer = "";
  }

  ambiguousRemapConflicts(): readonly AmbiguousRemapConflict[] {
    return this.remapResolver.ambiguousConflicts();
  }

  handleKeyOverride(key: string): boolean | undefined {
    return this.remapResolver.handleKeyOverride(key);
  }

  /** Test helper for asserting the synchronous key ownership decision.
      Production code should call [handleKey] and run the returned [KeyPlan]. */
  wouldHandleKeyForTest(key: string): boolean {
    return this.handleKey(key) !== null;
  }

  handleKey(key: string, { remapWhen = alwaysActiveRemapWhen }: { remapWhen?: RemapWhenEvaluator } = {}): KeyPlan | null {
    if (!this.ownsKey(key, remapWhen)) return null;
    return {
      run: async ({ clipboard }: { clipboard?: VimSystemClipboard } = {}) => {
        await this.globalState.registers.withSystemClipboard(clipboard, async () => {
          await this.refreshSystemClipboardRegisterForKey(key);
          this.dispatchKey(key, { allowRemap: true, remapWhen });
        });
      },
    };
  }

  hasActiveRemapStartingWithOrPending(key: string, remapWhen: RemapWhenEvaluator = alwaysActiveRemapWhen): boolean {
    return this.remapResolver.isPending()
      || this.remapResolver.hasMappingStartingWith(this.currentRemapMode(), key, remapWhen);
  }

  private ownsKey(key: string, remapWhen: RemapWhenEvaluator): boolean {
    const handleOverride = this.handleKeyOverride(key);
    if (handleOverride !== undefined) return handleOverride;

    const pendingSearch = this.operatorStack.activeTopLevel("search");
    if (pendingSearch !== undefined) return isSearchInputKey(key);

    if (this.operatorStack.length > 0 || this.remapResolver.isPending()) return true;

    if (this.isEscape(key)) return this.shouldHandleEscapeKey();

    if (isCtrlKey(key)) {
      const isMapped = this.remapResolver.hasMappingStartingWith(this.currentRemapMode(), key, remapWhen);
      if (!isMapped) {
        return this.configuration.useCtrlKeys && isBuiltInCtrlKey(key);
      }
    }

    if (this.modeState.kind === "insert" || this.modeState.kind === "replace") {
      return this.shouldPrepareInsertOrReplaceKey(key, remapWhen);
    }

    return true;
  }

  private shouldPrepareInsertOrReplaceKey(key: string, remapWhen: RemapWhenEvaluator): boolean {
    return this.remapResolver.isPending()
      || this.remapResolver.hasMappingStartingWith(this.currentRemapMode(), key, remapWhen)
      || this.operatorStack.length > 0
      || key === "ctrl-k"
      || key === "ctrl-v"
      || key === "ctrl-r"
      || key === "ctrl-w"
      || key === "ctrl-u"
      || key === "ctrl-y"
      || key === "ctrl-e";
  }

  private shouldHandleEscapeKey(): boolean {
    return this.modeState.kind !== "normal"
      || this.hasMultipleCursorsOrSelection()
      || this.operatorStack.length > 0
      || this.keymapResolver.isPending()
      || this.remapResolver.isPending()
      || this.normalMode.isPending();
  }

  // External-state synchronization always ends in a canonical write-back: the
  // adopted Vim state is re-lowered through editor.setSelections so the native
  // selections, adapter cache, and rendered cursor cell agree with Vim after
  // every external event. Vim-sourced selection events are ignored by the
  // controller, so the write-back cannot feed back into this path.
  syncFromEditorState(): EditorSyncResult {
    const modeBeforeSync = this.modeState.kind;
    const selections = this.editor.getSelections();
    const reconciliation = reconcileCursorState(
      { selections },
      { mode: this.modeState, selections }
    );

    if (reconciliation.modeKind === "visual") {
      const visualSelection = reconciliation.selections.find(selection => selection.type === "charwise");
      const adopted = visualSelection !== undefined
        && this.visualMode.adoptSelection(visualSelection);
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
    const normalSelections = collapseSelectionsToNormalCursors(reconciliation.selections)
      .map(selection => {
        const normalSelection = charwiseSelection(normalCursorPosition(this.editor, selectionHead(selection)));
        return selection.goal === undefined ? normalSelection : { ...normalSelection, goal: selection.goal };
      });
    this.editor.setSelections(normalSelections);
    if (modeBeforeSync !== "search" && modeBeforeSync !== "command") {
      this.editor.setCursorStyle("block");
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

  syncFromUndoRedoState(): EditorSyncResult {
    return this.syncFromEditorState();
  }

  private clearPendingForModelSwitch(): void {
    this.clearPendingGrammar({ closeSearchHighlights: false });
  }

  private clearPendingForExternalModeChange(): void {
    this.clearPendingGrammar({ closeSearchHighlights: true });
  }

  private clearPendingGrammar({ closeSearchHighlights }: { closeSearchHighlights: boolean }): void {
    const pendingSearch = this.operatorStack.activeTopLevel("search");
    this.keymapResolver.clearPending();
    this.remapResolver.clearPending();
    this.globalState.search.clearPending(this.editor, pendingSearch, { restoreViewport: closeSearchHighlights });
    this.searchOriginMode = undefined;
    this.selectedRegister = undefined;
    this.countBuffer = "";
    if (closeSearchHighlights && pendingSearch !== undefined) this.editor.clearSearchHighlights();
    this.operatorStack.clear();
    this.normalMode.clearPending();
  }

  private isPending(): boolean {
    return this.operatorStack.length > 0 || this.selectedRegister !== undefined || this.countBuffer.length > 0 || this.keymapResolver.isPending() || this.remapResolver.isPending() || (this.modeState.kind === "normal" && this.normalMode.isPending());
  }

  private pendingChord(): string {
    const pendingOperator = this.operatorStack.top();
    if (pendingOperator?.type === "search") return this.globalState.search.pendingChord(pendingOperator);
    if (isTopLevelPendingOperator(pendingOperator)) return pendingOperatorStatus(pendingOperator);
    if (this.selectedRegister !== undefined) return `${this.modeState.kind === "normal" ? this.normalMode.pendingChord() : ""}\"${this.selectedRegister}`;
    if (this.remapResolver.isPending()) return this.remapResolver.pendingChord();
    if (this.keymapResolver.isPending()) return `${this.modeState.kind === "normal" ? this.normalMode.pendingChord() : ""}${this.keymapResolver.pendingChord()}`;
    return this.modeState.kind === "normal" ? this.normalMode.pendingChord() : "";
  }

  // Zed: key dispatch normally arrives through GPUI actions registered by
  // `vim::Vim::action` and key contexts from `vim::Vim::extend_key_context`.
  // The VSCode patch calls this direct key entry point instead.
  onKey(key: string): KeyDispatchResult {
    return this.dispatchKey(key, { allowRemap: true, remapWhen: alwaysActiveRemapWhen });
  }

  private async refreshSystemClipboardRegisterForKey(key: string): Promise<void> {
    const registerToRead = this.systemClipboardRegisterToReadForKey(key);
    if (registerToRead !== undefined) await this.globalState.registers.refreshSystemClipboardRegister(registerToRead.registerName);
  }

  private systemClipboardRegisterToReadForKey(key: string): { registerName: RegisterName | undefined } | undefined {
    if (this.operatorStack.activeTopLevel("insertRegister") !== undefined) {
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

  private dispatchKey(key: string, { allowRemap, remapWhen }: { allowRemap: boolean; remapWhen: RemapWhenEvaluator }): KeyDispatchResult {
    const textBefore = this.editor.getText();
    const modeBefore = this.modeState.kind;
    try {
      if (!this.globalState.repeat.isReplaying()) this.globalState.repeat.maybeFinish({ mode: this.modeState.kind, isPending: this.isPending() });

      const remapResult = this.dispatchRemapKey(key, { allowRemap, remapWhen });
      if (remapResult !== undefined) return remapResult;

      // Zed: `vim_mode == waiting` contexts. One classification of what the
      // operator stack is waiting for, dispatched at one place; the precedence
      // list lives in [VimOperatorStack.waitingInput]. Only the self-escaping
      // classes (insert digraph/literal/register) see the escape key; for all
      // other waiting input the central escape handling cancels first.
      const waiting = this.operatorStack.waitingInput(this.modeState.kind, key);
      if (waiting !== undefined && isSelfEscapingWaitingInput(waiting)) {
        return this.dispatchWaitingInput(waiting, key) ?? "native";
      }

      if (this.isEscape(key)) {
        if (!this.shouldHandleEscapeKey()) return "native";
        this.recordEscapeKey();
        this.handleEscapeKey();
        return "handled";
      }

      if (waiting !== undefined) {
        const waitingResult = this.dispatchWaitingInput(waiting, key);
        if (waitingResult !== undefined) return waitingResult;
      }

      const macroControlResult = this.handleMacroControlKey(key);
      if (macroControlResult !== undefined) return macroControlResult;

      // Recording is positionally uniform: macro keys and repeatable keys are
      // recorded once, before any keymap resolution. Whether a key actually
      // starts or extends a dot-repeat recording is decided by the repeat
      // state (change-initiating start keys, in-flight recordings), and
      // actions that are not repeatable cancel via their dispatch arms.
      this.recordMacroKey(key);
      this.recordRepeatableKey(key);

      const finiteKeymapResult = this.handleFiniteKeymapKey(key);
      if (finiteKeymapResult !== undefined) return finiteKeymapResult;

      const insertLikeResult = this.dispatchInsertLikeKey(key);
      if (insertLikeResult !== undefined) return insertLikeResult;

      const motionModeResult = this.dispatchMotionModeKey(key);
      if (motionModeResult !== undefined) return motionModeResult;

      const fallbackKeymapResult = this.dispatchFallbackKeymapKey(key);
      if (fallbackKeymapResult !== undefined) return fallbackKeymapResult;

      return this.dispatchModeFallbackKey(key);
    } finally {
      if (this.editor.getText() !== textBefore) {
        this.modelState.changeList.record(this.editor, { insertMode: modeBefore === "insert" });
      }
    }
  }

  private dispatchRemapKey(key: string, { allowRemap, remapWhen }: { allowRemap: boolean; remapWhen: RemapWhenEvaluator }): KeyResult | undefined {
    if (!(allowRemap && this.shouldResolveRemap())) return undefined;
    const resolution = this.remapResolver.handleKey(this.currentRemapMode(), key, remapWhen);
    switch (resolution.kind) {
      case "pending":
        return "handled";
      case "matched":
        this.executeRemapping(resolution.mapping, remapWhen);
        return "handled";
      case "matchedWithReplay":
        this.executeRemapping(resolution.mapping, remapWhen);
        for (const replayKey of resolution.keys) this.dispatchKey(replayKey, { allowRemap: true, remapWhen });
        return "handled";
      case "replay":
        this.replayTimedOutRemapKeys(resolution.keys, remapWhen);
        return "handled";
      case "handled":
        return "handled";
      case "noMatch":
        return undefined;
    }
  }

  private recordRepeatableKey(key: string): void {
    if (this.globalState.repeat.isReplaying()) return;
    this.globalState.repeat.maybeStart(key, { mode: this.modeState.kind, pendingChord: this.normalPendingChordForRepeat() });
    this.globalState.repeat.recordKey(key);
  }

  private dispatchInsertLikeKey(key: string): KeyDispatchResult | undefined {
    if (this.modeState.kind === "insert") {
      const handler = this.insertKeyHandlers.get(key);
      if (handler !== undefined) return handler();
      const text = insertTextForKey(key);
      if (text !== undefined) {
        insertText(this.editor, text, this.insertEditOptions());
        this.insertRepeatText += text;
        return "handled";
      }
      return "native";
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
      return "native";
    }

    return undefined;
  }

  private dispatchMotionModeKey(key: string): KeyResult | undefined {
    if (!this.shouldResolveMotionModeAction()) return undefined;
    const motionModeAction = this.resolveKeymapAction(key, "motionMode");
    if (motionModeAction === undefined) return undefined;
    return this.dispatchVimAction(motionModeAction);
  }

  private dispatchFallbackKeymapKey(key: string): KeyResult | undefined {
    const normalFallbackAction = this.resolveKeymapAction(key, "normalFallback");
    if (normalFallbackAction === undefined) return undefined;
    return this.dispatchVimAction(normalFallbackAction);
  }

  private dispatchModeFallbackKey(_key: string): KeyDispatchResult {
    if (this.isVisualMode()) {
      const modeBefore = this.modeState.kind;
      return this.applyVisualResult(this.visualMode.handleUnhandledKey(), modeBefore);
    }

    if (this.modeState.kind !== "normal") return "native";

    return this.applyNormalResult(this.normalMode.handleUnhandledKey());
  }

  // The single waiting-input dispatcher. Recording policy per class:
  // waiting-input keys are recorded into macros (so replays of `f x`, `"a`,
  // `/foo`, `ma` work), search/find input is recorded for dot-repeat, and
  // operator inputs (replace chars, surround targets, object selectors) are
  // recorded for both, exactly like keys that flow through the keymap phases.
  private dispatchWaitingInput(waiting: WaitingInput, key: string): KeyDispatchResult | undefined {
    switch (waiting.type) {
      case "insertDigraph":
        if (!this.isEscape(key)) this.recordMacroKey(key);
        this.handlePendingDigraphKey(key);
        return "handled";
      case "literal":
        if (!this.isEscape(key)) this.recordMacroKey(key);
        return this.handlePendingLiteralKey(key);
      case "insertRegister":
        if (!this.isEscape(key)) this.recordMacroKey(key);
        this.handlePendingInsertRegisterKey(key);
        return "handled";
      case "recordRegister":
        this.operatorStack.popTopLevel("recordRegister");
        this.globalState.macro.startRecording(key);
        return "handled";
      case "replayRegister": {
        const pending = this.operatorStack.popTopLevel("replayRegister");
        if (pending === undefined) return "handled";
        this.recordMacroKey(key);
        this.globalState.macro.replayRegisterKey(key, pending.count, key => this.onKey(key));
        return "handled";
      }
      case "register":
        this.recordMacroKey(key);
        this.operatorStack.popTopLevel("register");
        this.handlePendingRegisterKey(key);
        return "handled";
      case "command":
        this.recordMacroKey(key);
        this.handlePendingCommandKey(key);
        return "handled";
      case "search": {
        const pendingSearch = this.operatorStack.activeTopLevel("search");
        if (pendingSearch === undefined) return undefined;
        if (!isSearchInputKey(key)) return "native";
        this.recordMacroKey(key);
        return this.handlePendingSearchKey(key, pendingSearch);
      }
      case "find":
        this.recordMacroKey(key);
        this.recordRepeatKey(key);
        this.handlePendingFindKey(key);
        return "handled";
      case "mark":
        this.recordMacroKey(key);
        this.operatorStack.popTopLevel("mark");
        this.modelState.marks.createMark(this.editor, key);
        return "handled";
      case "jump": {
        const pendingJump = this.operatorStack.popTopLevel("jump");
        if (pendingJump === undefined) return "handled";
        this.recordMacroKey(key);
        // The jump target extends an in-flight change recording (`d'a`).
        this.recordRepeatKey(key);
        const motion = this.modelState.marks.jumpMotion(this.editor, key, { line: pendingJump.line });
        if (motion !== undefined) this.applyMotion(motion, 1);
        return "handled";
      }
      case "normalDigraph":
        this.recordWaitingOperatorKey(key);
        return this.applyNormalResult(this.normalMode.handlePendingDigraphKey(key));
      case "normalReplace":
        this.recordWaitingOperatorKey(key);
        return this.applyNormalResult(this.normalMode.handlePendingReplaceKey(key));
      case "normalSurround":
        this.recordWaitingOperatorKey(key);
        return this.applyNormalResult(this.normalMode.handlePendingSurroundKey(key));
      case "normalTextObject":
        this.recordWaitingOperatorKey(key);
        return this.applyNormalResult(this.normalMode.handlePendingTextObjectKey(key));
      case "normalSurroundPrefix":
        this.recordWaitingOperatorKey(key);
        return this.applyNormalResult(this.normalMode.handlePendingSurroundPrefixKey());
      case "visualSurround":
        this.recordWaitingOperatorKey(key);
        return this.applyVisualResult(this.visualMode.handlePendingSurroundKey(key), this.modeState.kind);
      case "visualTextObject":
        this.recordWaitingOperatorKey(key);
        return this.applyVisualResult(this.visualMode.handlePendingTextObjectKey(key), this.modeState.kind);
    }
  }

  private recordWaitingOperatorKey(key: string): void {
    this.recordMacroKey(key);
    this.recordRepeatableKey(key);
  }

  private handleFiniteKeymapKey(key: string): KeyResult | undefined {
    const allowShared = this.shouldResolveSharedAction(key);
    const allowNormal = this.shouldResolveNormalChord();
    if (!allowShared && !allowNormal && !this.keymapResolver.isPending()) return undefined;

    const resolution = this.keymapResolver.handleKey(key, { allowShared, allowNormal });
    switch (resolution.kind) {
      case "pending":
        return "handled";
      case "action":
        this.dispatchVimAction(resolution.action);
        return "handled";
      case "cancelled":
        if (resolution.scope === "shared"
          && this.modeState.kind === "normal"
          && this.normalMode.pendingOperatorName() !== undefined) {
          this.normalMode.clearPending();
        }
        return "handled";
      case "noMatch":
        return undefined;
    }
  }

  private normalPendingChordForRepeat(): string {
    const chord = this.normalMode.pendingChord();
    return this.selectedRegister === undefined ? chord : `${chord}\"${this.selectedRegister}`;
  }

  private resolveKeymapAction(key: string, phase: VimKeymapPhase): VimAction | undefined {
    return resolveVimAction(key, phase, this.keymapContext());
  }

  // Zed: `vim::Vim::extend_key_context`.
  private keymapContext(): VimKeymapContext {
    return {
      mode: this.modeState.kind,
      operator: this.operatorStack.operatorContext(),
      operatorPendingKey: this.modeState.kind === "normal" ? this.operatorStack.operatorPendingKey() : undefined,
      hasSelectedRegister: this.selectedRegister !== undefined,
      countText: this.countBuffer,
      repeatIsReplaying: this.globalState.repeat.isReplaying(),
    };
  }

  private dispatchVimAction(action: VimAction): KeyResult | undefined {
    switch (action.type) {
      case "pushMark":
        this.operatorStack.push({ type: "mark" });
        return "handled";
      case "pushJump":
        this.operatorStack.push({ type: "jump", line: action.line });
        return "handled";
      case "insertEmptyLines":
        this.insertEmptyLines(action.side, this.takeCountForMotion(1));
        return "handled";
      case "repeatLastChange":
        this.globalState.repeat.replay(this.normalMode.takeCountForRepeat(), {
          registerName: this.takeSelectedRegister(),
          runKey: key => this.onKey(key),
          runVisualAction: (selection, repeatAction) => this.replayVisualAction(selection, repeatAction),
        });
        return "handled";
      case "cancelRepeat":
        this.globalState.repeat.cancelCurrent();
        return undefined;
      case "startCommand":
        this.operatorStack.push({ type: "command", input: "" });
        this.setMode("command");
        return "handled";
      case "forceMotion":
        this.operatorStack.forceMotion(action.force);
        return "handled";
      case "toggleVisual":
        if (this.isVisualMode()) {
          return this.applyVisualResult(this.visualMode.toggleMode(action.mode), this.modeState.kind);
        }
        this.enterVisualMode(action.mode);
        return "handled";
      case "enterReplace":
        this.enterReplaceMode({ count: this.normalMode.takeCountForMotion(1), separator: "" });
        return "handled";
      case "repeatSearch": {
        const motion = this.globalState.search.repeat({ reversed: action.reversed });
        if (motion !== undefined) this.applyMotion(motion, 1);
        return "handled";
      }
      case "repeatFind":
        this.repeatFind({ reversed: action.reversed });
        return "handled";
      case "pushFindForward":
        this.operatorStack.push({ type: "findForward", before: action.before, count: this.takeCountForMotion(1) });
        return "handled";
      case "pushFindBackward":
        this.operatorStack.push({ type: "findBackward", after: action.after, count: this.takeCountForMotion(1) });
        return "handled";
      case "startSearch":
        this.searchOriginMode = this.modeState.kind;
        this.operatorStack.push(this.globalState.search.start(action.backwards, this.editor));
        this.setMode("search");
        return "handled";
      case "searchUnderCursor":
        this.applySearchUnderCursor({ backwards: action.backwards });
        return "handled";
      case "motion":
        if (!(this.modeState.kind === "normal" && this.normalMode.pendingOperatorName() !== undefined)) {
          this.globalState.repeat.cancelCurrent();
        }
        this.applyMotion(action.motion, this.takeCountForMotion(1));
        return "handled";
      case "lineOperation":
        return this.applyNormalResult(this.normalMode.handleLineOperation());
      case "pushEditOperator":
        return this.applyNormalResult(this.normalMode.handleEditOperatorKey(action.operator, action.key));
      case "pushObject":
        this.operatorStack.pushObject(action.around, this.normalMode.chordKey(action.key));
        return "handled";
      case "pushIndent":
        this.operatorStack.pushIndent(action.direction, this.takeCountForMotion(1), this.normalMode.chordKey(action.key, { includeCount: true }));
        return "handled";
      case "normalCommand":
        return this.applyNormalResult(this.normalMode.handleCommand(action.command));
      case "visualCommand":
        return this.applyVisualResult(this.visualMode.handleCommand(action.command), this.modeState.kind);
      case "pushRegister":
        this.operatorStack.push({ type: "register" });
        return "handled";
      case "pushCount":
        this.appendCountKey(action.key);
        return "handled";
      case "changeList": {
        this.globalState.repeat.cancelCurrent();
        const position = this.modelState.changeList.move(this.takeCountForMotion(1), action.direction);
        if (position !== undefined) this.editor.setSelections([charwiseSelection(position)]);
        return "handled";
      }
      case "insertAtPrevious":
        if (this.modeState.kind === "normal") this.enterInsertAtPrevious();
        return "handled";
      case "page": {
        this.globalState.repeat.cancelCurrent();
        const selections = this.editor.moveByPages(
          action.direction,
          this.takeCountForMotion(1),
          { halfPage: action.halfPage, extend: this.isVisualMode() });
        if (selections !== undefined) this.editor.setSelections(selections);
        if (this.isVisualMode()) this.visualMode.adoptSelectionFromHost();
        return "handled";
      }
      case "restoreVisualSelection": {
        this.globalState.repeat.cancelCurrent();
        const nextMode = this.visualMode.restoreLastSelection();
        if (nextMode !== undefined) this.modeState = { dialect: this.modeState.dialect, kind: nextMode };
        return "handled";
      }
      case "searchSelection":
        this.applySearchSelection({ reversed: action.reversed, count: this.takeCountForMotion(1) });
        return "handled";
      case "pushConvert":
        if (this.modeState.kind === "normal") {
          // Vim `gugu` (and `gUgU`/`g~g~`): repeating the convert operator is
          // the line-doubling rule, like `guu`.
          const pendingConvert = this.operatorStack.activeConvert();
          if (pendingConvert !== undefined && convertTargetForPending(pendingConvert) === action.target) {
            return this.applyNormalResult(this.normalMode.handleLineOperation());
          }
          // Vim: starting a new operator while another is pending aborts both
          // (`dgu`, `gugU`).
          if (this.operatorStack.length > 0) {
            this.normalMode.clearPending();
            return "handled";
          }
          const key = keyForConvertTarget(action.target);
          this.operatorStack.pushConvert(action.target, this.takeCountForMotion(1), this.normalMode.chordKey(`g${key}`, { includeCount: true }));
        } else if (this.isVisualMode()) {
          this.visualMode.convertSelections(action.target);
          this.setMode("normal");
        }
        return "handled";
      case "join":
        if (this.modeState.kind === "normal") {
          return this.applyNormalResult(this.normalMode.joinLines({ insertWhitespace: action.insertWhitespace }));
        } else if (this.isVisualMode()) {
          this.visualMode.joinSelections({ insertWhitespace: action.insertWhitespace });
          this.setMode("normal");
        }
        return "handled";
      case "incrementStep": {
        const count = this.takeCountForMotion(1);
        const delta = (action.direction === "increment" ? 1 : -1) * count;
        incrementNumbers(this.editor, delta, action.cumulative ? delta : 0);
        if (this.isVisualMode()) {
          this.visualMode.clearState();
          this.editor.setCursorStyle("block");
          this.setMode("normal");
        }
        return "handled";
      }
      case "multiCursor": {
        this.globalState.repeat.cancelCurrent();
        const count = this.takeCountForMotion(1);
        for (let index = 0; index < count; index++) {
          this.editor.executeNativeCommand(action.command, [], { syncSelectionAfter: true });
        }
        return "handled";
      }
      case "native":
        this.globalState.repeat.cancelCurrent();
        this.editor.executeNativeCommand(action.command);
        this.syncFromEditorState();
        return "handled";
      case "hostCommand":
        this.editor.executeHostCommand(action.command);
        this.syncFromEditorState();
        return "handled";
      case "scrollLines":
        this.editor.scrollByLines(action.direction, this.takeCountForMotion(1));
        this.syncFromEditorState();
        return "handled";
      case "revealCurrentLine":
        this.editor.revealCurrentLine(action.target);
        this.syncFromEditorState();
        return "handled";
      case "fold":
        this.editor.executeFoldCommand(action.command);
        this.syncFromEditorState();
        return "handled";
    }
  }

  private handlePendingRegisterKey(key: string): void {
    const registerName = parseRegisterName(key);
    if (registerName !== undefined) {
      this.selectedRegister = registerName;
      return;
    }
    if (this.modeState.kind === "normal") this.normalMode.clearPending();
    else if (this.isVisualMode()) this.visualMode.clearPending();
  }

  private handlePendingSearchKey(key: string, pendingSearch: Extract<TopLevelPendingOperator, { type: "search" }>): KeyDispatchResult {
    this.recordRepeatKey(key);
    const originMode = this.searchOriginMode ?? "normal";
    const motion = this.globalState.search.handleKey(pendingSearch, key, this.globalState.registers, this.editor);
    if (key === "enter") this.operatorStack.popTopLevel("search");
    if (motion !== undefined) {
      this.searchOriginMode = undefined;
      this.setMode(isVisualModeKind(originMode) ? originMode : "normal");
      this.applyMotion(motion, 1);
      this.editor.clearSearchHighlights();
    } else if (key === "enter") {
      this.searchOriginMode = undefined;
      this.setMode(isVisualModeKind(originMode) ? originMode : "normal");
    }
    return "handled";
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

  // Macro control keys resolve after waiting input (so `f q`, `m q`, and
  // register/search input win while recording) but before macro key recording
  // (so the `q` that stops a recording is not recorded into it).
  private handleMacroControlKey(key: string): KeyResult | undefined {
    if (this.modeState.kind !== "normal") return undefined;

    if (this.globalState.macro.isRecording() && key === "q") {
      this.globalState.macro.stopRecording();
      return "handled";
    }

    if (key === "q") {
      this.operatorStack.push({ type: "recordRegister" });
      return "handled";
    }

    if (key === "@") {
      this.recordMacroKey(key);
      this.operatorStack.push({ type: "replayRegister", count: this.normalMode.takeCountForMotion(1) });
      return "handled";
    }

    if (key === "Q") {
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

  private enterVisualMode(mode: Extract<VisualResultMode, "visual" | "visualLine" | "visualBlock">): void {
    this.visualMode.enter(visualKindForMode(mode));
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
    this.operatorStack.push({ type: "insertDigraph", target: "insert" });
    return "handled";
  }

  private startReplaceDigraph(): KeyResult {
    this.operatorStack.push({ type: "insertDigraph", target: "replace" });
    return "handled";
  }

  private startPlainLiteral(): KeyResult {
    this.operatorStack.push({ type: "literal", kind: "plain" });
    return "handled";
  }

  private startInsertRegister(): KeyResult {
    this.operatorStack.push({ type: "insertRegister" });
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
    return !this.keymapResolver.isPending() && this.operatorStack.length === 0;
  }

  private currentRemapMode() {
    return remapModeForVimMode(this.modeState.kind, {
      operatorPending: this.modeState.kind === "normal" && this.normalMode.pendingOperatorName() !== undefined,
    });
  }

  private replayTimedOutRemapKeys(keys: readonly string[], remapWhen: RemapWhenEvaluator): void {
    keys.forEach((key, index) => {
      this.dispatchKey(key, { allowRemap: index > 0, remapWhen });
    });
  }

  private executeRemapping(mapping: NormalizedRemapping, remapWhen: RemapWhenEvaluator): void {
    const skipFirstRecursiveKey = mapping.recursive && isPrefixOrEqual(mapping.before, mapping.after);
    for (const [index, key] of mapping.after.entries()) {
      if (key === NoopKey) continue;
      this.dispatchKey(key, { allowRemap: mapping.recursive && !(skipFirstRecursiveKey && index === 0), remapWhen });
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

  private shouldResolveMotionModeAction(): boolean {
    if (!this.isMotionMode() || this.modeIsExpectingRegisterName()) return false;
    const operator = this.operatorStack.operatorContext();
    if (this.modeState.kind === "normal") {
      // Motions are available when idle or as range-operator targets; other
      // pending operators (objects, surrounds, replace) consume motion keys
      // through the waiting-input path instead.
      return operator === "none" || isRangeOperatorContext(operator);
    }
    return this.isVisualMode() && operator === "none";
  }

  private shouldResolveSharedAction(key: string): boolean {
    if (!this.isMotionMode() || this.modeIsExpectingRegisterName()) return false;
    const operator = this.operatorStack.operatorContext();
    if (this.modeState.kind !== "normal") return operator === "none";
    switch (operator) {
      case "none":
        // A selected register is irrelevant for motions, matching Vim.
        return true;
      case "delete":
      case "change":
      case "yank":
      case "convert":
      case "indent":
      case "surround":
        // Shared `g`-prefixed motions can be operator targets (`d g g`,
        // `g u g g`), and `g u`-style chords are how convert doubles
        // (`g u g u`).
        return key === "g";
      case "object":
      case "other":
        return false;
    }
  }

  private shouldResolveNormalChord(): boolean {
    return this.modeState.kind === "normal" && this.operatorStack.operatorContext() === "none";
  }

  private applySearchUnderCursor({ backwards }: { backwards: boolean }): void {
    const motion = this.modeState.kind === "normal"
      ? searchUnderCursorMotion(this.editor, this.globalState.search, this.globalState.registers, { backwards })
      : this.visualSearchMotion({ backwards });
    if (motion === undefined) return;
    if (this.isVisualMode()) {
      this.visualMode.clearState();
      this.editor.setCursorStyle("block");
      this.setMode("normal");
    }
    this.applyMotion(motion, this.takeCountForMotion(1));
    this.editor.clearSearchHighlights();
  }

  private visualSearchMotion({ backwards }: { backwards: boolean }): Motion | undefined {
    const selection = this.editor.getSelections()[0];
    if (selection === undefined) return undefined;
    const query = this.editor.getText(rangeOfSelection(selection));
    if (query.length === 0) return undefined;
    return this.globalState.search.setLast(query, backwards, this.globalState.registers, this.editor, { regex: false });
  }

  private handlePendingFindKey(key: string): void {
    const pending = this.operatorStack.popFind();
    if (pending === undefined) return;
    if (key === "ctrl-k") {
      this.operatorStack.push({ type: "insertDigraph", target: "find", pending });
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
    const pending = this.operatorStack.activeTopLevel("insertDigraph");
    if (pending === undefined) return;
    if (this.isEscape(key)) {
      this.operatorStack.popTopLevel("insertDigraph");
      return;
    }
    const input = keyForInput(key);
    if (pending.first === undefined) {
      this.operatorStack.replaceActiveInsertDigraph({ ...pending, first: input });
      return;
    }

    this.operatorStack.popTopLevel("insertDigraph");
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
    const pending = this.operatorStack.activeTopLevel("literal");
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
      this.operatorStack.popTopLevel("literal");
      this.insertLiteralText(literalTextForKey(key));
      return "handled";
    }

    if (pending.kind === "decimal") {
      if (/^[0-9]$/.test(key)) {
        return this.handlePendingLiteralKeyWithState({ ...pending, digits: pending.digits + key });
      }
      this.operatorStack.popTopLevel("literal");
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
      this.operatorStack.popTopLevel("literal");
      this.insertLiteralCodepoint(Number.parseInt(pending.digits + key, 16));
      return "handled";
    }
    this.operatorStack.popTopLevel("literal");
    if (pending.digits.length > 0) this.insertLiteralCodepoint(Number.parseInt(pending.digits, 16));
    const text = insertTextForKey(key);
    if (text !== undefined) this.insertLiteralText(text);
    return "handled";
  }

  private handlePendingLiteralKeyWithState(next: PendingLiteralOperator): KeyResult {
    this.operatorStack.replaceActiveLiteral(next);
    if (next.kind === "decimal" && next.digits.length >= 3) {
      this.operatorStack.popTopLevel("literal");
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
    this.operatorStack.popTopLevel("insertRegister");
    if (this.isEscape(key)) return;
    const registerName = parseRegisterName(key);
    if (registerName === undefined) return;
    insertText(this.editor, this.globalState.registers.read(registerName), this.insertEditOptions());
  }

  private handlePendingCommandKey(key: string): void {
    const pending = this.operatorStack.activeTopLevel("command");
    if (pending === undefined) return;
    if (key === "enter") {
      const command = pending.input;
      this.operatorStack.popTopLevel("command");
      this.setMode("normal");
      executeCommand(this.editor, command, {
        runNormalKeys: (keys, range) => this.runNormalKeysForCommand(keys, range),
      });
      return;
    }
    if (key === "backspace") {
      this.operatorStack.replaceActiveCommand(pending.input.slice(0, -1));
      return;
    }
    this.operatorStack.replaceActiveCommand(`${pending.input}${key === "space" ? " " : key}`);
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
    if (this.visualMode.adoptSelection(this.editor.getSelections()[0])) {
      this.modeState = { dialect: this.modeState.dialect, kind: "visual" };
    }
  }

  private applyMotion(motion: Motion, count: number): void {
    if (this.modeState.kind === "normal") {
      const modeBeforeMotion = this.modeState.kind;
      const enterInsert = this.normalMode.applyMotion(motion, count);
      if (enterInsert) this.enterInsertMode({ origin: modeBeforeMotion });
    } else if (this.isVisualMode()) {
      this.visualMode.applyMotion(motion, count);
    }
  }

  private takeCountForMotion(defaultValue: number): number {
    return this.takeCount(defaultValue);
  }

  private isMotionMode(): boolean {
    return this.modeState.kind === "normal" || this.isVisualMode();
  }

  private modeIsExpectingRegisterName(): boolean {
    return this.operatorStack.activeTopLevel("register") !== undefined;
  }

  private isVisualMode(): boolean {
    return isVisualModeKind(this.modeState.kind);
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

function keyForConvertTarget(target: ConvertTarget): "u" | "U" | "~" | "?" {
  switch (target) {
    case "lower":
      return "u";
    case "upper":
      return "U";
    case "toggle":
      return "~";
    case "rot13":
      return "?";
  }
}

// Local test helper, analogous in spirit to Zed's test harness helpers in
// `test::vim_test_context::VimTestContext` rather than a production API.
export function runKeys(vim: Vim, keys: readonly string[]): void {
  for (const key of keys) {
    vim.onKey(key);
  }
}
