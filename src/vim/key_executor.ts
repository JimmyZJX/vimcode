import type { VimCommandMapping } from "./config.js";
import {
  HandlerEnv,
  HandlerState,
  KeyAction,
  QueuedRunResult,
  cloneHandlerState,
  combineHandleResults,
  initialHandlerState,
} from "./key_handler.js";
import type { VimMode } from "./state.js";

export type KeyExecutorHandlers = (
  state: HandlerState
) => readonly HandlerEnv<void>[];

export type KeyExecutorConflict = {
  accepted: KeyAction<void>;
  replaySuffix: readonly string[];
};

export type KeyExecutorLog = {
  debug?: (message: string) => void;
  error?: (message: string, error: unknown) => void;
};

export type KeyExecutorOptions = {
  handlersForState: KeyExecutorHandlers;
  executeCommand?: (command: VimCommandMapping) => void;
  /**
   * How to dispatch a key emitted by an accepted action (a `keys` action) or
   * replayed after an ambiguous conflict resolves. It represents the owner's
   * full key pipeline, so emitted keys go through the same path as physically
   * typed keys. Defaults to this executor's own [handle], which is enough for
   * standalone use/tests; the integrating owner overrides it to also fall back
   * to any not-yet-migrated dispatcher. The executor itself knows nothing about
   * that fallback.
   */
  redispatch?: (key: string, allowRemap: boolean) => void;
  // CR jimzhao: decide whether `onEnterMode` is really needed. (`onCancel` was
  // removed in favor of [lastHandleCancelled]; `onEnterMode` is still used for
  // the insert-mode transition + session params.)
  /**
   * Apply the Vim mode an accepted action targets (the [mode] on the action /
   * effect). The executor owns mode transitions: after running an action it
   * reports the target mode here so the owner can transition (e.g. a `change`
   * action targets insert mode). Called synchronously after the action runs, not
   * inside its (possibly async) effect callback — keys are dispatched
   * synchronously, so the transition must be observable immediately. The owner
   * decides what an entry means (e.g. entering insert starts an insert session);
   * a target mode equal to the current mode is a no-op.
   */
  onEnterMode?: (mode: VimMode, opts?: { enterInsert?: { count: number; separator: string } }) => void;
  /**
   * Feed a finite-keymap chord (e.g. a not-yet-migrated `g`-chord) to the legacy
   * keymap resolver. The owner resolves/dispatches the chord; the executor stays
   * agnostic to what the chord does. Used by the `legacyKeymap` action.
   */
  dispatchToLegacyKeymap?: (keys: readonly string[], count: number | undefined) => void;
  log?: KeyExecutorLog;
  timeoutMs?: number | (() => number);
  setTimeout?: (
    callback: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
};

export class KeyExecutor {
  /** Active parser continuations for the next key. */
  private handlerEnvs: readonly HandlerEnv<void>[];
  /** Accepted shorter action plus pending longer branches for ambiguous chords. */
  private conflict: KeyExecutorConflict | undefined;
  /** True while a chord is mid-flight (the last key left a pending continuation). */
  private pending = false;

  /** [dotRepeatable] of the effect run during the current/last [handle]. */
  private lastDotRepeatable: boolean | undefined;

  /** [syncAfter] of the effect run during the current/last [handle]. */
  private lastSyncAfter = false;

  /** True when the last [handle] abandoned a pending chord (invalid/cancel). */
  private lastHandleCancelled = false;

  /** Timer that accepts [conflict] if no disambiguating key arrives. */
  private conflictTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Accepted effect actions waiting to run, in order. Key handling updates
   * parser state synchronously; effects run through this queue so each observes
   * the editor only after earlier effects have finished.
   */
  private readonly effectQueue: Array<() => QueuedRunResult<void>> = [];
  /** True while [drainEffects] owns the queue (including across an async wait). */
  private draining = false;
  /** Resolves when the queue drains; replaced whenever draining (re)starts. */
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;
  /** Shared parser environment visible to newly-created default handlers. */
  private state: HandlerState;

  constructor(
    private readonly options: KeyExecutorOptions,
    initialState: HandlerState = initialHandlerState
  ) {
    this.state = cloneHandlerState(initialState);
    this.handlerEnvs = this.options.handlersForState(this.state);
  }

  /** Snapshot of the executor's current parser state. */
  currentState(): HandlerState {
    return cloneHandlerState(this.state);
  }

  /** Active handlers, exposed for status/debugging during migration. */
  currentHandlers(): readonly HandlerEnv<void>[] {
    return this.handlerEnvs;
  }

  /** Current ambiguous chord, if any. */
  pendingConflict(): KeyExecutorConflict | undefined {
    return this.conflict;
  }

  /** Clear pending handlers/conflicts and rebuild default handlers for [mode]. */
  reset(mode: VimMode = this.state.mode): void {
    this.clearConflict();
    this.pending = false;
    this.state = {
      ...cloneHandlerState(initialHandlerState),
      mode,
      editor: this.state.editor,
      registers: this.state.registers,
    };
    this.handlerEnvs = this.options.handlersForState(this.state);
    this.logDebug(`reset mode=${mode}`);
  }

  /** Whether a chord is mid-flight (the last key left a pending continuation). */
  isPending(): boolean {
    return this.pending;
  }

  /** [dotRepeatable] of the effect run during the most recent [handle]: [true]
      for a dot-repeatable change, [false] for a non-repeatable command (motion,
      yank, mark), [undefined] when the key only left a pending chord. */
  lastEffectDotRepeatable(): boolean | undefined {
    return this.lastDotRepeatable;
  }

  /** Whether the effect run during the most recent [handle] asked the owner to
      reconcile Vim state from the editor afterward (the legacy
      `syncFromEditorState`). [false] when no such effect ran. */
  lastEffectSyncAfter(): boolean {
    return this.lastSyncAfter;
  }

  /** Whether the most recent [handle] abandoned a pending chord without running
      a command (an operator got a non-motion key like `.`). The cancelling key
      is not part of any command and should not be recorded for dot-repeat. */
  lastHandleWasCancel(): boolean {
    return this.lastHandleCancelled;
  }

  /**
   * The parser state the next key will see: the active continuation's state when
   * mid-chord, otherwise the default state. Exposed so the owner can read
   * parser-visible flags (e.g. whether a char input is awaited) for the upcoming
   * key.
   */
  currentParserState(): HandlerState {
    return this.handlerEnvs[0]?.state ?? this.state;
  }

  /** Promise that resolves once all currently-queued effect actions have run. */
  whenIdle(): Promise<void> {
    return this.idle;
  }

  /**
   * Dispatch one key through the active handlers. Parser state is updated
   * immediately; accepted effect actions are enqueued and run later in order.
   *
   * Returns whether a handler claimed the key. [false] means no active handler
   * recognized it (and there was no pending conflict to accept), so the owner
   * is free to treat it as native/unowned. [allowRemap] is threaded into the
   * handler state so the remap handler can decline to remap emitted keys.
   */
  handle(key: string, allowRemap = true): boolean {
    const previousConflict = this.conflict;
    this.clearConflictTimer();
    // Reset before running: stays [undefined] if this key only left a pending
    // chord (no command completed), so the owner can tell "mid-chord" from a
    // completed dot-repeatable / non-repeatable command.
    this.lastDotRepeatable = undefined;
    this.lastSyncAfter = false;
    this.lastHandleCancelled = false;

    const result = combineHandleResults(
      this.handlerEnvs.map(({ handler, state }) =>
        handler(key, { ...state, allowRemap })
      )
    );

    switch (result.type) {
      case "run":
        this.clearConflict();
        this.executeAction(result.action);
        this.logDebug(`key=[${key}] action mode=${result.action.mode}`);
        return true;
      case "handler":
        this.handlerEnvs = result.handlerEnvs;
        this.pending = true;
        if (previousConflict !== undefined) {
          this.setConflict({
            ...previousConflict,
            replaySuffix: [...previousConflict.replaySuffix, key],
          });
        } else {
          this.clearConflict();
        }
        this.logDebug(
          `key=[${key}] pending handlers=${this.handlerEnvs.length}`
        );
        return true;
      case "conflict":
        this.handlerEnvs = result.pending;
        this.pending = true;
        this.setConflict({ accepted: result.accepted, replaySuffix: [] });
        this.logDebug(
          `key=[${key}] conflict pending=${this.handlerEnvs.length}`
        );
        return true;
      case "invalid":
        if (previousConflict !== undefined) {
          this.executeConflict(previousConflict, [
            ...previousConflict.replaySuffix,
            key,
          ]);
        } else {
          this.reset(this.state.mode);
          this.lastHandleCancelled = true;
        }
        this.logDebug(`key=[${key}] invalid`);
        return true;
      case "unhandled":
        if (previousConflict !== undefined) {
          this.executeConflict(previousConflict, [
            ...previousConflict.replaySuffix,
            key,
          ]);
          this.logDebug(`key=[${key}] unhandled; accepted conflict`);
          return true;
        }
        this.pending = false;
        this.logDebug(`key=[${key}] unhandled`);
        return false;
    }
  }

  /** Accept the shorter side of an ambiguous chord, used by timeout handling. */
  acceptConflict(): boolean {
    const conflict = this.conflict;
    if (conflict === undefined) return false;
    this.executeConflict(conflict, conflict.replaySuffix);
    this.logDebug("accepted conflict");
    return true;
  }

  /** Run the accepted shorter action, then synchronously replay buffered suffix keys. */
  private executeConflict(
    conflict: KeyExecutorConflict,
    replayKeys: readonly string[]
  ): void {
    this.clearConflict();
    this.executeAction(conflict.accepted, replayKeys);
  }

  /** Accept an action: switch mode/handlers synchronously, execute action, then replay keys. */
  private executeAction(
    action: KeyAction<void>,
    replayKeys: readonly string[] = []
  ): void {
    this.conflict = undefined;
    this.pending = false;
    this.state = { ...cloneHandlerState(this.state), mode: action.mode };
    this.handlerEnvs = this.options.handlersForState(this.state);
    this.runAction(action);
    // The executor owns the mode transition: report the action's target mode so
    // the owner can transition (e.g. `change` -> insert). Done synchronously
    // after [runAction] (so a synchronous editor edit has already applied),
    // never inside the effect callback. Only [effect] actions carry a meaningful
    // target mode set by the handler; [keys]/[sequence]/[commands] actions
    // (remap expansions) take their mode from the leaf effects they redispatch,
    // which fire [onEnterMode] themselves — reporting the capture-time mode here
    // would clobber a transition those leaves just made (e.g. an insert-mode
    // remap expanding to `<Esc>` would be forced back into insert).
    if (action.type === "effect") {
      this.lastDotRepeatable = action.dotRepeatable === true;
      this.lastSyncAfter = action.syncAfter === true;
      this.options.onEnterMode?.(action.mode, { enterInsert: action.enterInsert });
    }
    // A chord handed to legacy is never a dot-repeatable change (the legacy side
    // owns whatever repeat semantics it has), so the framework must discard the
    // recording it opened for the chord rather than commit it as the last change.
    if (action.type === "legacyKeymap") this.lastDotRepeatable = false;
    this.replayKeys(replayKeys);
  }

  private runAction(action: KeyAction<void>): void {
    switch (action.type) {
      case "effect":
        this.enqueueEffect(action);
        break;
      case "keys":
        for (const { key, allowRemap } of action.keys)
          this.redispatch(key, allowRemap);
        break;
      case "commands":
        for (const command of action.commands)
          this.options.executeCommand?.(command);
        break;
      case "legacyKeymap":
        this.options.dispatchToLegacyKeymap?.(action.keys, action.count);
        break;
      case "sequence":
        // Run nested actions without re-resetting per action: the enclosing
        // [executeAction] already reset once, and a nested action may leave the
        // executor pending (e.g. a remap expanding to `d`, which becomes a
        // pending operator). Re-running [executeAction] here would clear that
        // pending state when a later nested action (e.g. an empty `commands`)
        // resets it.
        for (const nested of action.actions) this.runAction(nested);
        break;
    }
  }

  /**
   * Append [action] to the effect queue and drive it. Effects run synchronously
   * and in order when each completes synchronously (so a synchronous editor sees
   * the result immediately); the queue only defers to a microtask once an effect
   * returns a promise, after which the rest waits for it. Use [whenIdle] to await
   * the asynchronous tail.
   */
  private enqueueEffect(
    action: Extract<KeyAction<void>, { type: "effect" }>
  ): void {
    this.effectQueue.push(() => action.run());
    if (this.draining) return;
    this.draining = true;
    if (this.resolveIdle === undefined) {
      this.idle = new Promise((resolve) => {
        this.resolveIdle = resolve;
      });
    }
    this.drainEffects();
  }

  /**
   * Run queued effects in order. Stays synchronous until an effect returns a
   * promise; then it resumes once that promise settles. [draining] stays true
   * across the wait so concurrently-enqueued effects are appended, not run out
   * of order.
   */
  private drainEffects(): void {
    while (this.effectQueue.length > 0) {
      const run = this.effectQueue.shift();
      if (run === undefined) break;
      let result: QueuedRunResult<void>;
      try {
        result = run();
      } catch (error) {
        this.logError("queued run failed", error);
        continue;
      }
      if (isPromiseLike(result)) {
        void Promise.resolve(result)
          .catch((error) => this.logError("queued run failed", error))
          .then(() => this.drainEffects());
        return;
      }
    }
    this.draining = false;
    const resolveIdle = this.resolveIdle;
    this.resolveIdle = undefined;
    resolveIdle?.();
  }

  private setConflict(conflict: KeyExecutorConflict): void {
    this.conflict = conflict;
    this.clearConflictTimer();
    const timeoutMs =
      typeof this.options.timeoutMs === "function"
        ? this.options.timeoutMs()
        : this.options.timeoutMs;
    if (timeoutMs === undefined) return;
    const setTimer = this.options.setTimeout ?? setTimeout;
    this.conflictTimer = setTimer(() => {
      this.conflictTimer = undefined;
      this.acceptConflict();
    }, timeoutMs);
  }

  private clearConflict(): void {
    this.conflict = undefined;
    this.clearConflictTimer();
  }

  private clearConflictTimer(): void {
    if (this.conflictTimer === undefined) return;
    const clearTimer = this.options.clearTimeout ?? clearTimeout;
    clearTimer(this.conflictTimer);
    this.conflictTimer = undefined;
  }

  /** Re-dispatch replayed suffix keys synchronously through the owner pipeline. */
  private replayKeys(keys: readonly string[]): void {
    for (const key of keys) this.redispatch(key, true);
  }

  /**
   * Re-dispatch an emitted or replayed key. Delegates to the owner-provided
   * pipeline when configured, otherwise re-enters this executor. The executor
   * does not know what (if anything) the owner does beyond this executor.
   */
  private redispatch(key: string, allowRemap: boolean): void {
    if (this.options.redispatch !== undefined)
      this.options.redispatch(key, allowRemap);
    else this.handle(key, allowRemap);
  }

  private logDebug(message: string): void {
    this.options.log?.debug?.(message);
  }

  private logError(message: string, error: unknown): void {
    this.options.log?.error?.(message, error);
  }
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as PromiseLike<T>).then === "function"
  );
}
