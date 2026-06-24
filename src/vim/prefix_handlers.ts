import {
  Handler,
  HandlerEnv,
  HandlerState,
  cloneHandlerState,
  handler,
  invalid,
} from "./key_handler.js";
import { parseRegisterName } from "./registers.js";

// Count/register prefix transformer. It accumulates the in-progress count in
// the env's [HandlerState.countText] (so it is observable on the active handler
// env, e.g. for status and for mirroring to the legacy dispatcher) and the
// selected register in [HandlerState.register]. On the first non-prefix key it
// applies the count to [repeat], clears [countText], and delegates to
// [underlying].
export function prefixHandler<T>(underlying: Handler<T>): Handler<T> {
  return (key, state) => {
    if (/^\d$/.test(key) && (key !== "0" || state.countText.length > 0)) {
      const startingCount = state.countText.length === 0;
      return handler([
        {
          handler: prefixHandler(underlying),
          state: {
            ...cloneHandlerState(state),
            countText: `${state.countText}${key}`,
            operatorDepth: startingCount ? state.operatorDepth + 1 : state.operatorDepth,
          },
        },
      ]);
    }

    if (key === '"' && state.register === undefined) {
      return handler([waitingForRegisterEnv(underlying, incrementOperatorDepth(state))]);
    }

    return underlying(key, stateWithAppliedCount(state));
  };
}

function waitingForRegisterEnv<T>(underlying: Handler<T>, state: HandlerState): HandlerEnv<T> {
  return {
    handler: (key, registerState) => {
      const register = parseRegisterName(key);
      if (register === undefined) return invalid();
      return handler([
        {
          handler: prefixHandler(underlying),
          state: { ...cloneHandlerState(registerState), register },
        },
      ]);
    },
    state: cloneHandlerState(state),
  };
}

function stateWithAppliedCount(state: HandlerState): HandlerState {
  if (state.countText.length === 0) return state;
  return {
    ...cloneHandlerState(state),
    repeat: state.repeat * Number(state.countText),
    countText: "",
  };
}

function incrementOperatorDepth(state: HandlerState): HandlerState {
  return {
    ...cloneHandlerState(state),
    operatorDepth: state.operatorDepth + 1,
  };
}
