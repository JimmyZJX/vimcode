import type { VimCommandMapping, WhenEvaluator } from "./config.js";
import type { VimEditorCapabilities } from "./editor.js";
import type { RegisterName } from "./registers.js";
import type { VimMode } from "./state.js";

export type HandlerState = {
  mode: VimMode;
  // TODO: Move this into a typed count/repeat handler once counts no longer
  // live in Vim's shared environment. It stays here for now to preserve the
  // existing leading-zero and status-display behavior during migration.
  repeat: number;
  register: RegisterName | undefined;
  operatorDepth: number;
  whenEvaluator: WhenEvaluator;
  remapKeys: readonly string[];
  editor?: VimEditorCapabilities;
};

export const initialHandlerState: HandlerState = {
  mode: "normal",
  repeat: 1,
  register: undefined,
  operatorDepth: 0,
  whenEvaluator: () => true,
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

type VoidKeyAction =
  | { type: "keys"; mode: VimMode; keys: readonly KeyToDispatch[] }
  | { type: "commands"; mode: VimMode; commands: readonly VimCommandMapping[] }
  | { type: "sequence"; mode: VimMode; actions: readonly KeyAction<void>[] };

export type KeyAction<T> =
  | { type: "value"; mode: VimMode; value: T }
  | { type: "effect"; mode: VimMode; run: () => QueuedRunResult<T> }
  | (T extends void ? VoidKeyAction : never);

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

export function value<T>(mode: VimMode, value: T): HandleResult<T> {
  return { type: "run", action: { type: "value", mode, value } };
}

export function handler<T>(handlerEnvs: readonly HandlerEnv<T>[]): HandleResult<T> {
  return { type: "handler", handlerEnvs };
}

export function unhandled<T>(): HandleResult<T> {
  return { type: "unhandled" };
}

export function invalid<T>(): HandleResult<T> {
  return { type: "invalid" };
}
