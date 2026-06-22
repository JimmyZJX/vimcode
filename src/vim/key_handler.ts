import type { VimConfiguration } from "./config.js";
import type { VimEditorCapabilities } from "./editor.js";
import type { RegisterName, Registers } from "./registers.js";
import type { VimMode } from "./state.js";

export type HandlerMode = VimMode;

export type HandlerState = {
  repeat: number;
  register: RegisterName | undefined;
  operatorDepth: number;
};

export const initialHandlerState: HandlerState = {
  repeat: 1,
  register: undefined,
  operatorDepth: 0,
};

export type HandlerContext = {
  editor: VimEditorCapabilities;
  registers: Registers;
  configuration: VimConfiguration;
};

export type QueuedRun<T, Context = HandlerContext> = {
  mode: HandlerMode;
  run: (context: Context) => Promise<T>;
};

export type HandlerEnv<T, Context = HandlerContext> = {
  handler: Handler<T, Context>;
  state: HandlerState;
};

export type HandleResult<T, Context = HandlerContext> =
  | { type: "run"; run: QueuedRun<T, Context> }
  | { type: "handler"; handlerEnv: HandlerEnv<T, Context> }
  | { type: "conflict"; accepted: QueuedRun<T, Context>; pending: HandlerEnv<T, Context>; replayKeys: readonly string[] }
  | { type: "unhandled" }
  | { type: "invalid"; replayKeys?: readonly string[] };

export interface Handler<T, Context = HandlerContext> {
  readonly mode: HandlerMode;
  handle(key: string, state: HandlerState, context: Context): HandleResult<T, Context>;
}

export class CombinedHandler<T, Context = HandlerContext> implements Handler<T, Context> {
  constructor(
    readonly mode: HandlerMode,
    private readonly branches: readonly HandlerEnv<T, Context>[]
  ) {}

  handle(key: string, _state: HandlerState, context: Context): HandleResult<T, Context> {
    let accepted: QueuedRun<T, Context> | undefined;
    let invalidResult: Extract<HandleResult<T, Context>, { type: "invalid" }> | undefined;
    const pending: HandlerEnv<T, Context>[] = [];

    for (const branch of this.branches) {
      const result = branch.handler.handle(key, branch.state, context);
      switch (result.type) {
        case "unhandled":
          break;
        case "invalid":
          if (accepted === undefined && pending.length === 0 && invalidResult === undefined) {
            invalidResult = result;
          }
          break;
        case "run":
          if (accepted === undefined) accepted = result.run;
          break;
        case "handler":
          pending.push(result.handlerEnv);
          break;
        case "conflict":
          if (accepted === undefined) accepted = result.accepted;
          pending.push(result.pending);
          break;
      }
    }

    if (accepted !== undefined && pending.length > 0) {
      return {
        type: "conflict",
        accepted,
        pending: combinedHandlerEnv(this.mode, pending),
        replayKeys: [],
      };
    }
    if (accepted !== undefined) return { type: "run", run: accepted };
    if (pending.length === 1) return { type: "handler", handlerEnv: pending[0] };
    if (pending.length > 1) return { type: "handler", handlerEnv: combinedHandlerEnv(this.mode, pending) };
    return invalidResult ?? { type: "unhandled" };
  }
}

export function combinedHandlerEnv<T, Context = HandlerContext>(
  mode: HandlerMode,
  branches: readonly HandlerEnv<T, Context>[]
): HandlerEnv<T, Context> {
  return {
    handler: new CombinedHandler(mode, branches),
    state: initialHandlerState,
  };
}

export function run<T, Context = HandlerContext>(run: QueuedRun<T, Context>): HandleResult<T, Context> {
  return { type: "run", run };
}

export function handler<T, Context = HandlerContext>(handlerEnv: HandlerEnv<T, Context>): HandleResult<T, Context> {
  return { type: "handler", handlerEnv };
}

export function unhandled<T, Context = HandlerContext>(): HandleResult<T, Context> {
  return { type: "unhandled" };
}

export function invalid<T, Context = HandlerContext>(replayKeys?: readonly string[]): HandleResult<T, Context> {
  return replayKeys === undefined ? { type: "invalid" } : { type: "invalid", replayKeys };
}
