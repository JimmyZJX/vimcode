// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `vim::Vim`
// - translated concepts: main Vim state holder and high-level mode dispatch
// - intentional differences: GPUI action registration is replaced by direct key dispatch
//   from the VSCode patch / tests.

import { CommandLine, CommandOptions, CommandStatusReport, LineRange, commandRegisterToRead, executeCommand, substitutePreviews } from "./command.js";
import { commandModeHandler } from "./command_handler.js";
import { RemapTimeoutKey, defaultVimConfiguration, mergeVimConfiguration, normalizeKey, remapModeForVimMode } from "./config.js";
import type { NormalizedRemapping, WhenEvaluator, VimCommandMapping, VimConfiguration } from "./config.js";
import { EasyMotionState } from "./easymotion.js";
import { nextGraphemeBoundary } from "./grapheme.js";
import { collapseSelectionsToNormalCursors, collapseToPrimaryNormalCursor, hasMultipleCursorsOrSelection, reconcileCursorState } from "./editor_state_sync.js";
import type { CursorReconciliationOptions } from "./editor_state_sync.js";
import { VimEditorCapabilities, insertTextForKey, keepUndoTransactionOpen, normalCursorPosition } from "./editor.js";
import { enterNormalMode, insertText } from "./insert.js";
import { initialHandlerState, isEscapeKey, unhandled } from "./key_handler.js";
import type { HandleResult, Handler, HandlerEnv, HandlerState, QueuedRunResult } from "./key_handler.js";
import { KeyExecutor } from "./key_executor.js";
import { Motion } from "./motion.js";
import { NormalMode } from "./normal.js";
import { normalModeHandler } from "./normal_mode_handler.js";
import { easyMotionHandler } from "./easymotion_handler.js";
import { insertModeHandler, replaceModeHandler } from "./insert_handler.js";
import { searchModeHandler } from "./search_handler.js";
import { visualModeHandler } from "./visual_handler.js";
import { RangeOperator, applyOperatorToTarget } from "./operator_target.js";
import { MacroRecordingStatus, RecordedKey, RecordedSelection, VisualRepeatAction } from "./normal/repeat.js";
import type { PendingSearch } from "./normal/search.js";
import type { SearchStatus } from "./search.js";
import { RegisterName, Registers } from "./registers.js";
import { DebugRemapConflict, createRemaps, debugRemapConflicts, handleKeyOverride as remapKeyOverride, hasRemapStartingWith, pendingRemapInsertText, remapHandler } from "./remap.js";
import type { Remaps } from "./remap.js";
import type { VimSystemClipboard } from "./registers.js";
import { indentRanges } from "./normal/indent.js";
import { ReplacedText, replaceModeText } from "./replace.js";
import { KeyDispatchResult, KeyResult, TextEdit, TextRange, VimMode, charwiseSelection, comparePositions, isVisualModeKind, selectionHead, vimModeName } from "./state.js";
import { VisualMode, visualKindForMode } from "./visual.js";
import type { VisualResultMode } from "./visual.js";
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
  /** A prompt (`/`?`/`:`) swallowed this key (display-formatted); shown as a
      transient warning (see [swallowedKeyWarningRemainingMs]). */
  swallowedKeyWarning: string | undefined;
  swallowedKeyWarningRemainingMs: number | undefined;
  /** Search feedback (Vim `[x/y]` / E486): match count or failed pattern.
      Sticky while the prompt is open (remaining ms undefined), timed after a
      commit or `n`/`N`. */
  searchStatus: SearchStatus | undefined;
  searchStatusRemainingMs: number | undefined;
  /** Ex-command outcome (Vim `:h 'report'` messages plus E486/E35): "3 fewer
      lines", "4 substitutions on 3 lines", "Pattern not found: foo". */
  commandStatus: CommandStatusReport | undefined;
  commandStatusRemainingMs: number | undefined;
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

// A key Vim wants to act on. [passthrough] is the third ownership state (besides
// "owned" and "native/null"): the host should still handle the key natively — the
// controller must NOT [preventDefault] — but Vim runs [run] to *record* it (an
// insert-mode passthrough character; see [Vim.isInsertPassthroughKey]). For an
// owned key [passthrough] is false and the controller prevents default as usual.
// The single grammar evaluation from [handleKey], carried into the plan and
// committed by the dispatcher — unless the executor state moved in between
// (keys racing ahead of their queued commits), in which case the dispatcher
// re-parses against the fresh state (see [KeyExecutor.currentGeneration]).
type PreParsedKey = { result: HandleResult<void>; claimed: boolean; generation: number };

type VimExecutionContext = {
  clipboard: VimSystemClipboard | undefined;
  whenEvaluator: WhenEvaluator;
};

export type KeyPlan = {
  passthrough: boolean;
  run: (env?: {
    clipboard?: VimSystemClipboard;
    replay?: boolean;
    executionContext?: VimExecutionContext;
  }) => Promise<void>;
};

const alwaysActiveWhenEvaluator: WhenEvaluator = () => true;

// Modes the typed executor owns handlers for besides `normal`: the `search`
// prompt and the visual kinds. Mode transitions touching these resync the
// executor (see [Vim.setMode]).
function isExecutorOwnedNonNormalMode(mode: VimMode): boolean {
  return mode === "search" || mode === "command" || isVisualModeKind(mode);
}

// The mode FSM state *and* the session data that exists only in that mode.
// Modeling the prompt sessions as payloads of their mode makes the
// inconsistent combinations unrepresentable at the type level: there is no way
// to hold a `PendingSearch` outside `search` mode, to be in `search` mode
// without a prompt, or to leave `search`/`command` without giving the payload
// up (the successor session has no slot for it). See
// doc/key-handler-refactor.md "Mode/session-state ownership".
type ModeSession =
  | { mode: Exclude<VimMode, "search" | "command"> }
  | {
      mode: "search";
      // The in-flight `/`?` prompt, driven by the search-mode grammar.
      search: PendingSearch;
      // The mode the prompt was opened from: a visual-kind origin extends the
      // selection on completion and is restored when the prompt is aborted.
      origin: VimMode;
    }
  // The `:` command line (prefilled with `'<,'>` from a visual origin, which
  // exits visual on entry — a deliberate simplification of Neovim, which keeps
  // the selection highlighted until the command line is first edited).
  | { mode: "command"; command: CommandLine };



;
const readonlyWarningDurationMs = 2000;
const swallowedKeyWarningDurationMs = 2000;
const searchNotFoundStatusDurationMs = 1000;
const searchCountStatusDurationMs = 3000;
const commandStatusDurationMs = 3000;

function finishQueued(result: QueuedRunResult<void>, cleanup: () => void): QueuedRunResult<void> {
  if (result !== undefined && typeof (result as Promise<void>).then === "function") {
    return Promise.resolve(result).finally(cleanup);
  }
  cleanup();
}

export { VimGlobalState, VimModelState };

// Zed: `vim::Vim`. This class is the local main state holder; GPUI
// entity/window fields are intentionally replaced by the injected
// `VimEditorCapabilities`.
export class Vim {
  private session: ModeSession = { mode: "normal" };
  private get modeState(): VimMode {
    return this.session.mode;
  }
  private readonly easyMotion = new EasyMotionState();
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
    redispatch: (key, allowRemap) => this.redispatchThroughExecutionContext(key, allowRemap),
    executeCommand: command => this.executeMappedCommand(command),
    beforeEffect: action => {
      this.effectChangeSnapshots.set(action, {
        version: this.editor.documentVersion(),
        mode: this.modeState,
      });
      const registerToRead = action.registerToRead;
      return registerToRead === undefined
        ? undefined
        : this.registers.refreshSystemClipboardRegister(registerToRead.registerName);
    },
    afterEffect: action => {
      const snapshot = this.effectChangeSnapshots.get(action);
      if (snapshot !== undefined && this.editor.documentVersion() !== snapshot.version) {
        this.modelState.changeList.record(this.editor, { insertMode: snapshot.mode === "insert" });
        this.lastEffectRecordedChangeVersion = this.editor.documentVersion();
      }
      this.runPendingReplaysWhenReady();
      if (action.temporaryInsertAfter) this.prepareTemporaryInsertAfter();
      this.finishTemporaryNormalCommand();
    },
    onEnterMode: (mode, opts) => this.enterModeFromExecutor(mode, opts),
  });
  // The when-evaluator for the in-flight top-level dispatch, read by the remap
  // root handler (which resolves against the live Vim mode) and the executor's
  // command callback.
  private dispatchWhenEvaluator: WhenEvaluator = alwaysActiveWhenEvaluator;
  private activeExecutionContext: VimExecutionContext | undefined;
  private readonly effectChangeSnapshots = new WeakMap<object, { version: number; mode: VimMode }>();
  private lastEffectRecordedChangeVersion: number | undefined;
  // Convenience views of the [session] payloads (see [ModeSession]): defined
  // exactly while the corresponding prompt mode is active, by construction.
  private get searchOriginMode(): VimMode | undefined {
    return this.session.mode === "search" ? this.session.origin : undefined;
  }
  private get activeSearch(): PendingSearch | undefined {
    return this.session.mode === "search" ? this.session.search : undefined;
  }
  private get activeCommand(): CommandLine | undefined {
    return this.session.mode === "command" ? this.session.command : undefined;
  }
  private insertRepeatCount = 1;
  private insertRepeatText = "";
  // Zed: `Vim::replacements` — what replace mode overwrote, for backspace.
  private replaceModeReplacements: ReplacedText[] = [];
  private insertRepeatSeparator = "";
  private insertOrigin: VimMode | undefined;
  // Vim `i_CTRL-O` (Zed: `Vim::temp_mode`): one normal-mode command from
  // insert mode, then back to insert.
  private temporaryNormal = false;
  private deferTemporaryNormalCompletion = 0;
  private readonlyWarningUntil = 0;
  private swallowedKeyWarning: string | undefined = undefined;
  private swallowedKeyWarningUntil = 0;
  private searchStatus: SearchStatus | undefined = undefined;
  /** Undefined = sticky (an open prompt owns the status). */
  private searchStatusUntil: number | undefined = undefined;
  private commandStatus: CommandStatusReport | undefined = undefined;
  private commandStatusUntil = 0;

  private readonly registers: Registers;
  private pendingCompositeUndoTransaction: ReturnType<VimEditorCapabilities["beginUndoTransaction"]> | undefined;
  private readonly normalMode: NormalMode;
  private readonly visualMode: VisualMode;

  constructor(
    private readonly editor: VimEditorCapabilities,
    configuration: Partial<VimConfiguration> = {},
    private readonly globalState: VimGlobalState = new VimGlobalState(),
    modelState: VimModelState = new VimModelState()
  ) {
    this.modelState = modelState;
    this.registers = globalState.registers.scoped();
    this.configuration = mergeVimConfiguration(configuration);
    this.remaps = createRemaps(this.configuration);
    this.registers.setUseSystemClipboard(this.configuration.useSystemClipboard);
    this.editor.setCursorStyle("block");
    this.handlerState.editor = editor;
    this.handlerState.registers = this.registers;
    this.normalMode = new NormalMode(editor, {
      get: () => this.effectiveRegister(),
      take: () => this.takeSelectedRegister(),
      clear: () => this.clearSelectedRegister(),
    }, {
      get: () => this.handlerState.countText,
      append: key => this.appendCountKey(key),
      take: defaultValue => defaultValue === undefined ? this.takeCount(undefined) : this.takeCount(defaultValue),
      clear: () => this.clearCount(),
    });
    this.visualMode = new VisualMode(editor, this.registers, {
      get: () => this.effectiveRegister(),
      take: () => this.takeSelectedRegister(),
      clear: () => this.clearSelectedRegister(),
    }, {
      get: () => this.handlerState.countText,
      append: key => this.appendCountKey(key),
      take: defaultValue => defaultValue === undefined ? this.takeCount(undefined) : this.takeCount(defaultValue),
      clear: () => this.clearCount(),
    }, this.configuration);
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
    this.registers.setUseSystemClipboard(this.configuration.useSystemClipboard);
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
    const swallowedKeyWarningRemainingMs = this.swallowedKeyWarningRemainingMs();
    const searchStatusRemainingMs = this.searchStatusRemainingMs();
    const commandStatusRemainingMs = this.commandStatusRemainingMs();
    return {
      mode,
      pending: this.isPending(),
      pendingDepth: this.pendingDepth(),
      // The legacy operator name is gone with the legacy grammar; framework
      // operator-pending state is visible via [pending]/[pendingDepth]. (The
      // `vim.operator` context key has not carried framework operators — a
      // known gap to restore from executor state if needed.)
      operator: undefined,
      chord,
      text,
      remapPending: this.remapIsPending(),
      remapTimeoutMs: this.configuration.timeout,
      insertPendingText: mode === "insert" || mode === "replace" ? pendingRemapInsertText(this.pendingRemapEnvsForStatus()) : undefined,
      macroRecording,
      readonlyWarning: readonlyWarningRemainingMs !== undefined,
      readonlyWarningRemainingMs,
      swallowedKeyWarning: swallowedKeyWarningRemainingMs !== undefined ? this.swallowedKeyWarning : undefined,
      swallowedKeyWarningRemainingMs,
      searchStatus: this.searchStatusVisible() ? this.searchStatus : undefined,
      searchStatusRemainingMs,
      commandStatus: commandStatusRemainingMs !== undefined ? this.commandStatus : undefined,
      commandStatusRemainingMs,
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
    return this.registers.read(name);
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
    // The remap-timeout pseudo-key never reaches the grammar ([dispatchTypedKey]
    // intercepts it); it is owned exactly while a remap chord is pending.
    if (key === RemapTimeoutKey) {
      const pendingWhenEvaluator = this.keyExecutor.currentParserState().whenEvaluator;
      return this.remapIsPending() ? this.keyPlan(key, pendingWhenEvaluator, false, undefined) : null;
    }
    const override = this.handleKeyOverride(key);
    if (override === false) return null;
    // Ownership comes from the real grammar: evaluate the key once, purely
    // (every handler defers its side effects), and decide from whether a
    // handler claims it. The plan commits this same evaluation (see
    // [PreParsedKey]).
    const previousWhenEvaluator = this.dispatchWhenEvaluator;
    this.dispatchWhenEvaluator = whenEvaluator;
    let parsed: PreParsedKey;
    try {
      parsed = this.keyExecutor.parse(key, true);
    } finally {
      this.dispatchWhenEvaluator = previousWhenEvaluator;
    }
    const ownership = override === true ? "owned" : this.keyOwnership(key, parsed, whenEvaluator);
    if (ownership === null) return null;
    return this.keyPlan(key, whenEvaluator, ownership === "passthrough", parsed);
  }

  private keyPlan(key: string, whenEvaluator: WhenEvaluator, passthrough: boolean, preParsed: PreParsedKey | undefined): KeyPlan {
    return {
      passthrough,
      run: async ({
        clipboard,
        replay = false,
        executionContext,
      }: {
        clipboard?: VimSystemClipboard;
        replay?: boolean;
        executionContext?: VimExecutionContext;
      } = {}) => {
        const ownsExecutionContext = executionContext === undefined;
        const context = executionContext ?? { clipboard, whenEvaluator };
        try {
          await this.registers.withSystemClipboard(context.clipboard, async () => {
            const previousContext = this.activeExecutionContext;
            this.activeExecutionContext = context;
            try {
              let parsedAtRun = key === RemapTimeoutKey
                ? undefined
                : this.preParsedKeyAtRun(key, whenEvaluator, preParsed);
              const registerToRead = this.registerReadFromParsed(parsedAtRun);
              if (registerToRead !== undefined) {
                await this.registers.refreshSystemClipboardRegister(registerToRead.registerName);
                // Register availability can affect command metadata such as dot
                // repeatability, so rebuild the pure action against fresh state.
                parsedAtRun = this.parseKeyAtRun(key, whenEvaluator);
              }
              const undoTransaction = this.compositeUndoTransaction(parsedAtRun);
              try {
                this.dispatchTypedKey(key, {
                  allowRemap: true,
                  whenEvaluator,
                  passthrough: replay ? false : passthrough,
                  preParsed: parsedAtRun,
                });
                await this.keyExecutor.whenIdle();
                if (ownsExecutionContext) await this.drainPendingReplays(context);
              } finally {
                if (undoTransaction !== undefined) {
                  if (this.modeState === "insert" || this.modeState === "replace") {
                    this.pendingCompositeUndoTransaction?.finish(this.editor.getSelections());
                    this.pendingCompositeUndoTransaction = undoTransaction;
                  } else {
                    undoTransaction.finish(this.editor.getSelections());
                  }
                }
              }
            } finally {
              this.activeExecutionContext = previousContext;
            }
          });
        } catch (error) {
          this.keyExecutor.reset(this.modeState);
          this.finishTemporaryNormalCommand();
          throw error;
        }
      },
    };
  }

  private preParsedKeyAtRun(
    key: string,
    whenEvaluator: WhenEvaluator,
    preParsed: PreParsedKey | undefined
  ): PreParsedKey {
    return preParsed !== undefined && preParsed.generation === this.keyExecutor.currentGeneration()
      ? preParsed
      : this.parseKeyAtRun(key, whenEvaluator);
  }

  private parseKeyAtRun(key: string, whenEvaluator: WhenEvaluator, allowRemap = true): PreParsedKey {
    const previousWhenEvaluator = this.dispatchWhenEvaluator;
    this.dispatchWhenEvaluator = whenEvaluator;
    try {
      return this.keyExecutor.parse(key, allowRemap);
    } finally {
      this.dispatchWhenEvaluator = previousWhenEvaluator;
    }
  }

  private registerReadFromParsed(parsed: PreParsedKey | undefined): { registerName: RegisterName | undefined } | undefined {
    return parsed?.claimed === true
      && parsed.result.type === "run"
      && parsed.result.action.type === "effect"
      ? parsed.result.action.registerToRead
      : undefined;
  }

  private compositeUndoTransaction(
    parsed: PreParsedKey | undefined
  ): ReturnType<VimEditorCapabilities["beginUndoTransaction"]> | undefined {
    if (this.keyExecutor.pendingConflict() !== undefined) {
      return this.editor.beginUndoTransaction(this.editor.getSelections());
    }
    if (
      parsed?.claimed !== true
      || parsed.result.type !== "run"
      || parsed.result.action.type === "effect"
    ) {
      return undefined;
    }
    return this.editor.beginUndoTransaction(this.editor.getSelections());
  }

  // How Vim relates to [key], given the grammar's verdict from [parse]:
  // - "owned": Vim handles it; the host must not (the controller prevents
  //   default).
  // - "passthrough": the host applies the edit natively and Vim only records it
  //   (an insert/replace whitelist character).
  // - null: fully native; Vim is not involved.
  private keyOwnership(key: string, parsed: PreParsedKey, whenEvaluator: WhenEvaluator): "owned" | "passthrough" | null {
    if (parsed.claimed) {
      const action = parsed.result.type === "run" && parsed.result.action.type === "effect"
        ? parsed.result.action
        : undefined;
      if (action?.insertTyped === true) return "passthrough";
      // A pending easyMotion overlay / remap chord owns every key it claims,
      // regardless of the ctrl gating below.
      if (this.easyMotion.isPending() || this.remapIsPending()) return "owned";
      // `vim.useCtrlKeys` gates Vim's built-in normal/visual ctrl commands even
      // when the grammar knows them; insert/replace ctrl commands (`ctrl-w`,
      // `ctrl-k`, …) are unaffected, as before.
      if (
        (this.modeState === "normal" || this.isVisualMode()) &&
        isCtrlKey(key) &&
        !hasRemapStartingWith(this.remaps, this.currentRemapMode(), key, whenEvaluator) &&
        !(this.configuration.useCtrlKeys && isBuiltInCtrlKey(key))
      ) {
        return null;
      }
      return "owned";
    }
    // Unclaimed keys follow the terminal-fallback policy (see [dispatchKey]).
    // Escape is the one cross-mode command still dispatched owner-side.
    if (isEscapeKey(key)) return this.shouldHandleEscapeKey() ? "owned" : null;
    if (this.modeState === "normal" || this.isVisualMode()) {
      // An unbound key rings the bell: Vim owns it so the host does not act on
      // it. Unbound ctrl chords stay native unless they are gated-in builtins.
      if (isCtrlKey(key)) {
        return this.configuration.useCtrlKeys && isBuiltInCtrlKey(key) ? "owned" : null;
      }
      return "owned";
    }
    // Insert/replace keys outside the passthrough whitelist, and prompt-mode
    // keys the search/command grammars decline, stay native.
    return null;
  }

  executeExternalRemap(
    mapping: { after?: readonly string[]; commands?: readonly VimCommandMapping[] },
    clipboard?: VimSystemClipboard
  ): QueuedRunResult<void> {
    if (clipboard === undefined) {
      for (const key of mapping.after ?? []) {
        this.routeKeyThroughExecutor(normalizeKey(key, this.configuration.leader), {
          allowRemap: true,
          whenEvaluator: alwaysActiveWhenEvaluator,
        });
      }
      for (const command of mapping.commands ?? []) this.executeMappedCommand(command);
      this.ensureNormalModeForReadonlyDocument();
      return;
    }
    return this.executeExternalRemapWithClipboard(mapping, clipboard);
  }

  private async executeExternalRemapWithClipboard(
    mapping: { after?: readonly string[]; commands?: readonly VimCommandMapping[] },
    clipboard: VimSystemClipboard
  ): Promise<void> {
    const context: VimExecutionContext = {
      clipboard,
      whenEvaluator: alwaysActiveWhenEvaluator,
    };
    const undoTransaction = this.editor.beginUndoTransaction(this.editor.getSelections());
    try {
      await this.registers.withSystemClipboard(clipboard, async () => {
        const previousContext = this.activeExecutionContext;
        this.activeExecutionContext = context;
        try {
          for (const key of mapping.after ?? []) {
            const plan = this.handleKey(normalizeKey(key, this.configuration.leader));
            if (plan !== null) await plan.run({ executionContext: context, replay: true });
          }
          for (const command of mapping.commands ?? []) await this.executeMappedCommand(command);
          await this.keyExecutor.whenIdle();
          await this.drainPendingReplays(context);
          this.ensureNormalModeForReadonlyDocument();
        } finally {
          this.activeExecutionContext = previousContext;
        }
      });
    } catch (error) {
      this.keyExecutor.reset(this.modeState);
      throw error;
    } finally {
      if (this.modeState === "insert" || this.modeState === "replace") {
        this.pendingCompositeUndoTransaction?.finish(this.editor.getSelections());
        this.pendingCompositeUndoTransaction = undoTransaction;
      } else {
        undoTransaction.finish(this.editor.getSelections());
      }
    }
  }

  hasActiveRemapStartingWithOrPending(key: string, whenEvaluator: WhenEvaluator = alwaysActiveWhenEvaluator): boolean {
    return this.remapIsPending()
      || hasRemapStartingWith(this.remaps, this.currentRemapMode(), key, whenEvaluator);
  }




  private shouldHandleEscapeKey(): boolean {
    return this.modeState !== "normal"
      || this.hasMultipleCursorsOrSelection()
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
        // Use [setMode] (not a direct [modeState] write) so the executor is
        // synced to visual; otherwise the typed framework keeps its stale mode
        // and declines every visual key, forcing them onto the legacy dispatcher.
        this.setMode("visual");
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

  // Test-harness invariant check, run by [runKeys], the Neovim fixture runner,
  // and the controller-simulation helper after every key. The mode FSM
  // ([modeState]) and the per-mode session state are owned separately: mode
  // *entry* paths deliberately adopt pre-built session state (`gv`/`gn` hand a
  // prepared selection to visual mode), so a command that leaves a mode without
  // tearing its session down does not fail immediately — it plants a ghost that
  // resurfaces on the next entry (the `Vgq` → stale-visual regression). This
  // assertion makes that contract violation fail at the key that broke it.
  assertModeStateInvariants(context: string): void {
    const failures: string[] = [];
    const visualSession = this.visualMode.currentMode();
    if (isVisualModeKind(this.modeState) && visualSession === undefined) {
      failures.push(`mode is ${this.modeState} but VisualMode has no session`);
    }
    // A visual session may outlive the visual mode only where a flow keeps the
    // selection on purpose: a `/`?` prompt opened from visual mode (the search
    // extends the selection), and an insert-mode excursion that returns to a
    // visual-derived state (`I`/`A` multiline insert).
    const visualSessionAllowed =
      isVisualModeKind(this.modeState)
      || this.modeState === "search"
      || (this.modeState === "insert" && this.insertOrigin !== undefined && isVisualModeKind(this.insertOrigin));
    if (visualSession !== undefined && !visualSessionAllowed) {
      failures.push(
        `mode is ${this.modeState} but VisualMode still has a ${visualSession} session — a command that left visual mode did not tear its session down`
      );
    }
    // The prompt-session invariants ("in `search` mode iff a PendingSearch
    // exists", same for `command`) are structural now: the prompts are
    // payloads of the [ModeSession] union, so the inconsistent combinations do
    // not typecheck and need no runtime check. The visual-session invariant
    // above stays runtime-checked: [VisualMode] owns its state as mutable data
    // (and legitimately spans the search mode), which the type system cannot
    // relate to the mode FSM.
    if (failures.length > 0) {
      throw new Error(`mode/session-state invariant violated ${context}:\n- ${failures.join("\n- ")}`);
    }
  }

  private clearPendingForModelSwitch(): void {
    this.clearPendingGrammar({ closeSearchHighlights: false });
  }

  private clearPendingForExternalModeChange(): void {
    this.clearPendingGrammar({ closeSearchHighlights: true });
  }

  private clearPendingGrammar({ closeSearchHighlights }: { closeSearchHighlights: boolean }): void {
    this.easyMotion.clear(this.editor);
    this.clearPendingRemaps();
    this.dismissPromptSession({ closeSearchHighlights });
    this.handlerState.register = undefined;
    this.handlerState.countText = "";
    this.normalMode.clearPending();
  }

  // Abort an in-flight `/`?` or `:` prompt: record the aborted input in the
  // history (Vim `:h cmdline-history`), tear down the search preview, and
  // transition to the prompt's base mode. Under [ModeSession] the payload
  // cannot be dropped without choosing a successor, so the abort decision is
  // explicit here: a search opened from visual mode returns to that visual
  // kind (the selection is still alive — Neovim keeps it), everything else
  // returns to normal. No-op outside the prompt modes.
  private dismissPromptSession({ closeSearchHighlights }: { closeSearchHighlights: boolean }): void {
    const session = this.session;
    switch (session.mode) {
      case "search": {
        this.setPendingSearchStatus(undefined);
        this.globalState.search.recordHistory(session.search);
        this.globalState.search.clearPending(this.editor, session.search, { restoreViewport: closeSearchHighlights });
        if (closeSearchHighlights) this.editor.clearSearchHighlights();
        if (isVisualModeKind(session.origin) && this.visualMode.currentMode() !== undefined) {
          this.setMode(session.origin);
        } else {
          this.setMode("normal");
        }
        return;
      }
      case "command": {
        this.globalState.commandHistory.add(session.command.value());
        this.editor.clearSubstitutePreview();
        this.setMode("normal");
        return;
      }
      default:
        return;
    }
  }

  // Live `:s` preview (Neovim 'inccommand'): while the `:` line holds a
  // substitute command, the host highlights its matches and shows the resolved
  // replacements inline. Recomputed after every command-line key; cleared when
  // the line stops being a substitute or the prompt closes.
  private syncSubstitutePreview(): void {
    const command = this.activeCommand;
    const previews = command === undefined
      ? undefined
      : substitutePreviews(this.editor, command.value(), this.commandOptions());
    if (previews === undefined) this.editor.clearSubstitutePreview();
    else this.editor.updateSubstitutePreview(previews);
  }

  private isPending(): boolean {
    return this.activeSearch !== undefined || this.activeCommand !== undefined || this.handlerState.register !== undefined || this.handlerState.countText.length > 0 || this.easyMotion.isPending() || this.keyExecutor.isPending() || (this.modeState === "normal" && this.normalMode.isPending());
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
    return (this.handlerState.register !== undefined ? 1 : 0)
      + (this.handlerState.countText.length > 0 ? 1 : 0)
      + (this.easyMotion.isPending() ? 1 : 0)
      + executorDepth;
  }

  private pendingChord(): string {
    // Prompt-like pending states render their editable input line (queries
    // support cursor movement and backspace, which a key log cannot show).
    // Everything else renders the showcmd buffer: the literal keys typed for
    // the command in flight.
    if (this.activeSearch !== undefined) return this.globalState.search.pendingChord(this.activeSearch);
    if (this.activeCommand !== undefined) {
      const value = this.activeCommand.value();
      const cursor = this.activeCommand.cursorPosition();
      return `:${value.slice(0, cursor)}|${value.slice(cursor)}`;
    }
    if (this.easyMotion.isPending()) return this.easyMotion.pendingChord();
    return this.isPending() ? this.showcmdKeys.join("") : "";
  }

  // Zed: key dispatch normally arrives through GPUI actions registered by
  // `vim::Vim::action` and key contexts from `vim::Vim::extend_key_context`.
  // The VSCode patch calls this direct key entry point instead.
  onKey(key: string): KeyDispatchResult {
    return this.dispatchTypedKey(key, { allowRemap: true, whenEvaluator: alwaysActiveWhenEvaluator });
  }

  private dispatchTypedKey(key: string, { allowRemap, whenEvaluator, passthrough = false, preParsed }: { allowRemap: boolean; whenEvaluator: WhenEvaluator; passthrough?: boolean; preParsed?: PreParsedKey }): KeyDispatchResult {
    // Remap expansions re-enter through [dispatchKey] and bypass this append,
    // so the showcmd buffer shows remapped sequences as physically typed
    // (`x`, not its expansion). This intentionally differs from Vim's
    // showcmd, which displays the expanded typeahead. Macro and `.` replays
    // re-enter through [onKey] and do append: if a replay ends with a command
    // still pending, the chord shows the replayed keys that formed it.
    if (key === RemapTimeoutKey) return this.handleRemapTimeout(whenEvaluator);
    if (!this.isPending()) this.showcmdKeys.length = 0;
    this.showcmdKeys.push(key);
    const result = this.routeKeyThroughExecutor(key, { allowRemap, whenEvaluator, passthrough, preParsed });
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
    // Per-mode root handlers. `search` is the first non-normal mode the executor
    // owns; it has no remap layer (a `/`?` query is literal input). Modes the
    // framework does not own yet (insert/replace/visual) fall through the normal
    // handlers, which decline outside normal context.
    if (state.mode === "search" && this.activeSearch !== undefined) {
      return [{ handler: this.searchRootHandler(), state }];
    }
    if (state.mode === "command" && this.activeCommand !== undefined) {
      return [{ handler: this.commandRootHandler(), state }];
    }
    if (isVisualModeKind(state.mode)) {
      return [
        { handler: this.remapRootHandler(), state },
        { handler: this.easyMotionRootHandler(), state },
        { handler: this.visualRootHandler(), state },
      ];
    }
    return [
      { handler: this.remapRootHandler(), state },
      { handler: this.easyMotionRootHandler(), state },
      { handler: this.insertRootHandler(), state },
      { handler: this.replaceRootHandler(), state },
      { handler: this.normalRootHandler(), state },
    ];
  }

  // The migrated visual-mode grammar ([visualModeHandler]); pure, with the live
  // editor/registers and the [VisualMode] selection state injected by
  // [visualRootHandler].
  private readonly visualGrammar: Handler<void> = visualModeHandler();

  // Root of the visual-mode grammar. It only claims from a clean visual context
  // (no legacy visual subsystem mid-chord; see [isExecutorVisualContext]); other
  // keys fall through to the legacy dispatcher during the migration.
  private visualRootHandler(): Handler<void> {
    return (key, state) => {
      if (!this.isExecutorVisualContext()) return unhandled();
      if (this.startsEasyMotion(key)) return unhandled();
      const liveState: HandlerState = {
        ...state,
        mode: this.modeState,
        editor: this.editor,
        registers: this.registers,
        configuration: this.configuration,
        visual: this.visualMode,
        repeatState: this.globalState.repeat,
        // [search] is injected so visual-mode `gn`/`gN`/`n`/`N` can extend the
        // selection to a search match; [find] so visual-mode `f`/`t`/`F`/`T` and
        // `;`/`,` can extend it to a find target (and record the find);
        // [changeList] for the `g;`/`g,` editor `g`-chords shared with normal mode.
        search: this.globalState.search,
        find: this.globalState.find,
        changeList: this.modelState.changeList,
        reportSearchStatus: status => this.reportSearchStatus(status),
      };
      return this.visualGrammar(key, liveState);
    };
  }

  // Whether the executor may handle a visual-mode key: a visual mode with no
  // Mirrors [isExecutorNormalContext]: with the legacy subsystems gone, the
  // visual grammar owns every visual-mode key (a pending framework chord routes
  // to its continuation before this root is consulted).
  private isExecutorVisualContext(): boolean {
    return this.isVisualMode();
  }

  // Root of the `search` mode grammar ([searchModeHandler]). The live editor and
  // the in-flight query travel in the handler state, like [normalRootHandler].
  // [searchOrigin] and [visual] are injected so a `/`?` started from visual mode
  // extends the selection and returns to that visual kind on completion.
  private searchRootHandler(): Handler<void> {
    return (key, state) => {
      const liveState: HandlerState = {
        ...state,
        mode: "search",
        editor: this.editor,
        registers: this.registers,
        search: this.globalState.search,
        activeSearch: this.activeSearch,
        searchOrigin: this.searchOriginMode,
        visual: this.visualMode,
        reportSwallowedPromptKey: swallowedKey => this.reportSwallowedPromptKey(swallowedKey),
        reportSearchStatus: status => this.reportSearchStatus(status),
        setPendingSearchStatus: status => this.setPendingSearchStatus(status),
      };
      return searchModeHandler(key, liveState);
    };
  }

  // Root of the `command` mode grammar ([commandModeHandler]). The live editable
  // command line travels in the handler state, like [activeSearch]. Execution is
  // owner-side (see [enterModeFromExecutor]), so the handler only needs to
  // accumulate input.
  private commandRootHandler(): Handler<void> {
    return (key, state) => {
      const liveState: HandlerState = {
        ...state,
        mode: "command",
        editor: this.editor,
        activeCommand: this.activeCommand,
        reportSwallowedPromptKey: swallowedKey => this.reportSwallowedPromptKey(swallowedKey),
      };
      return commandModeHandler(key, liveState);
    };
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
    opts?: { enterInsert?: { count: number; separator: string }; search?: { backwards: boolean } }
  ): void {
    if (mode === "insert" && this.modeState !== "insert") {
      // The origin is the mode the insert session began from: "normal" for
      // normal-mode change/insert-entry, the visual kind for a visual change
      // (`v…c`). The visual origin matters on escape — a `visualBlock` change
      // collapses cursors and replicates the typed text over the block.
      this.enterInsertMode({
        origin: isVisualModeKind(this.modeState) ? this.modeState : "normal",
        count: opts?.enterInsert?.count ?? 1,
        separator: opts?.enterInsert?.separator ?? "",
      });
    }
    if (mode === "replace" && this.modeState !== "replace") {
      // `R`: start the replace session (shared with insert: count-repeat text,
      // finish on escape) and switch modes.
      this.enterReplaceMode({
        count: opts?.enterInsert?.count ?? 1,
        separator: opts?.enterInsert?.separator ?? "",
      });
    }
    if (mode === "search" && this.modeState !== "search") {
      // Start the incremental prompt; the search-mode grammar drives it from
      // here. The prompt and its origin ride in the session payload.
      this.setSession({
        mode: "search",
        search: this.globalState.search.start(opts?.search?.backwards ?? false, this.editor),
        origin: this.modeState,
      });
      // Rebuild the executor handlers now that the prompt exists so the next
      // key routes to [searchRootHandler] (which [executorHandlers] gates on it).
      this.keyExecutor.reset("search");
    }
    if (mode === "command" && this.modeState !== "command") {
      // Enter the `:` command line. From a visual mode, set the `'<`/`'>` marks
      // and prefill the `'<,'>` range, then leave visual (mirrors the legacy
      // `startCommand`).
      let input = "";
      if (isVisualModeKind(this.modeState)) {
        const selection = this.editor.getSelections()[0];
        if (selection !== undefined) this.modelState.marks.setVisualSelectionMarks(this.editor, selection);
        this.visualMode.exit();
        input = "'<,'>";
      }
      this.setSession({ mode: "command", command: new CommandLine(input, this.globalState.commandHistory) });
      // Rebuild the executor handlers now that the command line exists so the
      // next key routes to [commandRootHandler].
      this.keyExecutor.reset("command");
    }
    // Leaving `search` for another mode (the `enter` completion; the effect
    // already applied the motion — a cursor move for a normal-origin search, a
    // selection extension for a visual-origin one): the transition below
    // replaces the session, which necessarily drops the prompt payload.
    if (mode === "normal" && this.modeState === "search") {
      this.setMode("normal");
    }
    // Submitting the `:` command line (`enter`): run the accumulated command and
    // return to normal. Execution happens here — on the command -> normal
    // transition, after the executor's effect queue has drained — so a
    // `:normal`/`:g` command that re-enters [onKey] runs its keys synchronously
    // rather than queuing them behind the in-flight effect. Escape cancels via
    // the central escape handling instead, which never reaches this path.
    const sessionBeforeTransition = this.session;
    if (mode === "normal" && sessionBeforeTransition.mode === "command") {
      const command = sessionBeforeTransition.command.value();
      this.globalState.commandHistory.add(command);
      // The preview decorations must not survive into (or interleave with) the
      // command's own edits.
      this.editor.clearSubstitutePreview();
      this.setMode("normal");
      executeCommand(this.editor, command, this.commandOptions());
    }
    // Visual mode transitions (the framework targets only these three kinds):
    if (mode === "visual" || mode === "visualLine" || mode === "visualBlock") {
      if (!isVisualModeKind(this.modeState)) {
        // Entering visual from normal (`v`/`V`/`ctrl-v`, `gv`/`gn`), or returning
        // to the visual origin after completing a `/`?` search: [enterVisualMode]
        // keeps a pre-built / preserved selection rather than resetting it.
        this.enterVisualMode(mode);
      } else {
        // Already visual: a motion (same kind) or a toggle to another kind. The
        // effect already changed the [VisualMode] selection state; just record
        // the (possibly unchanged) mode.
        this.setMode(mode);
      }
    } else if (mode === "normal" && isVisualModeKind(this.modeState)) {
      // Leaving visual for normal (toggle-exit / operator). The effect already
      // did the visual state cleanup (toggleMode/handleCommand/exit).
      this.setMode("normal");
    }
  }

  // Root of the easyMotion overlay ([easyMotionHandler]), shared by the normal
  // and visual grammars. Runs after the remap layer (a remap starting with the
  // leader wins) but before the normal/visual grammar (which decline the leader
  // when [startsEasyMotion] is true, so easyMotion strictly wins even when the
  // leader is an otherwise-bound key like `<space>`). The overlay state, config,
  // and jump applier travel in the handler state so the handler stays pure. Once
  // the leader starts the overlay the executor is pending on [easyMotionHandler]'s
  // continuation, so subsequent keys bypass this root entirely.
  private easyMotionRootHandler(): Handler<void> {
    return (key, state) => {
      // EasyMotion is off by default; skip the per-key live-state construction
      // for the common disabled case (a pending overlay never reaches this root —
      // it drives its own continuation).
      if (!this.configuration.easymotion) return unhandled();
      // EasyMotion only starts from a motion mode (normal/visual), like the
      // legacy `shouldStartEasyMotion`. The executor consults the normal-mode
      // handler set in insert/replace too (those modes have no dedicated set), so
      // decline there — otherwise typing the leader in insert mode would start
      // the overlay instead of inserting it.
      if (this.modeState !== "normal" && !this.isVisualMode()) return unhandled();
      if (state.allowRemap && hasRemapStartingWith(this.remaps, this.currentRemapMode(), key, this.dispatchWhenEvaluator)) {
        return unhandled();
      }
      const liveState: HandlerState = {
        ...state,
        mode: this.modeState,
        editor: this.editor,
        easyMotion: this.easyMotion,
        configuration: this.configuration,
        applyEasyMotionJump: position =>
          this.applyMotion({ type: "jump", position, line: false }, 1),
      };
      return easyMotionHandler(key, liveState);
    };
  }

  // Whether [key] would start the easyMotion overlay from a clean context: the
  // feature is on and [key] is the leader. The normal/visual root handlers use
  // this to decline the leader so easyMotion (a higher-priority root handler)
  // claims it cleanly instead of racing the grammar (e.g. `<space>` as both the
  // leader and the wrapping-right motion).
  private startsEasyMotion(key: string): boolean {
    return this.configuration.easymotion && key === this.configuration.leader;
  }

  // Root of the insert-mode passthrough handler ([insertModeHandler]). Lives in
  // the default (normal) handler set, which the executor consults in insert mode
  // too (insert is not an executor-synced mode; see [isExecutorOwnedNonNormalMode]),
  // gated on the live mode. It claims plain typed input + backspace so the owner
  // records them and reproduces the edit through the host; special ctrl keys and
  // the char-input waiters fall through to the legacy insert dispatcher. Replace
  // mode stays on the legacy dispatcher for now.
  private insertRootHandler(): Handler<void> {
    return (key, state) => {
      if (this.modeState !== "insert") return unhandled();
      // Yield to a higher-priority insert-mode remap — but only for a remappable
      // key. A key a remap expansion emitted with noremap (e.g. the literal `j`
      // of a broken `jk` chord) must be handled as plain input here, not
      // re-declined into a remap that cannot fire.
      if (state.allowRemap && hasRemapStartingWith(this.remaps, this.currentRemapMode(), key, this.dispatchWhenEvaluator)) {
        return unhandled();
      }
      return insertModeHandler(key, {
        ...state,
        mode: this.modeState,
        editor: this.editor,
        registers: this.registers,
        configuration: this.configuration,
        enterTemporaryNormal: () => {
          this.enterTemporaryNormalMode();
        },
        appendInsertSessionText: text => {
          this.insertRepeatText += text;
        },
      });
    };
  }

  // Root of the replace-mode grammar ([replaceModeHandler]), gated on the live
  // mode like [insertRootHandler]. Typing/backspace are Vim-owned (overwrite +
  // restore, driven through the injected replace machinery); only navigation
  // keys pass through.
  private replaceRootHandler(): Handler<void> {
    return (key, state) => {
      if (this.modeState !== "replace") return unhandled();
      if (state.allowRemap && hasRemapStartingWith(this.remaps, this.currentRemapMode(), key, this.dispatchWhenEvaluator)) {
        return unhandled();
      }
      return replaceModeHandler(key, {
        ...state,
        mode: this.modeState,
        editor: this.editor,
        applyReplaceText: text => {
          this.replaceModeReplacements.push(...replaceModeText(this.editor, text, 1, this.insertEditOptions()));
          this.insertRepeatText += text;
        },
        undoReplace: () => {
          this.undoReplace();
        },
      });
    };
  }

  // Root of the migrated normal-mode grammar. It only begins a chord from a
  // clean state (no legacy subsystem pending; see [isExecutorNormalContext]) and
  // yields to a higher-priority remap. The live editor/registers travel in the
  // handler state so the grammar stays pure; count and register are owned by the
  // grammar's prefix handler (in the executor's env state).
  private normalRootHandler(): Handler<void> {
    return (key, state) => {
      if (!this.isExecutorNormalContext()) return unhandled();
      if (this.startsEasyMotion(key)) return unhandled();
      // Yield to a higher-priority remap — but only for a remappable key. A key
      // a remap expansion emitted with noremap (e.g. the `h` of `h -> hl`) must
      // be handled as the plain command here, not re-declined into a remap that
      // cannot fire.
      if (state.allowRemap && hasRemapStartingWith(this.remaps, this.currentRemapMode(), key, this.dispatchWhenEvaluator)) {
        return unhandled();
      }
      const liveState: HandlerState = {
        ...state,
        mode: "normal",
        editor: this.editor,
        registers: this.registers,
        configuration: this.configuration,
        marks: this.modelState.marks,
        find: this.globalState.find,
        changeList: this.modelState.changeList,
        lastInsertPosition: this.modelState.lastInsertPosition,
        search: this.globalState.search,
        repeatState: this.globalState.repeat,
        // [visual] is injected so the normal-mode `gn`/`gN` (and later `gv`)
        // can build a visual selection from a search match.
        visual: this.visualMode,
        // [macro] drives `q` record/stop + register recording; `@`/`Q` request a
        // replay via [requestMacroReplay], which [runPendingMacroReplay] runs
        // after the executor drain (outside it).
        macro: this.globalState.macro,
        requestMacroReplay: (register, count) => {
          this.pendingMacroReplay = { register, count };
        },
        // `.` requests a dot replay the same way (run after the drain; see
        // [runPendingDotReplay]).
        requestDotReplay: (count, register) => {
          this.pendingDotReplay = { count, register };
        },
        // The `d/`/`c/`/`y/` search-operand waiter clones this state and
        // reports its swallowed keys through it.
        reportSwallowedPromptKey: swallowedKey => this.reportSwallowedPromptKey(swallowedKey),
        reportSearchStatus: status => this.reportSearchStatus(status),
        setPendingSearchStatus: status => this.setPendingSearchStatus(status),
      };
      return this.normalGrammar(key, liveState);
    };
  }

  // Whether the executor may begin a normal-mode chord: normal mode, not a
  // CTRL-O excursion, and no legacy subsystem mid-chord. Count/register are
  // intentionally not checked here (the framework owns them), so a buffered
  // count does not block the next key.
  private isExecutorNormalContext(): boolean {
    // Count/register are intentionally not checked (the framework owns them in
    // the executor's pending state), and with the legacy subsystems gone there
    // is nothing else that could be mid-chord outside the executor.
    return this.modeState === "normal";
  }

  // Root remap handler for the start of a fresh chord. It reads the live Vim
  // mode and when-evaluator on each key (continuations, once started, keep the
  // mode/evaluator captured when the chord began, matching the legacy path).
  private remapRootHandler(): Handler<void> {
    return (key, state) => {
      // The [allowRemap] flag is honored inside [remapHandler] itself.
      const liveState: HandlerState = {
        ...state,
        mode: this.modeState,
        whenEvaluator: this.dispatchWhenEvaluator,
      };
      return remapHandler(this.remaps, this.currentRemapMode())(key, liveState);
    };
  }

  // Run one top-level key through the typed executor; if no handler claims it,
  // fall back to the legacy dispatcher and use its native/handled result. A key
  // the executor claims is always [handled].
  private routeKeyThroughExecutor(
    key: string,
    { allowRemap, whenEvaluator, passthrough = false, preParsed }: { allowRemap: boolean; whenEvaluator: WhenEvaluator; passthrough?: boolean; preParsed?: PreParsedKey }
  ): KeyDispatchResult {
    const previousWhenEvaluator = this.dispatchWhenEvaluator;
    this.dispatchWhenEvaluator = whenEvaluator;
    const versionBefore = this.editor.documentVersion();
    this.lastEffectRecordedChangeVersion = undefined;
    const modeBefore = this.modeState;
    const temporaryNormalBefore = this.temporaryNormal;
    try {
      if (this.handleThroughExecutor(key, allowRemap, passthrough, preParsed)) {
        // A framework command that edited the buffer must update the change list
        // (`g;`/`g,`), mirroring the legacy [dispatchKey] bookkeeping — framework
        // commands never reach [dispatchKey].
        if (
          this.editor.documentVersion() !== versionBefore
          && this.lastEffectRecordedChangeVersion !== this.editor.documentVersion()
        ) {
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
        // Live `:s` preview: refresh after every command-line key, and tear it
        // down on the key that leaves command mode (escape tears down through
        // [dismissPromptSession] instead — it never reaches this branch).
        if (this.modeState === "command" || modeBefore === "command") this.syncSubstitutePreview();
        this.runPendingReplaysWhenReady();
        // Vim `i_CTRL-O`: once the one normal-mode command completes, return to
        // insert (mirrors the legacy [dispatchKey] finally for framework-handled
        // keys). Visual mode extends the excursion; entering another mode
        // (`ctrl-o cw`) ends it.
        if (temporaryNormalBefore && !this.keyExecutor.hasQueuedWork()) {
          if (this.keyExecutor.lastEffectTemporaryInsertAfter()) this.prepareTemporaryInsertAfter();
          this.finishTemporaryNormalCommand();
        }
        return "handled";
      }
      // Framework `/`?` prompt: a key the search grammar declined that is not
      // escape (e.g. `ctrl-a`, function keys) is not ours — let the host handle
      // it without disturbing the prompt or recording it. Escape falls through to
      // the legacy escape handling below, which cancels the prompt.
      if (this.activeSearch !== undefined && !isEscapeKey(key)) return "native";
      // Clear the executor's now-stale continuation *before* running the
      // terminal fallback: escape handling can re-enter the executor, which
      // would otherwise be misrouted into the leftover continuation.
      this.keyExecutor.reset(this.modeState);
      return this.dispatchKey(key);
    } finally {
      this.dispatchWhenEvaluator = previousWhenEvaluator;
    }
  }

  private redispatchThroughExecutionContext(key: string, allowRemap: boolean): QueuedRunResult<void> {
    const context = this.activeExecutionContext;
    const clipboard = context?.clipboard;
    if (context === undefined || clipboard === undefined) {
      this.dispatchThroughPipeline(key, allowRemap);
      return;
    }

    const whenEvaluator = context.whenEvaluator;
    let parsed = this.parseKeyAtRun(key, whenEvaluator, allowRemap);
    const registerToRead = this.registerReadFromParsed(parsed);
    if (registerToRead === undefined) {
      this.dispatchTypedKey(key, { allowRemap, whenEvaluator, preParsed: parsed });
      return;
    }
    const refresh = this.registers.refreshSystemClipboardRegister(registerToRead.registerName);
    if (refresh === undefined) {
      this.dispatchTypedKey(key, { allowRemap, whenEvaluator, preParsed: parsed });
      return;
    }
    return refresh.then(() => {
      parsed = this.parseKeyAtRun(key, whenEvaluator, allowRemap);
      this.dispatchTypedKey(key, { allowRemap, whenEvaluator, preParsed: parsed });
    });
  }

  // Re-dispatch keys the executor emits (remap expansions) or replays
  // (ambiguous-conflict suffixes): try the executor first, then the terminal
  // fallback. The when-evaluator is already established by the enclosing
  // top-level dispatch.
  private dispatchThroughPipeline(key: string, allowRemap: boolean): void {
    if (this.handleThroughExecutor(key, allowRemap)) return;
    this.dispatchKey(key);
  }

  // Run a key through the executor and, when a migrated leaf handler claims it,
  // record it for macros/dot-repeat. The legacy dispatcher does this recording
  // for the keys it handles; a key the executor claims never reaches it, so the
  // recording is mirrored here. Remap keys are excluded: their expansion is
  // re-dispatched and recorded as it flows through this same path.
  private handleThroughExecutor(key: string, allowRemap: boolean, passthrough = false, preParsed?: PreParsedKey): boolean {
    // A key the framework claims in normal context never reaches [dispatchKey],
    // so the per-key recording the legacy dispatcher does (macro + dot-repeat)
    // is mirrored here. Both dot-repeat and macros are keystroke-based: the
    // recorded keys are replayed through the same key pipeline. Remapped keys are
    // excluded — the remap handler claims them and the expansion is recorded as
    // it flows through this path.
    // Whether the remap machinery may claim this key, so recording it here
    // would double-record with the expansion's own re-dispatch. At a fresh
    // chord root the remap root handler is live, so any key that starts a
    // mapping is excluded. Mid-chord it only applies while a remap chord is
    // buffering keys ([remapIsPending]): a pending waiter (the char of
    // `df<space>`) consumes its key raw — a `<space>` mapping cannot claim it
    // there, and skipping the recording would drop the char from dot-repeat
    // and macros.
    const remapMayClaimKey =
      allowRemap
      && (this.keyExecutor.isPending()
        ? this.remapIsPending()
        : hasRemapStartingWith(this.remaps, this.currentRemapMode(), key, this.dispatchWhenEvaluator));
    const normalContext = this.isExecutorNormalContext() && !remapMayClaimKey;
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
    const wasRecording = this.globalState.macro.isRecording();
    // Parse before commit so we can inspect *this* key's own action. [commit] can
    // synchronously redispatch emitted keys (a remap expansion), which would
    // clobber the executor's [lastEffect*] flags — so the "is this a passthrough
    // insert char" decision must read the parsed result, not a post-commit flag
    // (otherwise `jo` breaking a `jk` remap would re-apply the emitted `o`).
    const remapConflictBefore = this.keyExecutor.pendingConflict() !== undefined;
    // Commit the plan's own evaluation when it is still fresh; re-parse when
    // the executor state moved since (an earlier key's commit was still queued
    // when this key was parsed for ownership).
    const parsed =
      preParsed !== undefined && preParsed.generation === this.keyExecutor.currentGeneration()
        ? preParsed
        : this.keyExecutor.parse(key, allowRemap);
    const directEffectAction =
      parsed.claimed && parsed.result.type === "run" && parsed.result.action.type === "effect"
        ? parsed.result.action
        : undefined;
    const directlyInsertTyped = directEffectAction?.insertTyped === true;
    const claimed = this.keyExecutor.commit(key, parsed.result);
    // A passthrough insert character ([insertModeHandler]): record it as a
    // `typed` key, accumulate the session text, and reproduce the edit through
    // the host. This is its own recording path (typed, not shortcut), so it
    // short-circuits the shortcut record/dot-repeat branches below. Emitted keys
    // from a remap expansion are handled by their own re-entrant dispatch, so
    // only a *directly* typed key runs this.
    if (directlyInsertTyped) {
      this.applyInsertTypedKey(key, passthrough);
      return claimed;
    }
    // A framework-claimed insert/replace-mode command (`ctrl-w`/`ctrl-u`/
    // `ctrl-y`/`ctrl-e`/`ctrl-o`, replace-mode typing/backspace, and the
    // `ctrl-k`/`ctrl-v`/`ctrl-r` waiter chords): record it as a shortcut for
    // macros + dot-repeat, mirroring the legacy dispatcher's recording. Direct
    // effects and plain waiter pendings qualify; remap chords are excluded like
    // everywhere else — a multi-key insert remap is a *conflict* (never a plain
    // "handler" result) and a single-key remap is a keys/commands action, and
    // their expansions record as they re-dispatch. Cancel keys (a waiter's
    // escape → "invalid") record nothing.
    if (claimed && (modeBefore === "insert" || modeBefore === "replace")) {
      const recordAsShortcut =
        !remapConflictBefore &&
        (directEffectAction !== undefined || parsed.result.type === "handler");
      if (recordAsShortcut) {
        this.recordMacroKey(key);
        this.recordRepeatKey(key);
      }
      return claimed;
    }
    // The key that started a macro recording (`q{reg}`'s register key) must not
    // become the first key of that recording: the effect just called
    // [startRecording], so a plain [recordMacroKey] below would capture it.
    const startedRecording = !wasRecording && this.globalState.macro.isRecording();
    // Keys the framework claims in a non-normal mode it owns (search-prompt
    // input, visual-mode keys) are macro-recorded too, like the legacy
    // waiting-input/visual paths, so a recorded `/foo<CR>` or `v3ls...` replays.
    // Dot-repeat recording (below) is normal-context only.
    if (claimed && isExecutorOwnedNonNormalMode(modeBefore) && !this.globalState.repeat.isReplaying()) {
      this.recordMacroKey(key);
    }
    if (claimed && recordable) {
      // Macros are a verbatim transcript: record every claimed key, including a
      // chord-cancelling key (`d` then `.`). The key that *started* a recording
      // (`q{reg}`'s register key) is excluded so it is not the macro's first key.
      if (!startedRecording) this.recordMacroKey(key);
      if (this.keyExecutor.lastEffectPreservesDotRepeat()) {
        // A dot-repeat-transparent key (`q`/`@`/`Q` + register): leave the
        // recording untouched. `@`/`Q` replay their keys through the normal path,
        // which sets the dot-repeat to the macro's last change; the macro-control
        // keys themselves must neither enter nor cancel it.
      } else if (this.keyExecutor.lastHandleWasCancel()) {
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

  private dispatchKey(key: string): KeyDispatchResult {
    // Cheap content stamp, not the document text: snapshotting/comparing the
    // whole document here made every keypress O(file size) on large files.
    const versionBefore = this.editor.documentVersion();
    const modeBefore = this.modeState;
    const temporaryNormalBefore = this.temporaryNormal;
    try {
      if (!this.globalState.repeat.isReplaying()) this.globalState.repeat.maybeFinish({ mode: this.modeState, isPending: this.isPending() });

      if (isEscapeKey(key)) {
        if (!this.shouldHandleEscapeKey()) return "native";
        this.recordEscapeKey();
        this.handleEscapeKey();
        return "handled";
      }

      // Insert/replace keys outside the passthrough whitelist and the framework
      // grammar (e.g. `tab`, function keys) stay native — and deliberately
      // unrecorded: command-like chords must never land in a macro.
      if (this.modeState === "insert" || this.modeState === "replace") return "native";

      // An unbound normal/visual key rings the bell: Vim owns it (the host does
      // not type it into the buffer) and nothing happens. It is still recorded,
      // like Vim, which records every key typed while recording a macro.
      this.recordMacroKey(key);
      this.recordRepeatKey(key);

      if (this.isVisualMode()) return "handled";
      if (this.modeState !== "normal") return "native";
      this.normalMode.clearPending();
      return "handled";
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


  // Macro control keys resolve after waiting input (so `f q`, `m q`, and
  // register/search input win while recording) but before macro key recording
  // (so the `q` that stops a recording is not recorded into it).

  private async drainPendingReplays(context: VimExecutionContext): Promise<void> {
    while (this.pendingMacroReplay !== undefined || this.pendingDotReplay !== undefined) {
      await this.runPendingMacroReplay(context);
      await this.runPendingDotReplay(context);
      await this.keyExecutor.whenIdle();
    }
  }

  private runPendingReplaysWhenReady(): void {
    const context = this.activeExecutionContext;
    if (context !== undefined && !this.registers.hasFreshActiveClipboard()) return;
    const macro = this.runPendingMacroReplay(context);
    const dot = this.runPendingDotReplay(context);
    if (
      (macro !== undefined && typeof (macro as Promise<void>).then === "function")
      || (dot !== undefined && typeof (dot as Promise<void>).then === "function")
    ) {
      throw new Error("unexpected async replay at a synchronous replay boundary");
    }
  }

  private replayMacro(run: () => QueuedRunResult<void>): QueuedRunResult<void> {
    const undoTransaction = this.editor.beginUndoTransaction(this.editor.getSelections());
    const finish = () => undoTransaction.finish(this.editor.getSelections());
    try {
      return finishQueued(run(), finish);
    } catch (error) {
      finish();
      throw error;
    }
  }

  // A macro replay requested by the framework `@`/`Q` handlers ([register]
  // undefined = `Q` replays the last recording). Run by [runPendingMacroReplay]
  // after the executor's effect drain, so each replayed key is fed back through
  // [onKey] and fully applies before the next — outside the drain, like a
  // physically typed key.
  private pendingMacroReplay: { register: string | undefined; count: number } | undefined;

  private runPendingMacroReplay(context: VimExecutionContext | undefined): QueuedRunResult<void> {
    const pending = this.pendingMacroReplay;
    if (pending === undefined) return;
    this.pendingMacroReplay = undefined;
    return this.replayMacro(() => {
      const runKey = (entry: RecordedKey) => this.replayRecordedKey(entry, context);
      return pending.register === undefined
        ? this.globalState.macro.replayLast(pending.count, runKey)
        : this.globalState.macro.replayRegisterKey(pending.register, pending.count, runKey);
    });
  }

  // A dot replay requested by the framework `.` handler, run after the executor's
  // effect drain like [runPendingMacroReplay] (each replayed key is fed back
  // through the dispatcher and must fully apply before the next). Unlike a macro
  // replay it is not wrapped in one undo transaction: the replayed change manages
  // its own undo unit, exactly as it did when first typed.
  private pendingDotReplay: { count: number | undefined; register: RegisterName | undefined } | undefined;

  private runPendingDotReplay(context: VimExecutionContext | undefined): QueuedRunResult<void> {
    const pending = this.pendingDotReplay;
    if (pending === undefined) return;
    this.pendingDotReplay = undefined;
    // Discard the recording opened for `.`'s own chord (the count/register
    // prefix of `3.` / `"a.`): `.` is transparent to dot-repeat and the replay
    // below manages the last change itself (count override, numbered-paste
    // advance). Without this, the dangling `[3]` would be committed as the
    // last change by the next key's [maybeFinish].
    this.globalState.repeat.cancelCurrent();
    return this.globalState.repeat.replay(pending.count, {
      registerName: pending.register,
      runKey: entry => this.replayRecordedKey(entry, context),
      runVisualAction: (selection, repeatAction) => this.replayVisualAction(selection, repeatAction),
    });
  }

  // Replay one recorded key from a dot-repeat / macro sequence. Hosted replay
  // uses an internal KeyPlan sharing the root clipboard transaction; direct
  // core use without a clipboard keeps the synchronous [onKey] path.
  private replayRecordedKey(
    entry: RecordedKey,
    context: VimExecutionContext | undefined
  ): QueuedRunResult<void> {
    // Replayed keys use ordinary plans, but with native passthrough suppressed:
    // the host did not physically type this key, so Vim reproduces typed edits.
    // Awaiting each plan keeps macro/dot order correct across async register reads.
    // Once the root transaction has a fresh snapshot, replay remains synchronous.
    if (context === undefined || context.clipboard === undefined || this.registers.hasFreshActiveClipboard()) {
      if (this.keyExecutor.hasQueuedWork()) {
        this.keyExecutor.runReentrant(() => this.onKey(entry.key));
      } else {
        this.onKey(entry.key);
      }
      return;
    }
    const plan = this.handleKey(entry.key);
    if (plan !== null) return plan.run({ executionContext: context, replay: true });
  }

  // Handle one passthrough insert character, both when freshly typed (via
  // [handleThroughExecutor]) and when replayed (dot-repeat / macro, via
  // [replayRecordedKey]). It (1) accumulates the insert-session text for
  // count-repeat (`3i…`), always — a replayed count insert re-inserts the extra
  // copies on Escape; (2) records the key for dot-repeat and macros, gated the
  // same way as [recordRepeatKey]/[recordMacroKey] (so a `.` while recording a
  // macro records `.`, not the expanded characters); and (3) reproduces the edit
  // through the host default handler — unless [passthrough], where the host
  // already handled the live keystroke natively (the controller did not
  // preventDefault), so Vim only records.
  private applyInsertTypedKey(key: string, passthrough: boolean): void {
    // The session text drives count-repeat (`3i…`). Backspace edits it in place;
    // any other non-text whitelist key (cursor movement, word delete) starts a
    // new chunk, like Vim, where moving in insert restarts the repeated text.
    const text = insertTextForKey(key);
    if (text !== undefined) {
      this.insertRepeatText += text;
    } else if (key === "backspace") {
      this.insertRepeatText = this.insertRepeatText.slice(0, -1);
    } else {
      this.insertRepeatText = "";
    }
    if (!this.globalState.repeat.isReplaying()) this.globalState.repeat.recordTyped(key);
    if (!this.globalState.repeat.isReplaying() && !this.globalState.macro.isReplaying()) {
      this.globalState.macro.recordTyped(key);
    }
    if (!passthrough) {
      this.editor.replayInsertKey(key);
    } else if (text !== undefined || key === "backspace" || key === "delete" || key === "ctrl-backspace" || key === "ctrl-delete") {
      // On the live path the host edited the buffer *before* this plan ran, so
      // the change-list bookkeeping in [routeKeyThroughExecutor] (which compares
      // against a version captured after the native edit) never fires; record
      // the insert position here for the keys that edit, mirroring the legacy
      // dispatcher's per-key change-list update. Pure navigation keys record
      // nothing.
      this.modelState.changeList.record(this.editor, { insertMode: true });
    }
  }

  private handleEscapeKey(): void {
    // Escaping a prompt: [dismissPromptSession] (via the clear below) chooses
    // the successor mode itself — a visual-origin search returns to the visual
    // kind with the selection intact, like Neovim. Stop there: falling through
    // would treat the restored visual mode as the thing being escaped.
    const wasPrompt = this.modeState === "search" || this.modeState === "command";
    this.clearPendingStateForEscape();
    if (wasPrompt) return;
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
        const composite = this.pendingCompositeUndoTransaction;
        this.pendingCompositeUndoTransaction = undefined;
        if (composite !== undefined) composite.finish(this.editor.getSelections());
        else this.editor.finishUndoTransaction(this.editor.getSelections());
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

  private enterVisualMode(mode: Extract<VisualResultMode, "visual" | "visualLine" | "visualBlock">): void {
    // Normally entering visual starts a fresh selection at the cursor. But some
    // entries pre-build the selection before this runs (e.g. `gn`/`gN` select a
    // search match via [VisualMode.adoptSelection]); in that case keep it rather
    // than resetting to a single-cell selection.
    if (this.visualMode.currentMode() === undefined) this.visualMode.enter(visualKindForMode(mode));
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

  private prepareTemporaryInsertAfter(): void {
    if (!this.temporaryNormal) return;
    const selection = this.editor.getSelections()[0];
    if (selection === undefined || selection.type !== "charwise") return;
    const head = selectionHead(selection);
    const line = this.editor.line(head.row);
    this.editor.setSelections([
      charwiseSelection({ row: head.row, column: nextGraphemeBoundary(line, head.column) }),
    ]);
  }

  private finishTemporaryNormalCommand(): void {
    if (!this.temporaryNormal || this.deferTemporaryNormalCompletion > 0) return;
    if (this.modeState === "normal" && !this.isPending()) {
      this.returnFromTemporaryNormal();
    } else if (this.modeState !== "normal" && !this.isVisualMode()) {
      this.temporaryNormal = false;
    }
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
    this.globalState.repeat.clearPendingVisualChange();
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

  private swallowedKeyWarningRemainingMs(): number | undefined {
    const remaining = this.swallowedKeyWarningUntil - Date.now();
    return remaining > 0 ? remaining : undefined;
  }

  // A prompt swallowed a key it does not understand: keep it (display
  // formatted) visible in the status for a moment so the no-op is loud.
  private reportSwallowedPromptKey(key: string): void {
    this.swallowedKeyWarning = keyForStatus(key);
    this.swallowedKeyWarningUntil = Date.now() + swallowedKeyWarningDurationMs;
  }

  private searchStatusRemainingMs(): number | undefined {
    if (this.searchStatusUntil === undefined) return undefined;
    const remaining = this.searchStatusUntil - Date.now();
    return remaining > 0 ? remaining : undefined;
  }

  private searchStatusVisible(): boolean {
    if (this.searchStatus === undefined) return false;
    return this.searchStatusUntil === undefined || this.searchStatusUntil > Date.now();
  }

  // Keep a committed search's outcome visible for a moment (Vim `[x/y]`/E486).
  private reportSearchStatus(status: SearchStatus): void {
    this.searchStatus = status;
    this.searchStatusUntil =
      Date.now() + (status.kind === "count" ? searchCountStatusDurationMs : searchNotFoundStatusDurationMs);
  }

  // Live prompt feedback: update the status as the pending query changes.
  private setPendingSearchStatus(status: SearchStatus | undefined): void {
    this.searchStatus = status;
    this.searchStatusUntil = undefined;
  }

  private commandStatusRemainingMs(): number | undefined {
    if (this.commandStatus === undefined) return undefined;
    const remaining = this.commandStatusUntil - Date.now();
    return remaining > 0 ? remaining : undefined;
  }

  // Keep an ex command's outcome message visible for a moment.
  private reportCommandStatus(report: CommandStatusReport): void {
    this.commandStatus = report;
    this.commandStatusUntil = Date.now() + commandStatusDurationMs;
  }

  private enterInsertMode({ origin, count = 1, separator = "" }: { origin: VimMode; count?: number; separator?: string }): void {
    this.modelState.marks.setBuiltinMark(".", selectionHead(this.editor.getSelections()[0]));
    this.insertOrigin = origin;
    this.startInsertOrReplaceSession({ count, separator });
    this.setMode("insert");
  }

  // Zed: `replace::Vim::undo_replace` — backspace in replace mode restores
  // what was overwritten in this session, or just moves left otherwise.
  private undoReplace(): void {
    const selection = this.editor.getSelections()[0];
    if (selection === undefined) return;
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
  }

  private enterReplaceMode({ count, separator }: { count: number; separator: string }): void {
    this.replaceModeReplacements = [];
    this.startInsertOrReplaceSession({ count, separator });
    this.editor.setCursorStyle("block");
    this.setMode("replace");
  }

  // Payload-less mode transitions. Entering `search`/`command` must construct
  // the session payload through [setSession]; the parameter type rejects them
  // here, so a prompt mode cannot be entered without its prompt.
  private setMode(mode: Exclude<VimMode, "search" | "command">): void {
    this.setSession({ mode });
  }

  private setSession(session: ModeSession): void {
    const previous = this.modeState;
    this.session = session;
    // Keep the executor in sync across transitions to/from the framework-owned
    // non-normal modes (`search`, visual kinds), so it builds the right per-mode
    // handlers. Owner-side paths (legacy entry like `gv`/mouse, escape, the
    // legacy visual-search exit) change the mode without an executor action;
    // framework actions already set the executor's mode, so [syncMode] no-ops for
    // them (entering `search` rebuilds explicitly once the prompt exists).
    if (isExecutorOwnedNonNormalMode(previous) || isExecutorOwnedNonNormalMode(session.mode)) {
      this.keyExecutor.syncMode(session.mode);
    }
  }

  private startInsertOrReplaceSession({ count, separator }: { count: number; separator: string }): void {
    this.insertRepeatCount = count;
    this.insertRepeatText = "";
    this.insertRepeatSeparator = separator;
  }

  private finishInsertOrReplaceSession(mode: "insert" | "replace"): void {
    this.modelState.lastInsertPosition = selectionHead(this.editor.getSelections()[0]);
    this.modelState.marks.setBuiltinMark("^", this.modelState.lastInsertPosition);
    const pendingVisualChange = this.globalState.repeat.takePendingVisualChange();
    if (pendingVisualChange !== undefined && !this.globalState.repeat.isReplaying()) {
      this.globalState.repeat.recordVisualAction(pendingVisualChange, { type: "change", insertedText: this.insertRepeatText });
    }
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
      // Framework operator-pending state never surfaced here (pre-existing
      // gap): operator-pending remaps only applied to the legacy grammar,
      // which is gone.
      operatorPending: false,
    });
  }

  private executeMappedCommand(command: NormalizedRemapping["commands"][number]): QueuedRunResult<void> {
    const versionBefore = this.editor.documentVersion();
    const modeBefore = this.modeState;
    const finish = () => {
      if (this.editor.documentVersion() !== versionBefore) {
        this.modelState.changeList.record(this.editor, { insertMode: modeBefore === "insert" });
      }
      this.finishTemporaryNormalCommand();
    };
    const finishResult = (result: QueuedRunResult<void>): QueuedRunResult<void> => {
      if (result !== undefined && typeof (result as Promise<void>).then === "function") {
        return Promise.resolve(result).then(finish);
      }
      finish();
    };

    const commandText = typeof command === "string" ? command : command.command;
    if (!commandText.startsWith(":")) {
      this.editor.executeNativeCommand(
        commandText,
        typeof command === "string" ? [] : commandArgs(command),
        { preserveVisualSelection: this.isVisualMode() }
      );
      return finishResult(undefined);
    }

    const exCommand = commandText.slice(1);
    const options = this.commandOptions();
    const run = () => {
      const defersTemporaryNormal = /\bnorm(?:al)?!?\b/.test(exCommand);
      if (defersTemporaryNormal) this.deferTemporaryNormalCompletion++;
      try {
        executeCommand(this.editor, exCommand, options);
      } finally {
        if (defersTemporaryNormal) this.deferTemporaryNormalCompletion--;
      }
    };
    const registerToRead = commandRegisterToRead(this.editor, exCommand, options);
    if (registerToRead === undefined) return finishResult(run());
    const refresh = this.registers.refreshSystemClipboardRegister(registerToRead.registerName);
    return refresh === undefined ? finishResult(run()) : refresh.then(run).then(finish);
  }

  private collapseToFirstCursor(): void {
    const collapsed = collapseToPrimaryNormalCursor(this.editor.getSelections());
    if (collapsed.length > 0) this.editor.setSelections(collapsed);
  }

  private hasMultipleCursorsOrSelection(): boolean {
    return hasMultipleCursorsOrSelection(this.editor.getSelections());
  }

  // The execution context shared by every ex-command entry point
  // ([executeCommand], [substitutePreviews], [commandRegisterToRead]).
  private commandOptions(): CommandOptions {
    return {
      runNormalKeys: (keys, range) => this.runNormalKeysForCommand(keys, range),
      exOptions: this.globalState.exOptions,
      markLine: (name: string) => this.modelState.marks.position(name)?.row,
      registers: this.registers,
      lastSearchPattern: {
        read: () => this.globalState.search.lastPattern(),
        write: pattern => this.globalState.search.setLastFromExCommand(pattern, this.registers),
      },
      report: report => this.reportCommandStatus(report),
    };
  }

  private runNormalKeysForCommand(keys: readonly string[], range: LineRange | undefined): void {
    const currentRow = selectionHead(this.editor.getSelections()[0]).row;
    const target = range ?? { startRow: currentRow, endRowInclusive: currentRow };
    for (let row = target.startRow; row <= target.endRowInclusive; row++) {
      this.editor.setSelections([{ type: "charwise", anchor: { row, column: 0 }, head: { row, column: 0 } }]);
      for (const key of keys) {
        this.onKey(key);
        this.keyExecutor.drainReentrantEffects();
      }
      if (this.modeState === "insert") {
        this.onKey("<escape>");
        this.keyExecutor.drainReentrantEffects();
      }
    }
  }

  private replayVisualAction(selection: RecordedSelection, action: VisualRepeatAction): QueuedRunResult<void> {
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
      case "replaceWithRegister": {
        const apply = () => {
          const range = this.rangeForRecordedSelection(selection);
          if (range === undefined) return;
          const target = selection.type === "visualLine"
            ? {
                kind: "linewise" as const,
                rows: [{ startRow: range.start.row, endRow: range.end.row, column: range.start.column }],
              }
            : {
                kind: "charwise" as const,
                targets: [{ range, head: range.start }],
              };
          applyOperatorToTarget(
            this.editor,
            this.registers,
            action.registerName,
            { type: "replaceWithRegister" },
            target
          );
        };
        const refresh = this.registers.refreshSystemClipboardRegister(action.registerName);
        return refresh === undefined ? apply() : refresh.then(apply);
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

  private applyMotion(motion: Motion, count: number): void {
    if (this.modeState === "normal") {
      this.normalMode.applyMotion(motion, count);
    } else if (this.isVisualMode()) {
      this.visualMode.applyMotion(motion, count);
    }
  }

  private isVisualMode(): boolean {
    return isVisualModeKind(this.modeState);
  }

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
    case "ctrl-t":
    case "ctrl-u":
    case "ctrl-v":
    case "ctrl-w":
    case "ctrl-x":
    case "ctrl-y":
    case "ctrl-[":
    case "ctrl-]":
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

// Local test helper, analogous in spirit to Zed's test harness helpers in
// `test::vim_test_context::VimTestContext` rather than a production API.
export function runKeys(vim: Vim, keys: readonly string[]): void {
  for (const key of keys) {
    vim.onKey(key);
    vim.assertModeStateInvariants(`after key "${key}"`);
  }
}
