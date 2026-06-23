import {
  HandlerEnv,
  HandlerState,
  KeyAction,
  cloneHandlerState,
  combineHandleResults,
  initialHandlerState,
} from "./key_handler.js";
import type { VimCommandMapping } from "./config.js";
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
  /** Timer that accepts [conflict] if no disambiguating key arrives. */
  private conflictTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Tail of the queued action chain. Key handling updates parser state synchronously, but
   * accepted effect actions run through this promise chain so async editor effects cannot
   * complete out of order.
   */
  private runQueueTail: Promise<void> = Promise.resolve();
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
    this.state = { ...cloneHandlerState(initialHandlerState), mode, editor: this.state.editor };
    this.handlerEnvs = this.options.handlersForState(this.state);
    this.logDebug(`reset mode=${mode}`);
  }

  /**
   * Dispatch one key through the active handlers. Parser state is updated
   * immediately; accepted effect actions are enqueued and run later in order.
   */
  handle(key: string): boolean {
    const previousConflict = this.conflict;
    this.clearConflictTimer();

    const result = combineHandleResults(
      this.handlerEnvs.map(({ handler, state }) => handler(key, state))
    );

    switch (result.type) {
      case "run":
        this.clearConflict();
        this.executeAction(result.action);
        this.logDebug(`key=[${key}] action mode=${result.action.mode}`);
        return true;
      case "handler":
        this.handlerEnvs = result.handlerEnvs;
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
    this.state = { ...cloneHandlerState(this.state), mode: action.mode };
    this.handlerEnvs = this.options.handlersForState(this.state);
    this.runAction(action);
    this.replayKeys(replayKeys);
  }

  private runAction(action: KeyAction<void>): void {
    switch (action.type) {
      case "effect":
        this.enqueueEffect(action);
        break;
      case "keys":
        for (const { key } of action.keys) this.handle(key);
        break;
      case "commands":
        for (const command of action.commands) this.options.executeCommand?.(command);
        break;
      case "sequence":
        for (const nested of action.actions) this.executeAction(nested);
        break;
    }
  }

  /** Append [action] to the effect queue, preserving action completion order. */
  private enqueueEffect(action: Extract<KeyAction<void>, { type: "effect" }>): void {
    const task = async () => {
      await action.run();
    };
    const next = this.runQueueTail.then(task, task);
    this.runQueueTail = next.then(undefined, () => undefined);
    void next.catch((error) => this.logError("queued run failed", error));
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

  /** Re-dispatch replayed keys synchronously through this executor. */
  private replayKeys(keys: readonly string[]): void {
    for (const key of keys) this.handle(key);
  }

  private logDebug(message: string): void {
    this.options.log?.debug?.(message);
  }

  private logError(message: string, error: unknown): void {
    this.options.log?.error?.(message, error);
  }
}
