import type { VimCommandMapping } from "./config.js";
import {
  EffectMeta,
  HandleResult,
  HandlerEnv,
  HandlerState,
  KeyAction,
  KeyToDispatch,
  PendingEffect,
  QueuedRunResult,
  cloneHandlerState,
  combineHandleResults,
  initialHandlerState,
} from "./key_handler.js";
import type { VimMode } from "./state.js";

// A [setTimeout] handle. Aliased so the field, options, and global fallback stay
// consistent whether the ambient `setTimeout` returns `number` (DOM lib) or a
// handle object (Node lib). They differ under the mixed-lib setup of the VSCode
// build, where `this.options.setTimeout ?? setTimeout` would otherwise infer a
// `number | TimeoutHandle` union that is not assignable to the handle field. The
// handle is opaque: it is only ever passed back to the matching `clearTimeout`.
type TimerHandle = ReturnType<typeof setTimeout>;

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
  executeCommand?: (command: VimCommandMapping) => QueuedRunResult<void>;
  /** Resolve execution-time dependencies (notably clipboard-backed registers)
      immediately before an effect runs. */
  beforeEffect?: (meta: EffectMeta) => QueuedRunResult<void>;
  /** Owner postprocessing that must run after the effect body, including when
      the action was reached through queued redispatch. */
  afterEffect?: (meta: EffectMeta) => void;
  /**
   * How to dispatch a key emitted by an accepted action (a `keys` action) or
   * replayed after an ambiguous conflict resolves. It represents the owner's
   * full key pipeline, so emitted keys go through the same path as physically
   * typed keys. Defaults to this executor's own [handle], which is enough for
   * standalone use/tests; the integrating owner overrides it to also fall back
   * to any not-yet-migrated dispatcher. The executor itself knows nothing about
   * that fallback.
   */
  redispatch?: (key: string, allowRemap: boolean) => QueuedRunResult<void>;
  /**
   * Apply the Vim mode an accepted action targets (the [mode] on the action /
   * effect). The executor owns mode transitions: after running an action it
   * reports the target mode here so the owner can transition (e.g. a `change`
   * action targets insert mode). Usually called synchronously after the action
   * runs. A dynamic visual action reached through queued redispatch transitions
   * after its effect, because its resulting mode depends on that effect. The owner
   * decides what an entry means (e.g. entering insert starts an insert session);
   * a target mode equal to the current mode is a no-op.
   */
  onEnterMode?: (
    mode: VimMode,
    opts?: {
      enterInsert?: { count: number; separator: string };
      search?: { backwards: boolean };
    }
  ) => void;
  log?: KeyExecutorLog;
  timeoutMs?: number | (() => number);
  setTimeout?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
};

export class KeyExecutor {
  /** Active parser continuations for the next key. */
  private handlerEnvs: readonly HandlerEnv<void>[];
  /** Accepted shorter action plus pending longer branches for ambiguous chords. */
  private conflict: KeyExecutorConflict | undefined;
  /** True while a chord is mid-flight (the last key left a pending continuation). */
  private pending = false;

  /** Bumped whenever parser state may have moved ([commit]/[reset]/
      [acceptConflict]). A [parse] result tagged with an older generation must
      not be committed — the owner re-parses instead. This lets the synchronous
      ownership decision reuse its single evaluation across the host's async
      boundary in the common case while staying correct when keys race ahead of
      their queued commits. */
  private stateGeneration = 0;

  /** [dotRepeatable] of the effect run during the current/last [handle]. */
  private lastDotRepeatable: boolean | undefined;

  /** [syncAfter] of the effect run during the current/last [handle]. */
  private lastSyncAfter = false;
  private lastTemporaryInsertAfter = false;

  /** [insertTyped] of the effect run during the current/last [handle]. */
  private lastInsertTyped = false;

  /** [preservesDotRepeat] of the effect run — or of the pending continuation
      entered — during the current/last [handle]. */
  private lastPreservesDotRepeat = false;

  /** True when the last [handle] abandoned a pending chord (invalid/cancel). */
  private lastHandleCancelled = false;

  /** Timer that accepts [conflict] if no disambiguating key arrives. */
  private conflictTimer: TimerHandle | undefined;
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
  private rejectIdle: ((error: unknown) => void) | undefined;
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

  /** Sync the executor to an owner-driven mode change (e.g. a legacy path or
      escape that changed the Vim mode without going through an executor action).
      Rebuilds the default handlers for [mode]; a no-op when already in [mode], so
      it never clobbers an in-flight framework chord that just entered the mode. */
  syncMode(mode: VimMode): void {
    if (this.state.mode === mode) return;
    this.reset(mode);
  }

  /** Clear pending handlers/conflicts and rebuild default handlers for [mode]. */
  reset(mode: VimMode = this.state.mode): void {
    this.stateGeneration++;
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

  lastEffectTemporaryInsertAfter(): boolean {
    return this.lastTemporaryInsertAfter;
  }

  /** Whether the effect run during the most recent [handle] was a passthrough
      insert/replace-mode character (see [EffectMeta.insertTyped]): the owner
      records it as a `typed` key and reproduces the edit via the default
      handler. [false] when no such effect ran. */
  lastEffectInsertTyped(): boolean {
    return this.lastInsertTyped;
  }

  /** Whether the most recent [handle] was transparent to dot-repeat (its effect
      or entered pending continuation set [preservesDotRepeat]): the owner should
      leave the dot-repeat recording untouched for this key. */
  lastEffectPreservesDotRepeat(): boolean {
    return this.lastPreservesDotRepeat;
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

  hasQueuedWork(): boolean {
    return this.draining || this.effectQueue.length > 0;
  }

  /** Run a deliberately re-entrant key while suspending already queued work,
      then drain only the effects produced by that key. */
  runReentrant(run: () => void): void {
    const suspended = this.effectQueue.splice(0);
    try {
      run();
      this.drainReentrantEffects();
    } finally {
      this.effectQueue.unshift(...suspended);
    }
  }

  /** Drain effects queued by a deliberately re-entrant command such as
      `:normal`. Its root action preloads register dependencies, so nested leaf
      effects must remain synchronous; encountering async work is an invariant
      violation rather than silently reordering subsequent keys/rows. */
  drainReentrantEffects(): void {
    while (this.effectQueue.length > 0) {
      const run = this.effectQueue.shift();
      if (run === undefined) return;
      const result = run();
      if (isPromiseLike(result)) {
        throw new Error("re-entrant key execution produced an asynchronous effect");
      }
    }
  }

  /**
   * Dispatch one key through the active handlers. Parser state is updated
   * immediately; accepted effect actions are enqueued and run later in order.
   *
   * Returns whether a handler claimed the key. [false] means no active handler
   * recognized it (and there was no pending conflict to accept), so the owner
   * is free to treat it as native/unowned. [allowRemap] is threaded into the
   * handler state so the remap handler can decline to remap emitted keys.
   *
   * [handle] is [parse] immediately followed by [commit]. They are split so the
   * owner can decide ownership synchronously (from [parse]) — before, e.g., an
   * asynchronous system-clipboard read — and apply the effects afterward (via
   * [commit]), across the host's synchronous `preventDefault` boundary.
   */
  handle(key: string, allowRemap = true): boolean {
    return this.commit(key, this.parse(key, allowRemap).result);
  }

  /**
   * Evaluate [key] against the current handlers *without side effects*: no parser
   * state is advanced and no effect is queued. Returns the grammar [result] and
   * whether it [claimed] the key (the value [handle]/[commit] returns). Every
   * root handler is pure — buffer changes are deferred as [effect] actions and
   * interactive prompt updates as pending [PendingEffect]s — so this is safe to
   * call for the ownership decision alone; pass [result] to [commit] to apply it.
   */
  parse(
    key: string,
    allowRemap = true
  ): { result: HandleResult<void>; claimed: boolean; generation: number } {
    const result = combineHandleResults(
      this.handlerEnvs.map(({ handler, state }) =>
        handler(key, { ...state, allowRemap })
      )
    );
    // Mirrors [commit]'s return: every outcome is claimed except an [unhandled]
    // key with no pending conflict to accept.
    const claimed = result.type !== "unhandled" || this.conflict !== undefined;
    return { result, claimed, generation: this.stateGeneration };
  }

  /** The generation a fresh [parse] would be tagged with; a stored parse from
      an older generation is stale (see [stateGeneration]). */
  currentGeneration(): number {
    return this.stateGeneration;
  }

  /**
   * Apply a [result] from [parse]: advance parser state and run/enqueue its
   * effects, returning whether the key was claimed. Must be called with the same
   * parser state [parse] saw (no intervening [handle]/[reset]); the owner
   * serializes keys so this holds across the `preventDefault` boundary.
   */
  commit(key: string, result: HandleResult<void>): boolean {
    this.stateGeneration++;
    const previousConflict = this.conflict;
    this.clearConflictTimer();
    // Reset before running: stays [undefined] if this key only left a pending
    // chord (no command completed), so the owner can tell "mid-chord" from a
    // completed dot-repeatable / non-repeatable command.
    this.lastDotRepeatable = undefined;
    this.lastSyncAfter = false;
    this.lastTemporaryInsertAfter = false;
    this.lastInsertTyped = false;
    this.lastHandleCancelled = false;
    this.lastPreservesDotRepeat = false;

    switch (result.type) {
      case "run":
        this.clearConflict();
        this.executeAction(result.action);
        this.logDebug(`key=[${key}] action mode=${result.action.mode}`);
        return true;
      case "handler":
        this.handlerEnvs = result.handlerEnvs;
        this.pending = true;
        this.lastPreservesDotRepeat = result.preservesDotRepeat === true;
        if (previousConflict !== undefined) {
          this.setConflict({
            ...previousConflict,
            replaySuffix: [...previousConflict.replaySuffix, key],
          });
        } else {
          this.clearConflict();
        }
        // A pending continuation may carry a side effect to run when its chord
        // key is accepted (e.g. update the `d/` incsearch preview, then keep
        // waiting). It is a plain side effect — no mode transition — so it goes
        // straight onto the effect queue and does not touch [lastDotRepeatable].
        if (result.effect !== undefined) this.enqueuePendingEffect(result.effect);
        this.logDebug(
          `key=[${key}] pending handlers=${this.handlerEnvs.length}`
        );
        return true;
      case "conflict":
        this.handlerEnvs = result.pending;
        this.pending = true;
        this.lastPreservesDotRepeat = result.preservesDotRepeat === true;
        this.setConflict({ accepted: result.accepted, replaySuffix: [] });
        if (result.effect !== undefined) this.enqueuePendingEffect(result.effect);
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
    this.stateGeneration++;
    this.executeConflict(conflict, conflict.replaySuffix);
    this.logDebug("accepted conflict");
    return true;
  }

  /** Run the accepted shorter action, then replay buffered suffix keys in queue order. */
  private executeConflict(
    conflict: KeyExecutorConflict,
    replayKeys: readonly string[]
  ): void {
    this.clearConflict();
    this.executeAction(conflict.accepted, replayKeys);
  }

  /** Accept an action, preserving effect/replay order across async dependencies. */
  private executeAction(
    action: KeyAction<void>,
    replayKeys: readonly string[] = []
  ): void {
    this.conflict = undefined;
    this.pending = false;
    this.state = { ...cloneHandlerState(this.state), mode: action.mode };
    this.handlerEnvs = this.options.handlersForState(this.state);
    if (action.type === "effect" && this.draining) {
      this.lastDotRepeatable = action.dotRepeatable === true;
      this.lastSyncAfter = action.syncAfter === true;
      this.lastTemporaryInsertAfter = action.temporaryInsertAfter === true;
      this.lastInsertTyped = action.insertTyped === true;
      this.lastPreservesDotRepeat = action.preservesDotRepeat === true;
                  this.enqueueEffect(action, () => {
        this.options.onEnterMode?.(action.resolveMode?.() ?? action.mode, {
          enterInsert: action.enterInsert,
          search: action.search,
        });
        this.options.afterEffect?.(action);
        this.replayKeys(replayKeys);
      });
;
      return;
    }

    if (replayKeys.length > 0) {
      const replay = () => this.replayKeys(replayKeys);
      if (action.type === "keys") {
        this.enqueueRedispatchedKeys(action.keys, 0, replay);
        return;
      }
      if (action.type === "commands") {
        this.enqueueCommands(action.commands, 0, replay);
        return;
      }
      if (action.type === "sequence") {
        this.enqueueActionSequence(action.actions, 0, replay);
        return;
      }
    }

    this.runAction(action);
    if (action.type === "effect") {
      this.lastDotRepeatable = action.dotRepeatable === true;
      this.lastSyncAfter = action.syncAfter === true;
      this.lastTemporaryInsertAfter = action.temporaryInsertAfter === true;
      this.lastInsertTyped = action.insertTyped === true;
      this.lastPreservesDotRepeat = action.preservesDotRepeat === true;
      const targetMode = action.resolveMode !== undefined ? action.resolveMode() : action.mode;
      this.options.onEnterMode?.(targetMode, {
        enterInsert: action.enterInsert,
        search: action.search,
      });
    }
    this.replayKeys(replayKeys);
  }

  private runAction(action: KeyAction<void>): void {
    switch (action.type) {
      case "effect":
        this.enqueueEffect(action);
        break;
      case "keys":
        this.enqueueRedispatchedKeys(action.keys);
        break;
      case "commands":
        this.enqueueCommands(action.commands);
        break;
      case "sequence":
        this.enqueueActionSequence(action.actions);
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
    action: Extract<KeyAction<void>, { type: "effect" }>,
    onComplete: () => void = () => {}
  ): void {
    this.enqueueRun(() => {
      const runEffect = (): QueuedRunResult<void> => {
        const finish = () => onComplete();
        const result = action.run();
        if (isPromiseLike(result)) return Promise.resolve(result).then(finish);
        finish();
      };
      const before = this.options.beforeEffect?.(action);
      return isPromiseLike(before)
        ? Promise.resolve(before).then(runEffect)
        : runEffect();
    });
  }

  private enqueuePendingEffect(effect: PendingEffect): void {
    this.enqueueRun(() => {
      const run = (): QueuedRunResult<void> => {
        try {
          const result = effect.run();
          if (isPromiseLike(result)) {
            return Promise.resolve(result).finally(() => this.stateGeneration++);
          }
          this.stateGeneration++;
          return;
        } catch (error) {
          this.stateGeneration++;
          throw error;
        }
      };
      const before = this.options.beforeEffect?.(effect);
      return isPromiseLike(before)
        ? Promise.resolve(before).then(run, error => {
            this.stateGeneration++;
            throw error;
          })
        : run();
    });
  }

  /**
   * Append a side-effect thunk to the effect queue and drive it, with the same
   * synchronous-until-async draining as [enqueueEffect]. Used both for command
   * effect actions and for a pending continuation's [PendingEffect].
   */
  private enqueueRun(run: () => QueuedRunResult<void>): void {
    this.effectQueue.push(run);
    if (this.draining) return;
    this.draining = true;
    if (this.resolveIdle === undefined) {
      this.idle = new Promise((resolve, reject) => {
        this.resolveIdle = resolve;
        this.rejectIdle = reject;
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
        this.failEffects(error);
        return;
      }
      if (isPromiseLike(result)) {
        void Promise.resolve(result).then(
          () => this.drainEffects(),
          error => this.failEffects(error)
        );
        return;
      }
    }
    this.draining = false;
    const resolveIdle = this.resolveIdle;
    this.resolveIdle = undefined;
    this.rejectIdle = undefined;
    resolveIdle?.();
  }

  private failEffects(error: unknown): void {
    this.logError("queued run failed", error);
    this.effectQueue.length = 0;
    this.draining = false;
    const rejectIdle = this.rejectIdle;
    this.resolveIdle = undefined;
    this.rejectIdle = undefined;
    rejectIdle?.(error);
  }

  private setConflict(conflict: KeyExecutorConflict): void {
    this.conflict = conflict;
    this.clearConflictTimer();
    const timeoutMs =
      typeof this.options.timeoutMs === "function"
        ? this.options.timeoutMs()
        : this.options.timeoutMs;
    if (timeoutMs === undefined) return;
    // Cast the ambient fallback to the option's signature so its [TimerHandle]
    // return type is used (see [TimerHandle]); the raw global's return type is
    // environment-dependent.
    const setTimer =
      this.options.setTimeout ??
      (setTimeout as unknown as NonNullable<KeyExecutorOptions["setTimeout"]>);
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
    const clearTimer =
      this.options.clearTimeout ??
      (clearTimeout as unknown as NonNullable<
        KeyExecutorOptions["clearTimeout"]
      >);
    clearTimer(this.conflictTimer);
    this.conflictTimer = undefined;
  }

  private enqueueActionSequence(
    actions: readonly KeyAction<void>[],
    index = 0,
    onComplete: () => void = () => {}
  ): void {
    const action = actions[index];
    if (action === undefined) {
      onComplete();
      return;
    }
    const next = () => this.enqueueActionSequence(actions, index + 1, onComplete);
    switch (action.type) {
      case "keys":
        this.enqueueRedispatchedKeys(action.keys, 0, next);
        return;
      case "commands":
        this.enqueueCommands(action.commands, 0, next);
        return;
      case "sequence":
        // Flattening preserves order; remap-generated sequences contain keys
        // and commands, but nested sequences are valid in the generic action type.
        this.enqueueActionSequence([...action.actions, ...actions.slice(index + 1)], 0, onComplete);
        return;
      case "effect":
        this.enqueueEffect(action, next);
        return;
    }
  }

  /** Re-dispatch emitted keys one at a time. A key's queued effects are inserted
      before the next redispatch, preserving order across async dependencies. */
  private enqueueRedispatchedKeys(
    keys: readonly KeyToDispatch[],
    index = 0,
    onComplete: () => void = () => {}
  ): void {
    const key = keys[index];
    if (key === undefined) {
      onComplete();
      return;
    }
    this.enqueueRun(() => {
      const result = this.redispatch(key.key, key.allowRemap);
      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(() => this.enqueueRedispatchedKeys(keys, index + 1, onComplete));
      }
      this.enqueueRedispatchedKeys(keys, index + 1, onComplete);
      return;
    });
  }

  private replayKeys(keys: readonly string[]): void {
    this.enqueueRedispatchedKeys(keys.map(key => ({ key, allowRemap: true })));
  }

  private enqueueCommands(
    commands: readonly VimCommandMapping[],
    index = 0,
    onComplete: () => void = () => {}
  ): void {
    const command = commands[index];
    if (command === undefined) {
      onComplete();
      return;
    }
    this.enqueueRun(() => {
      const result = this.options.executeCommand?.(command);
      if (result !== undefined && typeof (result as Promise<void>).then === "function") {
        return Promise.resolve(result).then(() => this.enqueueCommands(commands, index + 1, onComplete));
      }
      this.enqueueCommands(commands, index + 1, onComplete);
      return;
    });
  }

  /**
   * Re-dispatch an emitted or replayed key. Delegates to the owner-provided
   * pipeline when configured, otherwise re-enters this executor. The executor
   * does not know what (if anything) the owner does beyond this executor.
   */
  private redispatch(key: string, allowRemap: boolean): QueuedRunResult<void> {
    if (this.options.redispatch !== undefined) return this.options.redispatch(key, allowRemap);
    this.handle(key, allowRemap);
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
