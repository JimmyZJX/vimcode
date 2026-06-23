import {
  Handler,
  HandlerEnv,
  HandlerState,
  cloneHandlerState,
  handler,
  invalid,
} from "./key_handler.js";
import { parseRegisterName } from "./registers.js";

export function prefixHandler<T>(underlying: Handler<T>, countText = ""): Handler<T> {
  return (key, state) => {
    if (/^\d$/.test(key) && (key !== "0" || countText.length > 0)) {
      const nextCountText = `${countText}${key}`;
      return handler([{ handler: prefixHandler(underlying, nextCountText), state: cloneHandlerState(state) }]);
    }

    if (key === '"' && state.register === undefined) {
      return handler([waitingForRegisterEnv(underlying, state, countText)]);
    }

    return underlying(key, stateWithAppliedCount(state, countText));
  };
}

function waitingForRegisterEnv<T>(
  underlying: Handler<T>,
  state: HandlerState,
  countText: string
): HandlerEnv<T> {
  return {
    handler: (key, registerState) => {
      const register = parseRegisterName(key);
      if (register === undefined) return invalid();
      return handler([
        {
          handler: prefixHandler(underlying, countText),
          state: { ...cloneHandlerState(registerState), register },
        },
      ]);
    },
    state: cloneHandlerState(state),
  };
}

function stateWithAppliedCount(state: HandlerState, countText: string): HandlerState {
  if (countText.length === 0) return state;
  return {
    ...cloneHandlerState(state),
    repeat: state.repeat * Number(countText),
  };
}
