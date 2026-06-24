import type { VimCommandMapping, WhenEvaluator } from "./config.js";
import type { VimEditorCapabilities } from "./editor.js";
import type { RegisterName, Registers } from "./registers.js";
import type { VimMode } from "./state.js";

export type HandlerState = {
  mode: VimMode;
  // TODO: Move this into a typed count/repeat handler once counts no longer
  // live in Vim's shared environment. It stays here for now to preserve the
  // existing leading-zero and status-display behavior during migration.
  repeat: number;
  // In-progress count digits as typed (e.g. "2", "23"), before being applied as
  // a numeric [repeat]. This is the canonical count buffer shared between the
  // legacy dispatcher and the typed framework during the normal-mode migration.
  countText: string;
  register: RegisterName | undefined;
  operatorDepth: number;
  whenEvaluator: WhenEvaluator;
  // Whether the current key is allowed to trigger user remaps (the per-key
  // "remappable" flag of remap typeahead, à la Vim's :noremap). This is a
  // dispatch-scoped flag (like [whenEvaluator]) rather than long-lived parser
  // state: the executor sets it per [handle] call and per re-dispatched emitted
  // key so non-recursive remap expansions don't remap their own output. It is
  // produced and consumed entirely within remap.ts (see [remapHandler]).
  allowRemap: boolean;
  remapKeys: readonly string[];
  editor?: VimEditorCapabilities;
  registers?: Registers;
};

export const initialHandlerState: HandlerState = {
  mode: "normal",
  repeat: 1,
  countText: "",
  register: undefined,
  operatorDepth: 0,
  whenEvaluator: () => true,
  allowRemap: true,
  remapKeys: [],
};

export function cloneHandlerState(state: HandlerState): HandlerState {
  return { ...state };
}

export type KeyToDispatch = {
  key: string;
  allowRemap: boolean;
};

export type QueuedRunResult<T> = T | Promise<T>;

export type EffectAction<T> = { type: "effect"; mode: VimMode; run: () => QueuedRunResult<T> };

type VoidKeyAction =
  | { type: "keys"; mode: VimMode; keys: readonly KeyToDispatch[] }
  | { type: "commands"; mode: VimMode; commands: readonly VimCommandMapping[] }
  | { type: "sequence"; mode: VimMode; actions: readonly KeyAction<void>[] };

export type KeyAction<T> = EffectAction<T> | (T extends void ? VoidKeyAction : never);

export type Handler<T> = (key: string, state: HandlerState) => HandleResult<T>;

export type HandlerEnv<T> = {
  handler: Handler<T>;
  state: HandlerState;
};

export type HandleResult<T> =
  | { type: "run"; action: KeyAction<T> }
  | { type: "handler"; handlerEnvs: readonly HandlerEnv<T>[] }
  | { type: "conflict"; accepted: KeyAction<T>; pending: readonly HandlerEnv<T>[] }
  | { type: "unhandled" }
  | { type: "invalid" };

export function mapHandler<T, U>(
  underlying: Handler<T>,
  f: (value: T, state: HandlerState) => QueuedRunResult<U>
): Handler<U> {
  return (key, state) => {
    const mapAction = (action: KeyAction<T>): KeyAction<U> => {
      if (action.type !== "effect") {
        throw new Error("mapHandler expects effect actions");
      }
      return {
        type: "effect",
        mode: action.mode,
        // Preserve synchronicity: only return a promise when the underlying run
        // is itself async. Forcing this async would defer otherwise-synchronous
        // editor effects to a microtask, which synchronous callers would miss.
        run: () => {
          const inner = action.run();
          return isPromiseLike(inner)
            ? Promise.resolve(inner).then(value => f(value, state))
            : f(inner, state);
        },
      };
    };

    const result = underlying(key, state);
    switch (result.type) {
      case "run":
        return { type: "run", action: mapAction(result.action) };
      case "handler":
        return { type: "handler", handlerEnvs: result.handlerEnvs.map(env => mapHandlerEnv(env, f)) };
      case "conflict":
        return {
          type: "conflict",
          accepted: mapAction(result.accepted),
          pending: result.pending.map(env => mapHandlerEnv(env, f)),
        };
      case "unhandled":
        return { type: "unhandled" };
      case "invalid":
        return { type: "invalid" };
    }
  };
}

function mapHandlerEnv<T, U>(
  env: HandlerEnv<T>,
  f: (value: T, state: HandlerState) => QueuedRunResult<U>
): HandlerEnv<U> {
  return { handler: mapHandler(env.handler, f), state: env.state };
}

export function combineHandleResults<T>(results: readonly HandleResult<T>[]): HandleResult<T> {
  let accepted: KeyAction<T> | undefined;
  let invalidResult: Extract<HandleResult<T>, { type: "invalid" }> | undefined;
  const pending: HandlerEnv<T>[] = [];

  for (const result of results) {
    switch (result.type) {
      case "unhandled":
        break;
      case "invalid":
        if (accepted === undefined && pending.length === 0 && invalidResult === undefined) {
          invalidResult = result;
        }
        break;
      case "run":
        if (accepted === undefined) accepted = result.action;
        break;
      case "handler":
        pending.push(...result.handlerEnvs);
        break;
      case "conflict":
        if (accepted === undefined) accepted = result.accepted;
        pending.push(...result.pending);
        break;
    }
  }

  if (accepted !== undefined && pending.length > 0) {
    return { type: "conflict", accepted, pending };
  }
  if (accepted !== undefined) return { type: "run", action: accepted };
  if (pending.length > 0) return { type: "handler", handlerEnvs: pending };
  return invalidResult ?? { type: "unhandled" };
}

export function run<T>(action: KeyAction<T>): HandleResult<T> {
  return { type: "run", action };
}

export function effect<T>(mode: VimMode, run: () => QueuedRunResult<T>): HandleResult<T> {
  return { type: "run", action: { type: "effect", mode, run } };
}

export function handler<T>(handlerEnvs: readonly HandlerEnv<T>[]): HandleResult<T> {
  return { type: "handler", handlerEnvs };
}

export function prefixedHandler<T>(
  prefix: string,
  next: Handler<T>,
  increaseDepth = true
): Handler<T> {
  return (key, state) => {
    if (key !== prefix) return unhandled();
    return handler([
      {
        handler: next,
        state: {
          ...cloneHandlerState(state),
          operatorDepth: increaseDepth ? state.operatorDepth + 1 : state.operatorDepth,
        },
      },
    ]);
  };
}

export function unhandled<T>(): HandleResult<T> {
  return { type: "unhandled" };
}

export function invalid<T>(): HandleResult<T> {
  return { type: "invalid" };
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as PromiseLike<T>).then === "function"
  );
}
