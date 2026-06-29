// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `vim::Vim`
// - translated concepts: main Vim state holder and high-level mode dispatch
// - intentional differences: GPUI action registration is replaced by direct key dispatch
//   from the VSCode patch / tests.

import { LineRange, executeCommand } from "./command.js";
import { RemapTimeoutKey, defaultVimConfiguration, mergeVimConfiguration, normalizeKey, remapModeForVimMode } from "./config.js";
import type { NormalizedRemapping, WhenEvaluator, VimCommandMapping, VimConfiguration } from "./config.js";
import { lookupDigraph } from "./digraph.js";
import { EasyMotionState } from "./easymotion.js";
import { collapseSelectionsToNormalCursors, collapseToPrimaryNormalCursor, hasMultipleCursorsOrSelection, reconcileCursorState } from "./editor_state_sync.js";
import type { CursorReconciliationOptions } from "./editor_state_sync.js";
import { VimEditorCapabilities, keepUndoTransactionOpen, normalCursorPosition } from "./editor.js";
import { enterNormalMode, insertCharacterFromAdjacentLine, insertText, deleteToBeginningOfLine, deleteToPreviousWord } from "./insert.js";
import { initialHandlerState, unhandled } from "./key_handler.js";
import type { Handler, HandlerEnv, HandlerState } from "./key_handler.js";
import { KeyExecutor } from "./key_executor.js";
import { finiteKeymapPermissions, resolveVimAction, shouldResolveMotionModeAction, VimAction, VimKeymapContext, VimKeymapPhase, VimKeymapResolver } from "./keymap.js";
import { FindMotion, Motion } from "./motion.js";
import { NormalMode } from "./normal.js";
import type { NormalKeyResult } from "./normal.js";
import { normalModeHandler } from "./normal_mode_handler.js";
import { VimOperatorStack, WaitingInput, convertTargetForPending, isSelfEscapingWaitingInput } from "./operator.js";
import { RangeOperator } from "./operator_target.js";
import type {
  PendingFindOperator,
  PendingLiteralOperator,
  TopLevelPendingOperator,
} from "./operator.js";
import { MacroRecordingStatus, RecordedSelection, VisualRepeatAction } from "./normal/repeat.js";
import { incrementNumbers } from "./normal/increment.js";
import { isSearchInputKey, searchUnderCursorMotion } from "./normal/search.js";
import { RegisterName, isSystemClipboardRegister, parseRegisterName } from "./registers.js";
import { DebugRemapConflict, createRemaps, debugRemapConflicts, handleKeyOverride as remapKeyOverride, hasRemapStartingWith, pendingRemapInsertText, remapHandler } from "./remap.js";
import type { Remaps } from "./remap.js";
import type { VimSystemClipboard } from "./registers.js";
import { ConvertTarget } from "./normal/convert.js";
import { indentRanges } from "./normal/indent.js";
import { ReplacedText, replaceModeText } from "./replace.js";
import { KeyDispatchResult, KeyResult, Position, TextEdit, TextRange, VimMode, charwiseSelection, comparePositions, isVisualModeKind, rangeOfSelection, selectionHead, vimModeName } from "./state.js";
import { VisualMode, visualKindForMode } from "./visual.js";
import type { VisualKeyResult, VisualResultMode } from "./visual.js";
import { VimGlobalState, VimModelState } from "./vim_state.js";

export type VimStatus = {
  mode: VimMode;
  pending: boolean;
  /** Number of entries in the pending input stack (0 when nothing is
      pending): a typed count is one entry regardless of digits, each pending
      operator/object/chord level is one more. Drives the shrinking
      pending-cursor presentation. */
  pendingDepth: number;
  operator: RangeOperator["type"] | undefined;
  chord: string;
  text: string;
  remapPending: boolean;
  remapTimeoutMs: number;
  insertPendingText: string | undefined;
  macroRecording: MacroRecordingStatus | undefined;
  readonlyWarning: boolean;
  readonlyWarningRemainingMs: number | undefined;
};

function statusText(mode: VimMode, chord: string, macroRecording: MacroRecordingStatus | undefined): string {
  const modeText = chord.length > 0 ? `${mode.toUpperCase()} ${chord}` : mode.toUpperCase();
  if (macroRecording === undefined) return modeText;
  const keys = macroRecording.keys.map(keyForStatus).join("");
  return keys.length === 0
    ? `${modeText} recording @${macroRecording.register}`
    : `${modeText} recording @${macroRecording.register}: ${keys}`;
}

function keyForStatus(key: string): string {
  if (key.length === 1) return key;
  return key.startsWith("<") && key.endsWith(">") ? key : `<${key}>`;
}

export type EditorSyncResult = {
  mode: VimMode;
  selectionCount: number;
  visualSelectionFound: boolean;
  adoptedVisualSelection: boolean;
  reason: string;
};

export type KeyPlan = { run: (env?: { clipboard?: VimSystemClipboard }) => Promise<void> };

const alwaysActiveWhenEvaluator: WhenEvaluator = () => true;



;
const readonlyWarningDurationMs = 2000;
export { VimGlobalState, VimModelState };

// Zed: `vim::Vim`. This class is the local main state holder; GPUI
// entity/window fields are intentionally replaced by the injected
// `VimEditorCapabilities`.
export class Vim {
  private modeState: VimMode = "normal";
  private readonly keymapResolver = new VimKeymapResolver();
  private readonly easyMotion = new EasyMotionState();
  private readonly operatorStack = new VimOperatorStack();
  private modelState: VimModelState;
  private handlerState: HandlerState = { ...initialHandlerState };
  // Vim 'showcmd': the literal keys typed for the in-flight pending command,
  // used only for the status chord display. The buffer is never cleared
  // eagerly when a command completes or aborts; instead it resets lazily when
  // a key arrives while nothing is pending, and the status renders it only
  // while something is pending.
  private readonly showcmdKeys: string[] = [];
  private configuration: VimConfiguration = defaultVimConfiguration;
  private remaps: Remaps = createRemaps(this.configuration);
  // The typed key-handler framework entrypoint. Handlers are ported into
  // [executorHandlers] slice by slice; [redispatch] is the bridge that runs any
  // key the executor does not claim through the legacy dispatcher. The executor
  // itself has no knowledge of that fallback.
  private readonly keyExecutor: KeyExecutor = new KeyExecutor({
    handlersForState: state => this.executorHandlers(state),
    redispatch: (key, allowRemap) => this.dispatchThroughPipeline(key, allowRemap),
    executeCommand: command => this.executeMappedCommand(command),
    onEnterMode: (mode, opts) => this.enterModeFromExecutor(mode, opts),
    dispatchToLegacyKeymap: (keys, count) => this.dispatchToLegacyKeymap(keys, count),
  });
  // The when-evaluator for the in-flight top-level dispatch, read by the remap
  // root handler (which resolves against the live Vim mode) and the executor's
  // command callback.
  private dispatchWhenEvaluator: WhenEvaluator = alwaysActiveWhenEvaluator;
  private searchOriginMode: VimMode | undefined;
  private insertRepeatCount = 1;
  private insertRepeatText = "";
  // Zed: `Vim::replacements` — what replace mode overwrote, for backspace.
  private replaceModeReplacements: ReplacedText[] = [];
  private insertRepeatSeparator = "";
  private insertOrigin: VimMode | undefined;
  // Vim `i_CTRL-O` (Zed: `Vim::temp_mode`): one normal-mode command from
  // insert mode, then back to insert.
  private temporaryNormal = false;
  private pendingVisualRepeatChange: { selection: RecordedSelection } | undefined;
  private readonlyWarningUntil = 0;
  private readonly insertKeyHandlers: ReadonlyMap<string, () => KeyResult> = new Map([
    ["ctrl-k", () => this.startInsertDigraph()],
    ["ctrl-v", () => this.startPlainLiteral()],
    ["ctrl-r", () => this.startInsertRegister()],
    ["ctrl-w", () => this.deleteInsertPreviousWord()],
    ["ctrl-u", () => this.deleteInsertLineStart()],
    ["ctrl-y", () => this.insertCharacterFromAdjacentLine("above")],
    ["ctrl-e", () => this.insertCharacterFromAdjacentLine("below")],
    ["ctrl-o", () => this.enterTemporaryNormalMode()],
  ]);
  private readonly replaceKeyHandlers: ReadonlyMap<string, () => KeyResult> = new Map([
    ["ctrl-k", () => this.startReplaceDigraph()],
    ["backspace", () => this.undoReplace()],
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
    this.remaps = createRemaps(this.configuration);
    this.globalState.registers.setUseSystemClipboard(this.configuration.useSystemClipboard);
    this.editor.setCursorStyle("block");
    this.handlerState.editor = editor;
    this.handlerState.registers = this.globalState.registers;
    this.normalMode = new NormalMode(editor, this.globalState.registers, {
      get: () => this.effectiveRegister(),
      take: () => this.takeSelectedRegister(),
      clear: () => this.clearSelectedRegister(),
    }, {
      get: () => this.handlerState.countText,
      append: key => this.appendCountKey(key),
      take: defaultValue => defaultValue === undefined ? this.takeCount(undefined) : this.takeCount(defaultValue),
      clear: () => this.clearCount(),
    }, this.operatorStack);
    this.visualMode = new VisualMode(editor, this.globalState.registers, {
      get: () => this.effectiveRegister(),
      take: () => this.takeSelectedRegister(),
      clear: () => this.clearSelectedRegister(),
    }, {
      get: () => this.handlerState.countText,
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
    this.remaps = createRemaps(this.configuration);
    this.clearPendingRemaps();
    this.globalState.registers.setUseSystemClipboard(this.configuration.useSystemClipboard);
    this.visualMode.setConfiguration(this.configuration);
  }

  get mode(): VimMode {
    return this.modeState;
  }

  get modeName(): string {
    const suffix = this.isPending() && this.modeState !== "search" && this.modeState !== "command" ? "+" : "";
    return `${vimModeName(this.modeState)}${suffix}`;
  }

  get status(): VimStatus {
    const chord = this.pendingChord();
    const mode = this.modeState;
    const macroRecording = this.globalState.macro.recordingStatus();
    const text = statusText(mode, chord, macroRecording);
    const readonlyWarningRemainingMs = this.readonlyWarningRemainingMs();
    return {
      mode,
      pending: this.isPending(),
      pendingDepth: this.pendingDepth(),
      operator: this.modeState === "normal" ? this.normalMode.pendingOperatorName() : undefined,
      chord,
      text,
      remapPending: this.remapIsPending(),
      remapTimeoutMs: this.configuration.timeout,
      insertPendingText: mode === "insert" || mode === "replace" ? pendingRemapInsertText(this.pendingRemapEnvsForStatus()) : undefined,
      macroRecording,
      readonlyWarning: readonlyWarningRemainingMs !== undefined,
      readonlyWarningRemainingMs,
    };
  }

  ensureNormalModeForReadonlyDocument(): boolean {
    if (!this.editor.isReadonly() || (this.modeState !== "insert" && this.modeState !== "replace")) {
      return false;
    }
    this.returnToNormalForReadonlyDocument();
    return true;
  }

  readRegister(name: RegisterName | undefined): string {
    return this.globalState.registers.read(name);
  }

  private takeSelectedRegister(): RegisterName | undefined {
    const registerName = this.handlerState.register;
    this.handlerState.register = undefined;
    return registerName;
  }

  private clearSelectedRegister(): void {
    this.handlerState.register = undefined;
  }

  private takeCount(defaultValue: number): number;
  private takeCount(defaultValue: undefined): number | undefined;
  private takeCount(defaultValue: number | undefined): number | undefined {
    if (this.handlerState.countText.length === 0) return defaultValue;
    const count = Number(this.handlerState.countText);
    this.handlerState.countText = "";
    return count;
  }

  private appendCountKey(key: string): void {
    this.handlerState.countText += key;
  }

  private clearCount(): void {
    this.handlerState.countText = "";
  }

  debugRemapConflicts(): readonly DebugRemapConflict[] {
    return debugRemapConflicts(this.remaps);
  }

  handleKeyOverride(key: string): boolean | undefined {
    return remapKeyOverride(this.remaps, key);
  }

  /** Test helper for asserting the synchronous key ownership decision.
      Production code should call [handleKey] and run the returned [KeyPlan]. */
  wouldHandleKeyForTest(key: string): boolean {
    return this.handleKey(key) !== null;
  }

  handleKey(key: string, { whenEvaluator = alwaysActiveWhenEvaluator }: { whenEvaluator?: WhenEvaluator } = {}): KeyPlan | null {
    if (!this.ownsKey(key, whenEvaluator)) return null;
    return {
      run: async ({ clipboard }: { clipboard?: VimSystemClipboard } = {}) => {
        await this.globalState.registers.withSystemClipboard(clipboard, async () => {
          await this.refreshSystemClipboardRegisterForKey(key);
          this.dispatchTypedKey(key, { allowRemap: true, whenEvaluator });
          // Drain any effect actions the executor queued. With a synchronous
          // editor these have already run inline; this awaits the tail when an
          // effect was genuinely asynchronous (e.g. real editor edits).
          await this.keyExecutor.whenIdle();
        });
      },
    };
  }

  executeExternalRemap(mapping: { after?: readonly string[]; commands?: readonly VimCommandMapping[] }): void {
    for (const key of mapping.after ?? []) {
      this.routeKeyThroughExecutor(normalizeKey(key, this.configuration.leader), {
        allowRemap: true,
        whenEvaluator: alwaysActiveWhenEvaluator,
      });
    }
    for (const command of mapping.commands ?? []) this.executeMappedCommand(command);
    this.ensureNormalModeForReadonlyDocument();
  }

  hasActiveRemapStartingWithOrPending(key: string, whenEvaluator: WhenEvaluator = alwaysActiveWhenEvaluator): boolean {
    return this.remapIsPending()
      || hasRemapStartingWith(this.remaps, this.currentRemapMode(), key, whenEvaluator);
  }

  private ownsKey(key: string, whenEvaluator: WhenEvaluator): boolean {
    const handleOverride = this.handleKeyOverride(key);
    if (handleOverride !== undefined) return handleOverride;

    const pendingSearch = this.operatorStack.activeTopLevel("search");
    if (pendingSearch !== undefined) return isSearchInputKey(key);

    if (this.operatorStack.length > 0 || this.keymapResolver.isPending() || this.easyMotion.isPending() || this.remapIsPending()) return true;

    if (this.isEscape(key)) return this.shouldHandleEscapeKey();

    if (this.modeState === "insert" || this.modeState === "replace") {
      // Insert mode normally delegates plain typing to the host. While a macro
      // recording is in flight, own the printable keys we can apply ourselves
      // so the recording captures the same key stream it will later replay.
      // This mirrors Zed's split between `VimGlobals::observe_action` and
      // `VimGlobals::observe_insertion`, but keeps vimcode's replay
      // representation key-based.
      if (this.modeState === "insert" && this.shouldRecordInsertTextKeyThroughVim(key)) {
        return true;
      }
      // Replace mode cannot delegate plain typing: native typing inserts,
      // while Vim `R` overwrites and backspace restores what was overwritten.
      // (Keys the host produces outside the keydown map — e.g. IME composition
      // — still fall through natively.)
      if (this.modeState === "replace" && (insertTextForKey(key) !== undefined || key === "backspace")) {
        return true;
      }
      return this.shouldPrepareInsertOrReplaceKey(key, whenEvaluator);
    }

    if (this.isVisualMode() && key === "ctrl-c") return true;

    if (isCtrlKey(key)) {
      const isMapped = hasRemapStartingWith(this.remaps, this.currentRemapMode(), key, whenEvaluator);
      if (!isMapped) {
        return this.configuration.useCtrlKeys && isBuiltInCtrlKey(key);
      }
    }

    return true;
  }

  private shouldPrepareInsertOrReplaceKey(key: string, whenEvaluator: WhenEvaluator): boolean {
    return this.remapIsPending()
      || hasRemapStartingWith(this.remaps, this.currentRemapMode(), key, whenEvaluator)
      || this.operatorStack.length > 0
      || key === "ctrl-k"
      || key === "ctrl-v"
      || key === "ctrl-r"
      || key === "ctrl-w"
      || key === "ctrl-u"
      || key === "ctrl-y"
      || key === "ctrl-e";
  }

  private shouldRecordInsertTextKeyThroughVim(key: string): boolean {
    return insertTextForKey(key) !== undefined && this.globalState.macro.isRecording();
  }

  private shouldHandleEscapeKey(): boolean {
    return this.modeState !== "normal"
      || this.hasMultipleCursorsOrSelection()
      || this.operatorStack.length > 0
      || this.keymapResolver.isPending()
      || this.easyMotion.isPending()
      || this.keyExecutor.isPending()
      || this.normalMode.isPending();
  }

  // External-state synchronization always ends in a canonical write-back: the
  // adopted Vim state is re-lowered through editor.setSelections so the native
  // selections, adapter cache, and rendered cursor cell agree with Vim after
  // every external event. Vim-sourced selection events are ignored by the
  // controller, so the write-back cannot feed back into this path.
  syncFromEditorState(options: CursorReconciliationOptions = {}): EditorSyncResult {
    const modeBeforeSync = this.modeState;
    const selections = this.editor.getSelections();
    const reconciliation = reconcileCursorState(
      { selections },
      { mode: this.modeState, selections },
      options
    );

    if (reconciliation.modeKind === "visual") {
      const visualSelection = reconciliation.selections.find(selection => selection.type === "charwise");
      const adopted = visualSelection !== undefined
        && this.visualMode.adoptSelection(visualSelection, {
          canonicalize: options.canonicalizeVisualSelection === true,
        });
      if (adopted) {
        this.clearPendingForExternalModeChange();
        this.insertOrigin = undefined;
        this.modeState = "visual";
        return { mode: this.modeState, ...reconciliation };
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
      mode: this.modeState,
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
    this.easyMotion.clear(this.editor);
    this.clearPendingRemaps();
    this.globalState.search.clearPending(this.editor, pendingSearch, { restoreViewport: closeSearchHighlights });
    this.searchOriginMode = undefined;
    this.handlerState.register = undefined;
    this.handlerState.countText = "";
    if (closeSearchHighlights && pendingSearch !== undefined) this.editor.clearSearchHighlights();
    this.operatorStack.clear();
    this.normalMode.clearPending();
  }

  private isPending(): boolean {
    return this.operatorStack.length > 0 || this.handlerState.register !== undefined || this.handlerState.countText.length > 0 || this.keymapResolver.isPending() || this.easyMotion.isPending() || this.keyExecutor.isPending() || (this.modeState === "normal" && this.normalMode.isPending());
  }

  // The pending-stack size behind [isPending]: each operator-stack entry is
  // one level, and a typed count, a selected register, a pending key-chord,
  // and a pending remap are one level each regardless of how many keystrokes
  // produced them (`2` and `21` are the same depth).
  private pendingDepth(): number {
    // The framework tracks its own pending entries (count, register, operator,
    // object, ...) as [HandlerState.operatorDepth] on the active continuation,
    // with a leading count folding into the operator it precedes. When the
    // executor is pending, that depth is the framework's contribution; the
    // legacy terms below are zero (and vice versa).
    const executorDepth = this.keyExecutor.isPending()
      ? this.keyExecutor.currentParserState().operatorDepth
      : 0;
    return this.operatorStack.length
      + (this.handlerState.register !== undefined ? 1 : 0)
      + (this.handlerState.countText.length > 0 ? 1 : 0)
      + (this.keymapResolver.isPending() ? 1 : 0)
      + (this.easyMotion.isPending() ? 1 : 0)
      + executorDepth;
  }

  private pendingChord(): string {
    // Prompt-like pending states render their editable input line (queries
    // support cursor movement and backspace, which a key log cannot show).
    // Everything else renders the showcmd buffer: the literal keys typed for
    // the command in flight.
    const pendingOperator = this.operatorStack.top();
    if (pendingOperator?.type === "search") return this.globalState.search.pendingChord(pendingOperator);
    if (pendingOperator?.type === "command") return `:${pendingOperator.input}`;
    if (this.easyMotion.isPending()) return this.easyMotion.pendingChord();
    return this.isPending() ? this.showcmdKeys.join("") : "";
  }

  // Zed: key dispatch normally arrives through GPUI actions registered by
  // `vim::Vim::action` and key contexts from `vim::Vim::extend_key_context`.
  // The VSCode patch calls this direct key entry point instead.
  onKey(key: string): KeyDispatchResult {
    return this.dispatchTypedKey(key, { allowRemap: true, whenEvaluator: alwaysActiveWhenEvaluator });
  }

  private dispatchTypedKey(key: string, { allowRemap, whenEvaluator }: { allowRemap: boolean; whenEvaluator: WhenEvaluator }): KeyDispatchResult {
    // Remap expansions re-enter through [dispatchKey] and bypass this append,
    // so the showcmd buffer shows remapped sequences as physically typed
    // (`x`, not its expansion). This intentionally differs from Vim's
    // showcmd, which displays the expanded typeahead. Macro and `.` replays
    // re-enter through [onKey] and do append: if a replay ends with a command
    // still pending, the chord shows the replayed keys that formed it.
    if (key === RemapTimeoutKey) return this.handleRemapTimeout(whenEvaluator);
    if (!this.isPending()) this.showcmdKeys.length = 0;
    this.showcmdKeys.push(key);
    const result = this.routeKeyThroughExecutor(key, { allowRemap, whenEvaluator });
    if (result === "native") this.showcmdKeys.pop();
    return result;
  }

  // The host fires [RemapTimeoutKey] after the timeout elapses while an
  // ambiguous remap is pending; accept the shorter side and replay any buffered
  // suffix. The when-evaluator is threaded so replayed keys resolve in context.
  private handleRemapTimeout(whenEvaluator: WhenEvaluator): KeyDispatchResult {
    if (!this.remapIsPending()) return "handled";
    const previousWhenEvaluator = this.dispatchWhenEvaluator;
    this.dispatchWhenEvaluator = whenEvaluator;
    try {
      this.keyExecutor.acceptConflict();
    } finally {
      this.dispatchWhenEvaluator = previousWhenEvaluator;
    }
    return "handled";
  }

  // Active typed handlers for the executor. Handlers it does not claim fall
  // through to the legacy dispatcher (see [dispatchThroughPipeline]). Ported
  // handlers are added here; the remap handler has highest priority.
  private executorHandlers(state: HandlerState): readonly HandlerEnv<void>[] {
    return [
      { handler: this.remapRootHandler(), state },
      { handler: this.normalRootHandler(), state },
    ];
  }

  // The migrated normal-mode grammar (count/register prefix + motions +
  // operators), defined in [normalModeHandler]. It is a pure handler graph;
  // the live editor/registers are injected into the handler state by
  // [normalRootHandler].
  private readonly normalGrammar: Handler<void> = normalModeHandler();

  // Apply the target mode the executor reports after running a framework action
  // (see [KeyExecutor.onEnterMode]). Only forward transitions the framework can
  // produce are wired: a `change` action targeting insert mode starts an insert
  // session. A target equal to the current mode is a no-op (e.g. motions target
  // normal mode); returning to normal happens via escape/explicit handling, not
  // here.
  private enterModeFromExecutor(
    mode: VimMode,
    opts?: { enterInsert?: { count: number; separator: string } }
  ): void {
    if (mode === "insert" && this.modeState !== "insert") {
      this.enterInsertMode({
        origin: "normal",
        count: opts?.enterInsert?.count ?? 1,
        separator: opts?.enterInsert?.separator ?? "",
      });
    }
  }

  // Feed a finite-keymap chord the framework grammar did not migrate (the
  // visual/search `g`-chords `gv`/`gn`/`gN`) to the legacy keymap resolver. This
  // bypasses [dispatchKey]'s recording (the framework already recorded these
  // keys for macros), and once the resolver goes pending any follow-up keys
  // route to legacy via the usual executor/legacy coexistence
  // ([isExecutorNormalContext]). The framework-owned [count] is handed to the
  // legacy count state, which the resolved action reads via [takeCount].
  private dispatchToLegacyKeymap(keys: readonly string[], count: number | undefined): void {
    if (count !== undefined) this.handlerState.countText = String(count);
    for (const key of keys) this.handleFiniteKeymapKey(key);
  }

  // Root of the migrated normal-mode grammar. It only begins a chord from a
  // clean state (no legacy subsystem pending; see [isExecutorNormalContext]) and
  // yields to a higher-priority remap. The live editor/registers travel in the
  // handler state so the grammar stays pure; count and register are owned by the
  // grammar's prefix handler (in the executor's env state).
  private normalRootHandler(): Handler<void> {
    return (key, state) => {
      if (!this.isExecutorNormalContext()) return unhandled();
      if (hasRemapStartingWith(this.remaps, this.currentRemapMode(), key, this.dispatchWhenEvaluator)) {
        return unhandled();
      }
      const liveState: HandlerState = {
        ...state,
        mode: "normal",
        editor: this.editor,
        registers: this.globalState.registers,
        marks: this.modelState.marks,
        find: this.globalState.find,
        changeList: this.modelState.changeList,
        lastInsertPosition: this.modelState.lastInsertPosition,
      };
      return this.normalGrammar(key, liveState);
    };
  }

  // Whether the executor may begin a normal-mode chord: normal mode, not a
  // CTRL-O excursion, and no legacy subsystem mid-chord. Count/register are
  // intentionally not checked here (the framework owns them), so a buffered
  // count does not block the next key.
  private isExecutorNormalContext(): boolean {
    // Note: [normalMode.isPending()] is intentionally not consulted — it is
    // [operatorStack.length > 0 || count present], and the count is now
    // framework-owned (a buffered count must not block the next framework key).
    // The operator-pending part is covered by the [operatorStack] check.
    return (
      this.modeState === "normal" &&
      !this.temporaryNormal &&
      this.operatorStack.length === 0 &&
      !this.keymapResolver.isPending() &&
      !this.easyMotion.isPending()
    );
  }

  // Root remap handler for the start of a fresh chord. It reads the live Vim
  // mode and when-evaluator on each key (continuations, once started, keep the
  // mode/evaluator captured when the chord began, matching the legacy path).
  private remapRootHandler(): Handler<void> {
    return (key, state) => {
      // [canStartRemap] is a Vim concern (no other pending subsystem); the
      // [allowRemap] flag is honored inside [remapHandler] itself.
      if (!this.canStartRemap()) return unhandled();
      const liveState: HandlerState = {
        ...state,
        mode: this.modeState,
        whenEvaluator: this.dispatchWhenEvaluator,
      };
      return remapHandler(this.remaps, this.currentRemapMode())(key, liveState);
    };
  }

  // Whether a brand-new remap chord may begin. A remap already in progress is
  // driven by the executor's pending continuations, so it does not consult
  // this; only the fresh-start root handler does.
  private canStartRemap(): boolean {
    return (
      !this.keymapResolver.isPending() &&
      !this.easyMotion.isPending() &&
      this.operatorStack.length === 0
    );
  }

  // Run one top-level key through the typed executor; if no handler claims it,
  // fall back to the legacy dispatcher and use its native/handled result. A key
  // the executor claims is always [handled].
  private routeKeyThroughExecutor(
    key: string,
    { allowRemap, whenEvaluator }: { allowRemap: boolean; whenEvaluator: WhenEvaluator }
  ): KeyDispatchResult {
    const previousWhenEvaluator = this.dispatchWhenEvaluator;
    this.dispatchWhenEvaluator = whenEvaluator;
    const versionBefore = this.editor.documentVersion();
    const modeBefore = this.modeState;
    try {
      if (this.handleThroughExecutor(key, allowRemap)) {
        // A framework command that edited the buffer must update the change list
        // (`g;`/`g,`), mirroring the legacy [dispatchKey] bookkeeping — framework
        // commands never reach [dispatchKey].
        if (this.editor.documentVersion() !== versionBefore) {
          this.modelState.changeList.record(this.editor, { insertMode: modeBefore === "insert" });
        }
        // A framework native command (`gd`/`gh`/...) that may have moved the
        // cursor or switched editors asks for the same post-command reconcile
        // the legacy `native` action did via [syncFromEditorState].
        if (this.keyExecutor.lastEffectSyncAfter()) this.syncFromEditorState();
        // A framework insert-entry command (`i`/`o`/...) into a readonly document
        // must revert to normal with a warning, like the legacy [dispatchKey]
        // finally.
        this.ensureNormalModeForReadonlyDocument();
        return "handled";
      }
      // The key fell through to legacy while the executor was mid-chord (e.g. a
      // buffered count/register from `2`/`"a`). Carry that pending count and
      // register into the legacy [handlerState] so the legacy operation can
      // consume them (e.g. `2cw`, `"add`). See [bridgePendingPrefixToLegacy].
      this.bridgePendingPrefixToLegacy();
      // Clear the executor's now-stale continuation *before* running the legacy
      // dispatcher: a legacy key can re-enter the executor (e.g. `.` replays its
      // recorded keys through [onKey]), which would otherwise be misrouted into
      // the leftover continuation.
      this.keyExecutor.reset(this.modeState);
      return this.dispatchKey(key);
    } finally {
      this.dispatchWhenEvaluator = previousWhenEvaluator;
    }
  }

  // TEMPORARY MIGRATION BRIDGE. Delete once operators and the simple-action
  // table are migrated onto the framework (at which point counted operations
  // like `2cw` are handled entirely by the executor and never fall through).
  //
  // The framework owns the normal-mode count/register prefix
  // ([prefixHandler]): a `2` or `"a` typed from a clean state is claimed by the
  // executor and accumulated in its pending parser state, not in the legacy
  // [handlerState]. When the following key is an operation that has not yet been
  // migrated (e.g. `c`), it falls through to the legacy dispatcher, which reads
  // the count/register from [handlerState]. Without this bridge that count and
  // register would be lost. Copy the executor's pending prefix into
  // [handlerState] just before yielding so legacy [takeCount]/register reads see
  // it. Only non-empty values are copied, so a count accumulated directly by the
  // legacy dispatcher (e.g. `d2w`, where `2` is typed with an operator already
  // pending and the executor is idle) is never clobbered.
  private bridgePendingPrefixToLegacy(): void {
    const pending = this.keyExecutor.currentParserState();
    if (pending.countText.length > 0) this.handlerState.countText = pending.countText;
    if (pending.register !== undefined) this.handlerState.register = pending.register;
  }

  // The bridge between the typed executor and the not-yet-migrated dispatcher,
  // used to re-dispatch keys the executor emits (remap expansions) or replays
  // (ambiguous-conflict suffixes): try the executor first, then legacy. The
  // when-evaluator is already established by the enclosing top-level dispatch.
  private dispatchThroughPipeline(key: string, allowRemap: boolean): void {
    if (this.handleThroughExecutor(key, allowRemap)) return;
    // See [bridgePendingPrefixToLegacy]: carry any framework-pending count/
    // register to legacy before yielding (temporary migration bridge).
    this.bridgePendingPrefixToLegacy();
    this.dispatchKey(key);
  }

  // Run a key through the executor and, when a migrated leaf handler claims it,
  // record it for macros/dot-repeat. The legacy dispatcher does this recording
  // for the keys it handles; a key the executor claims never reaches it, so the
  // recording is mirrored here. Remap keys are excluded: their expansion is
  // re-dispatched and recorded as it flows through this same path.
  private handleThroughExecutor(key: string, allowRemap: boolean): boolean {
    // A key the framework claims in normal context never reaches [dispatchKey],
    // so the per-key recording the legacy dispatcher does (macro + dot-repeat)
    // is mirrored here. Both dot-repeat and macros are keystroke-based: the
    // recorded keys are replayed back through [onKey]. Remapped keys are
    // excluded — the remap handler claims them and the expansion is recorded as
    // it flows through this path.
    const normalContext =
      this.isExecutorNormalContext() &&
      !hasRemapStartingWith(this.remaps, this.currentRemapMode(), key, this.dispatchWhenEvaluator);
    const recordable = normalContext && !this.globalState.repeat.isReplaying();
    // Commit any in-flight dot-repeat recording before this framework key,
    // mirroring legacy [dispatchKey]. A framework key never reaches
    // [dispatchKey], so without this a following command (e.g. `99<C-a>` then
    // `111<C-x>`) would extend the previous command's recording instead of
    // starting fresh.
    if (recordable) {
      this.globalState.repeat.maybeFinish({ mode: this.modeState, isPending: this.isPending() });
    }
    const modeBefore = this.modeState;
    const claimed = this.keyExecutor.handle(key, allowRemap);
    if (claimed && recordable) {
      // Macros are a verbatim transcript: record every claimed key, including a
      // chord-cancelling key (`d` then `.`).
      this.recordMacroKey(key);
      if (this.keyExecutor.lastHandleWasCancel()) {
        // The key cancelled a pending chord (e.g. `d.`): discard its partial
        // recording and do not record the cancelling key for dot-repeat, so the
        // real last change survives.
        this.globalState.repeat.cancelCurrent();
      } else {
        // Open a recording on the first key of the chord; count/register/command
        // keys are recorded literally. The command declares whether it is a
        // dot-repeatable change via its effect — discard when it is not
        // (motion/yank/mark), so it is never committed over the last change.
        this.globalState.repeat.beginRecording(modeBefore);
        this.globalState.repeat.recordKey(key);
        if (this.keyExecutor.lastEffectDotRepeatable() === false) this.globalState.repeat.cancelCurrent();
      }
    } else if (!claimed && recordable) {
      // A normal-context key fell through to legacy: the chord is not a framework
      // command, so discard any recording opened for an abandoned prefix (the
      // `3` of `3gu` or `3.`). The legacy dispatcher restarts it from the bridged
      // count via [maybeStart]'s seed. Insert-session keys fall through too but
      // are not [recordable] (mode is insert), so the open recording survives.
      this.globalState.repeat.cancelCurrent();
    }
    return claimed;
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
    if (this.modeState === "search" && (key === "ctrl-v" || key === "ctrl-y")) {
      return { registerName: "+" };
    }

    if (this.modeState === "normal") {
      // Paste reads its register; refresh the OS clipboard first when it targets
      // `+`/`*`. The register is framework-owned now (the executor's prefix), so
      // read it via [effectiveRegister] rather than the legacy [normalMode]
      // state, which is empty for a framework-typed `"+p`.
      if (key === "p" || key === "P") {
        const registerName = this.effectiveRegister();
        return registerName === undefined || isSystemClipboardRegister(registerName) ? { registerName } : undefined;
      }
      return this.normalMode.systemClipboardRegisterToReadForKey(key);
    }
    if (this.isVisualMode()) return this.visualMode.systemClipboardRegisterToReadForKey(key);
    return undefined;
  }

  private dispatchKey(key: string): KeyDispatchResult {
    // Cheap content stamp, not the document text: snapshotting/comparing the
    // whole document here made every keypress O(file size) on large files.
    const versionBefore = this.editor.documentVersion();
    const modeBefore = this.modeState;
    const temporaryNormalBefore = this.temporaryNormal;
    try {
      if (!this.globalState.repeat.isReplaying()) this.globalState.repeat.maybeFinish({ mode: this.modeState, isPending: this.isPending() });

      // Note: user-remap resolution happens earlier, in the typed [keyExecutor]
      // (see [remapRootHandler]); the legacy dispatcher below only runs for keys
      // the executor routes here via [onUnhandled], so it never remaps.

      // Zed: `vim_mode == waiting` contexts. One classification of what the
      // operator stack is waiting for, dispatched at one place; the precedence
      // list lives in [VimOperatorStack.waitingInput]. Only the self-escaping
      // classes (insert digraph/literal/register) see the escape key; for all
      // other waiting input the central escape handling cancels first.
      const waiting = this.operatorStack.waitingInput(this.modeState, key);
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

      if (this.easyMotion.isPending()) {
        this.recordMacroKey(key);
        this.recordRepeatableKey(key);
        const easyMotionResult = this.dispatchEasyMotionKey(key);
        if (easyMotionResult !== undefined) return easyMotionResult;
      }

      if (this.keymapResolver.isPending()) {
        this.recordMacroKey(key);
        this.recordRepeatableKey(key);
        const finiteKeymapResult = this.handleFiniteKeymapKey(key);
        if (finiteKeymapResult !== undefined) return finiteKeymapResult;
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

      const easyMotionResult = this.dispatchEasyMotionKey(key);
      if (easyMotionResult !== undefined) return easyMotionResult;

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
      if (this.editor.documentVersion() !== versionBefore) {
        this.modelState.changeList.record(this.editor, { insertMode: modeBefore === "insert" });
      }
      // Vim `i_CTRL-O`: once the one normal-mode command completes, return to
      // insert. Visual mode extends the excursion (Zed keeps `temp_mode`
      // through visual); entering another mode (`ctrl-o cw`) ends it.
      if (temporaryNormalBefore && this.temporaryNormal) {
        if (this.modeState === "normal" && !this.isPending()) {
          this.returnFromTemporaryNormal();
        } else if (this.modeState !== "normal" && !this.isVisualMode()) {
          this.temporaryNormal = false;
        }
      }
      this.ensureNormalModeForReadonlyDocument();
    }
  }

  private recordRepeatableKey(key: string): void {
    if (this.globalState.repeat.isReplaying()) return;
    this.globalState.repeat.maybeStart(key, { mode: this.modeState, pendingChord: this.normalPendingChordForRepeat() });
    this.globalState.repeat.recordKey(key);
  }

  private dispatchInsertLikeKey(key: string): KeyDispatchResult | undefined {
    if (this.modeState === "insert") {
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

    if (this.modeState === "replace") {
      const handler = this.replaceKeyHandlers.get(key);
      if (handler !== undefined) return handler();
      const text = insertTextForKey(key);
      if (text !== undefined) {
        this.replaceModeReplacements.push(...replaceModeText(this.editor, text, 1, this.insertEditOptions()));
        this.insertRepeatText += text;
        return "handled";
      }
      return "native";
    }

    return undefined;
  }

  private dispatchMotionModeKey(key: string): KeyResult | undefined {
    if (!shouldResolveMotionModeAction(this.keymapContext())) return undefined;
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
      const modeBefore = this.modeState;
      return this.applyVisualResult(this.visualMode.handleUnhandledKey(), modeBefore);
    }

    if (this.modeState !== "normal") return "native";

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
        this.replayMacro(() =>
          this.globalState.macro.replayRegisterKey(key, pending.count, replayKey => this.onKey(replayKey))
        );
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
        return this.applyVisualResult(this.visualMode.handlePendingSurroundKey(key), this.modeState);
      case "visualTextObject":
        this.recordWaitingOperatorKey(key);
        return this.applyVisualResult(this.visualMode.handlePendingTextObjectKey(key), this.modeState);
    }
  }

  private recordWaitingOperatorKey(key: string): void {
    this.recordMacroKey(key);
    this.recordRepeatableKey(key);
  }

  private dispatchEasyMotionKey(key: string): KeyResult | undefined {
    const result = this.easyMotion.handleKey(this.editor, this.configuration, key, {
      canStart: this.shouldStartEasyMotion(),
    });
    if (result === undefined) return undefined;
    if (result.type === "jump") {
      this.globalState.repeat.cancelCurrent();
      this.applyMotion({ type: "jump", position: result.position, line: false }, 1);
    }
    return "handled";
  }

  private handleFiniteKeymapKey(key: string): KeyResult | undefined {
    const { allowShared, allowNormal } = finiteKeymapPermissions(key, this.keymapContext());
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
          && this.modeState === "normal"
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
    const register = this.effectiveRegister();
    const base = register === undefined ? chord : `${chord}\"${register}`;
    // The dot-repeat seed must include a framework-owned count typed before the
    // command (e.g. the `3` of `3d3l`). The seed is captured *before* the command
    // key is handled, so the count is usually still the in-progress digits in
    // [countText] (not yet folded into [repeat]); fall back to the applied
    // [repeat] for the already-delegated case. The legacy count (in
    // [normalMode.pendingChord]) is empty for framework chords, so there is no
    // double-counting.
    const parser = this.keyExecutor.currentParserState();
    const countPrefix = !this.keyExecutor.isPending()
      ? ""
      : parser.countText.length > 0
        ? parser.countText
        : parser.hasCount === true
          ? String(parser.repeat)
          : "";
    return `${countPrefix}${base}`;
  }

  // The selected register, whether owned by the legacy dispatcher
  // ([handlerState.register]) or pending in the typed framework (the executor's
  // env state, e.g. after `"a` while the operator is still being typed). Reads
  // that happen before a key yields to legacy (the system-clipboard register
  // refresh, the dot-repeat seed) consult this so a framework-pending register
  // is visible. [pendingDepth]/[isPending] still read [handlerState.register]
  // directly so a framework-pending register is not double-counted with the
  // executor's own pending flag.
  private effectiveRegister(): RegisterName | undefined {
    return this.handlerState.register ?? this.keyExecutor.currentParserState().register;
  }

  private resolveKeymapAction(key: string, phase: VimKeymapPhase): VimAction | undefined {
    return resolveVimAction(key, phase, this.keymapContext());
  }

  // Zed: `vim::Vim::extend_key_context`.
  private keymapContext(): VimKeymapContext {
    return {
      mode: this.modeState,
      operator: this.operatorStack.operatorContext(),
      operatorPendingKey: this.modeState === "normal" ? this.operatorStack.operatorPendingKey() : undefined,
      hasSelectedRegister: this.handlerState.register !== undefined,
      expectsRegisterName: this.modeIsExpectingRegisterName(),
      countText: this.handlerState.countText,
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
      case "startCommand": {
        let input = "";
        if (this.isVisualMode()) {
          // Vim: `:` from visual mode sets the `'<`/`'>` marks and prefills
          // the command line with the visual range.
          const selection = this.editor.getSelections()[0];
          if (selection !== undefined) this.modelState.marks.setVisualSelectionMarks(this.editor, selection);
          this.visualMode.exit();
          input = "'<,'>";
        }
        this.operatorStack.push({ type: "command", input });
        this.setMode("command");
        return "handled";
      }
      case "forceMotion":
        this.operatorStack.forceMotion(action.force);
        return "handled";
      case "toggleVisual":
        if (this.isVisualMode()) {
          return this.applyVisualResult(this.visualMode.toggleMode(action.mode), this.modeState);
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
        this.searchOriginMode = this.modeState;
        this.operatorStack.push(this.globalState.search.start(action.backwards, this.editor));
        this.setMode("search");
        return "handled";
      case "searchUnderCursor":
        this.applySearchUnderCursor({ backwards: action.backwards });
        return "handled";
      case "motion":
        if (!(this.modeState === "normal" && this.normalMode.pendingOperatorName() !== undefined)) {
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
        return this.applyVisualResult(this.visualMode.handleCommand(action.command), this.modeState);
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
        if (this.modeState === "normal") this.enterInsertAtPrevious();
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
        if (nextMode !== undefined) this.modeState = nextMode;
        return "handled";
      }
      case "searchSelection":
        this.applySearchSelection({ reversed: action.reversed, count: this.takeCountForMotion(1) });
        return "handled";
      case "pushConvert":
        if (this.modeState === "normal") {
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
        if (this.modeState === "normal") {
          return this.applyNormalResult(this.normalMode.joinLines({ insertWhitespace: action.insertWhitespace }));
        } else if (this.isVisualMode()) {
          this.visualMode.joinSelections({ insertWhitespace: action.insertWhitespace });
          this.setMode("normal");
        }
        return "handled";
      case "incrementStep": {
        const count = this.takeCountForMotion(1);
        const delta = (action.direction === "increment" ? 1 : -1) * count;
        // Vim: a visual operator moves the cursor to the selection start
        // before changing text, so that is where `u` later restores it.
        if (this.isVisualMode()) {
          const selection = this.editor.getSelections()[0];
          if (selection !== undefined) {
            this.editor.beginUndoTransaction([charwiseSelection(rangeOfSelection(selection).start)]);
          }
        }
        incrementNumbers(this.editor, delta, action.cumulative ? delta : 0);
        this.editor.finishUndoTransaction();
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
      case "editorTab":
        this.globalState.repeat.cancelCurrent();
        this.switchEditorTab(action.direction, this.takeCount(undefined));
        return "handled";
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
        this.editor.scrollByLines(action.direction, this.takeCountForMotion(1), { extend: this.isVisualMode() });
        if (this.isVisualMode()) this.visualMode.adoptSelectionFromHost();
        return "handled";
      case "revealCurrentLine":
        this.editor.revealCurrentLine(action.target);
        return "handled";
      case "fold":
        this.editor.executeFoldCommand(action.command);
        this.syncFromEditorState();
        return "handled";
    }
  }

  private switchEditorTab(direction: "next" | "previous", count: number | undefined): void {
    if (count !== undefined && count <= 0) return;

    if (direction === "next" && count !== undefined) {
      // VSCodeVim follows Vim's `{count}gt`: jump to the one-based tab index
      // instead of repeating next-tab movement.
      this.editor.executeNativeCommand("workbench.action.openEditorAtIndex", [count - 1], { syncSelectionAfter: true });
      return;
    }

    const command = direction === "next"
      ? "workbench.action.nextEditorInGroup"
      : "workbench.action.previousEditorInGroup";
    for (let index = 0; index < (count ?? 1); index++) {
      this.editor.executeNativeCommand(command, [], { syncSelectionAfter: true });
    }
  }

  private handlePendingRegisterKey(key: string): void {
    const registerName = parseRegisterName(key);
    if (registerName !== undefined) {
      this.handlerState.register = registerName;
      return;
    }
    if (this.modeState === "normal") this.normalMode.clearPending();
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
    if (this.modeState !== "normal") return undefined;

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
      this.replayMacro(() =>
        this.globalState.macro.replayLast(this.normalMode.takeCountForMotion(1), replayKey => this.onKey(replayKey))
      );
      return "handled";
    }

    return undefined;
  }

  private replayMacro(run: () => void): void {
    const undoTransaction = this.editor.beginUndoTransaction(this.editor.getSelections());
    try {
      run();
    } finally {
      undoTransaction.finish(this.editor.getSelections());
    }
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
    if (this.modeState === "normal" && this.hasMultipleCursorsOrSelection()) {
      this.collapseToFirstCursor();
      return;
    }
    if (this.modeState === "search" || this.modeState === "command") {
      this.setMode("normal");
      return;
    }
    if (this.modeState !== "normal") {
      const modeBeforeEscape = this.modeState;
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

  private applyVisualResult(result: VisualKeyResult, modeBefore: VimMode): KeyResult {
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
        origin: this.modeState,
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

  // Vim `i_CTRL-O`: leave insert for exactly one normal-mode command. Unlike
  // escape, the cursor does not shift left; it stays on the cell at the
  // insert position (clamped from an end-of-line boundary).
  private enterTemporaryNormalMode(): KeyResult {
    this.finishInsertOrReplaceSession("insert");
    enterNormalMode(this.editor, { moveLeft: false });
    this.insertOrigin = undefined;
    this.setMode("normal");
    this.editor.finishUndoTransaction(this.editor.getSelections());
    this.temporaryNormal = true;
    return "handled";
  }

  private returnFromTemporaryNormal(): void {
    this.temporaryNormal = false;
    // Vim `i_CTRL-O $`: an end-of-line motion returns to insert at the line
    // end boundary, not on the last character.
    const selection = this.editor.getSelections()[0];
    if (selection !== undefined && selection.type === "charwise" && selection.goal?.type === "endOfLine") {
      const head = selectionHead(selection);
      this.editor.setSelections([charwiseSelection({ row: head.row, column: this.editor.lineLength(head.row) })]);
    }
    this.editor.setCursorStyle("line");
    this.enterInsertMode({ origin: "normal" });
  }

  private returnToNormalForReadonlyDocument(): void {
    this.readonlyWarningUntil = Date.now() + readonlyWarningDurationMs;
    this.clearPendingGrammar({ closeSearchHighlights: true });
    if (this.isVisualMode()) this.visualMode.clearState();
    this.pendingVisualRepeatChange = undefined;
    this.clearInsertOrReplaceSession();
    this.replaceModeReplacements = [];
    this.insertOrigin = undefined;
    this.temporaryNormal = false;
    const head = selectionHead(this.editor.getSelections()[0]);
    this.editor.setSelections([charwiseSelection(normalCursorPosition(this.editor, head))]);
    this.editor.setCursorStyle("block");
    this.setMode("normal");
    this.editor.setInsertPendingText(undefined);
    this.editor.flushUndoTransaction();
  }

  private readonlyWarningRemainingMs(): number | undefined {
    const remaining = this.readonlyWarningUntil - Date.now();
    return remaining > 0 ? remaining : undefined;
  }

  private enterInsertMode({ origin, count = 1, separator = "" }: { origin: VimMode; count?: number; separator?: string }): void {
    this.modelState.marks.setBuiltinMark(".", selectionHead(this.editor.getSelections()[0]));
    this.insertOrigin = origin;
    this.startInsertOrReplaceSession({ count, separator });
    this.setMode("insert");
  }

  // Zed: `replace::Vim::undo_replace` — backspace in replace mode restores
  // what was overwritten in this session, or just moves left otherwise.
  private undoReplace(): KeyResult {
    const selection = this.editor.getSelections()[0];
    if (selection === undefined) return "handled";
    const end = selectionHead(selection);
    const start = end.column > 0
      ? { row: end.row, column: end.column - 1 }
      : end.row > 0
        ? { row: end.row - 1, column: this.editor.lineLength(end.row - 1) }
        : end;
    let original: string | undefined;
    for (let index = this.replaceModeReplacements.length - 1; index >= 0; index--) {
      const replacement = this.replaceModeReplacements[index];
      if (comparePositions(replacement.start, start) <= 0 && comparePositions(replacement.end, end) >= 0) {
        original = replacement.original;
        this.replaceModeReplacements.splice(index, 1);
        break;
      }
    }
    if (original !== undefined) {
      this.editor.applyEdits(
        [{ range: { start, end }, text: original }],
        [charwiseSelection(start)],
        this.insertEditOptions()
      );
    } else {
      this.editor.setSelections([charwiseSelection(start)]);
    }
    this.insertRepeatText = this.insertRepeatText.slice(0, -1);
    return "handled";
  }

  private enterReplaceMode({ count, separator }: { count: number; separator: string }): void {
    this.replaceModeReplacements = [];
    this.startInsertOrReplaceSession({ count, separator });
    this.editor.setCursorStyle("block");
    this.setMode("replace");
  }

  private setMode(mode: VimMode): void {
    this.modeState = mode;
  }

  private enterInsertAtPrevious(): void {
    const position = this.modelState.lastInsertPosition;
    if (position !== undefined) this.editor.setSelections([charwiseSelection(position)]);
    this.editor.setCursorStyle("line");
    this.enterInsertMode({ origin: this.modeState, count: this.takeCountForMotion(1) });
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
    // The keys typed during the insert session were already logged into the
    // dot-repeat and macro buffers as they flowed through [dispatchKey]; the
    // terminating `<escape>` is logged by [recordEscapeKey]. So `.`/macro replay
    // re-runs `cwhello<escape>` verbatim — no separate insert-text recording.
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

  // A remap is pending precisely when the executor holds an ambiguous chord
  // (shorter accepted but a longer mapping is still possible). Every pending
  // remap chord goes through a conflict, so this is sufficient while the remap
  // handler is the only thing the executor hosts.
  private remapIsPending(): boolean {
    return this.keyExecutor.pendingConflict() !== undefined;
  }

  // Pending remap continuations, exposed only for the insert-mode chord preview
  // ([pendingRemapInsertText]). Empty unless a remap chord is in flight.
  private pendingRemapEnvsForStatus(): readonly HandlerEnv<void>[] {
    return this.remapIsPending() ? this.keyExecutor.currentHandlers() : [];
  }

  private clearPendingRemaps(): void {
    this.keyExecutor.reset(this.modeState);
  }

  private currentRemapMode() {
    return remapModeForVimMode(this.modeState, {
      operatorPending: this.modeState === "normal" && this.normalMode.pendingOperatorName() !== undefined,
    });
  }

  private executeMappedCommand(command: NormalizedRemapping["commands"][number]): void {
    if (typeof command === "string") {
      if (command.startsWith(":")) executeCommand(this.editor, command.slice(1), { runNormalKeys: (keys, range) => this.runNormalKeysForCommand(keys, range), exOptions: this.globalState.exOptions, markLine: name => this.modelState.marks.position(name)?.row });
      else this.editor.executeNativeCommand(command, [], { preserveVisualSelection: this.isVisualMode() });
      return;
    }

    if (command.command.startsWith(":")) {
      executeCommand(this.editor, command.command.slice(1), { runNormalKeys: (keys, range) => this.runNormalKeysForCommand(keys, range), exOptions: this.globalState.exOptions, markLine: name => this.modelState.marks.position(name)?.row });
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

  private shouldStartEasyMotion(): boolean {
    return this.isMotionMode()
      && !this.modeIsExpectingRegisterName()
      && this.operatorStack.operatorContext() === "none"
      && this.handlerState.countText.length === 0
      && this.handlerState.register === undefined;
  }

  private applySearchUnderCursor({ backwards }: { backwards: boolean }): void {
    const motion = this.modeState === "normal"
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
    this.globalState.find.record(motion);
    this.applyMotion(motion, pending.count);
  }

  private repeatFind({ reversed }: { reversed: boolean }): void {
    const motion = this.globalState.find.repeat(reversed);
    if (motion === undefined) return;
    this.applyMotion(motion, this.takeCountForMotion(1));
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
        this.replaceModeReplacements.push(...replaceModeText(this.editor, text, 1, this.insertEditOptions()));
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
    if (this.modeState === "replace") {
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
        exOptions: this.globalState.exOptions,
        markLine: name => this.modelState.marks.position(name)?.row,
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
      if (this.modeState === "insert") this.onKey("<escape>");
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
        if (selection.type === "visualBlock") {
          this.replayBlockInsert(selection, action.insertedText);
          return;
        }
        const range = this.rangeForRecordedSelection(selection);
        if (range === undefined) return;
        this.editor.applyEdits([{ range, text: action.insertedText }], [charwiseSelection(range.start)]);
        return;
      }
    }
  }

  // Vim: repeating a visual-block insert applies the inserted text at the
  // cursor column on the same number of rows, skipping lines that end before
  // the block's left edge (like the original block insert).
  private replayBlockInsert(selection: Extract<RecordedSelection, { type: "visualBlock" }>, insertedText: string): void {
    if (insertedText.length === 0) return;
    const start = selectionHead(this.editor.getSelections()[0]);
    const endRow = Math.min(start.row + selection.rows, this.editor.lineCount() - 1);
    const edits: TextEdit[] = [];
    for (let row = start.row; row <= endRow; row++) {
      if (this.editor.lineLength(row) < start.column) continue;
      const position = { row, column: start.column };
      edits.push({ range: { start: position, end: position }, text: insertedText });
    }
    if (edits.length === 0) return;
    const cursor = { row: start.row, column: start.column + insertedText.length - 1 };
    this.editor.applyEdits(edits, [charwiseSelection(normalCursorPosition(this.editor, cursor))]);
  }

  private rangeForRecordedSelection(selection: RecordedSelection): TextRange | undefined {
    const start = selectionHead(this.editor.getSelections()[0]);
    switch (selection.type) {
      case "none":
        return undefined;
      case "charwise":
        if (selection.rowDelta === 0) {
          return { start, end: this.charwiseRepeatEnd(start, selection.columnDelta) };
        }
        return this.charwiseMultilineRepeatRange(start, selection);
      case "visualLine": {
        const endRow = Math.min(this.editor.lineCount() - 1, start.row + selection.rows);
        return { start: { row: start.row, column: 0 }, end: { row: endRow, column: this.editor.lineLength(endRow) } };
      }
      case "visualBlock":
        // Block-shaped repeats are replayed by [replayBlockInsert].
        return undefined;
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

  private charwiseMultilineRepeatRange(start: ReturnType<typeof selectionHead>, selection: Extract<RecordedSelection, { type: "charwise" }>): TextRange {
    const targetRow = Math.min(start.row + selection.rowDelta, this.editor.lineCount() - 1);
    if (targetRow === start.row) {
      // Vim: a multi-row charwise repeat clamped to the last line keeps the
      // recorded end column on that line, selecting backward from the cursor
      // when the recorded end falls before it.
      const lineLength = this.editor.lineLength(targetRow);
      const endCell = {
        row: targetRow,
        column: Math.min(Math.max(0, selection.endColumn - 1), Math.max(0, lineLength - 1)),
      };
      const [first, last] = comparePositions(endCell, start) < 0 ? [endCell, start] : [start, endCell];
      return { start: first, end: { row: last.row, column: Math.min(last.column + 1, lineLength) } };
    }
    return {
      start,
      end: { row: targetRow, column: Math.min(selection.endColumn, this.editor.lineLength(targetRow)) },
    };
  }

  private applySearchSelection({ reversed, count }: { reversed: boolean; count: number }): void {
    const includeStart = this.modeState === "normal";
    const range = this.globalState.search.matchRangeForSelection(this.editor, { reversed, count, includeStart });
    if (range === undefined) {
      // Vim: `cgn` with no match aborts the pending operator without editing,
      // and `.`-replaying an aborted `cgn` swallows the rest of the recording
      // (the recorded insert text must not run as normal-mode keys).
      if (this.modeState === "normal" && this.normalMode.pendingOperatorName() !== undefined) {
        this.normalMode.clearPending();
        this.globalState.repeat.abortCurrentReplay();
      }
      return;
    }
    if (this.modeState === "normal" && this.normalMode.pendingOperatorName() !== undefined) {
      const enterInsert = this.normalMode.applyMotion({ type: "searchMatch", range }, 1);
      if (enterInsert) this.modeState = "insert";
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
      this.modeState = "visual";
    }
  }

  private applyMotion(motion: Motion, count: number): void {
    if (this.modeState === "normal") {
      const modeBeforeMotion = this.modeState;
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
    return this.modeState === "normal" || this.isVisualMode();
  }

  private modeIsExpectingRegisterName(): boolean {
    return this.operatorStack.activeTopLevel("register") !== undefined;
  }

  private isVisualMode(): boolean {
    return isVisualModeKind(this.modeState);
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
  if (key.length === 1) return key;
  // A single astral character (e.g. an emoji from a remap replacement) is one
  // key even though it spans two UTF-16 units.
  if (key.length === 2 && key.charCodeAt(0) >= 0xd800 && key.charCodeAt(0) <= 0xdbff) return key;
  return undefined;
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
    case "ctrl-pageup":
    case "ctrl-pagedown":
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
