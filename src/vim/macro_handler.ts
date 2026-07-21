// Zed reference:
// - source: crates/vim/src/normal.rs (`q`/`@`/`Q`) and the record/replay register
//   waiting inputs
// - translated concept: named macros modeled over the shared [MacroState] as
//   normal-mode framework handlers. `q{reg}…q` records; `@{reg}` (and `@@`) and
//   `Q` replay by feeding the recorded keys back through the dispatcher.
//
// A macro is just a recorded key sequence ([MacroState] holds `register -> keys`
// plus the active recording register and a `replaying` flag). Recording appends
// each key; the register-name waiter and the closing `q` start/stop it. Replay is
// *requested* (via [requestMacroReplay]) rather than run here: the owner replays
// it outside the executor's effect drain, so each fed-back key fully applies
// before the next (a replay through insert mode mixes deferred framework effects
// with immediate insert text). All the macro-control keys are transparent to
// dot-repeat ([preservesDotRepeat]): they must not enter the dot register, and
// `@`/`Q` must leave the dot-repeat their replayed keys set intact.

import {
  HandleResult,
  Handler,
  HandlerState,
  cloneHandlerState,
  effect,
  handler,
  invalid,
  isEscapeKey,
  unhandled,
} from "./key_handler.js";
import { parseRegisterName } from "./registers.js";

// `q` (record toggle), `@`/`@@` (replay register), `Q` (replay last).
export function macroControlHandler(key: string, state: HandlerState): HandleResult<void> {
  const macro = state.macro;
  if (macro === undefined) return unhandled();

  if (key === "q") {
    if (macro.isRecording()) {
      return effect("normal", () => {
        const recorded = macro.stopRecording();
        if (recorded === undefined) return;
        // Vim keeps macros in the registers: `q` writes the recorded keys, so
        // `qaq` leaves an *existing* empty register a (the classic clear
        // before `:g/pat/y A`) and `"ap` pastes the keys. Multi-character key
        // names use `<>` notation, an approximation of Vim's raw termcodes.
        const name = parseRegisterName(recorded.register);
        if (name !== undefined) {
          state.registers?.write(name, macroKeysText(recorded.keys), "characterwise");
        }
      }, { preservesDotRepeat: true });
    }
    // Not recording: wait for the register name to record into.
    return handler([{ handler: recordRegisterWaiter, state: deeper(state) }], { preservesDotRepeat: true });
  }

  if (key === "@") {
    const count = state.repeat;
    return handler([{ handler: replayRegisterWaiter(count), state: deeper(state) }], { preservesDotRepeat: true });
  }

  if (key === "Q") {
    const count = state.repeat;
    return effect("normal", () => state.requestMacroReplay?.(undefined, count), { preservesDotRepeat: true });
  }

  return unhandled();
}

function macroKeysText(keys: readonly { key: string }[]): string {
  return keys
    .map(({ key }) => (key === "space" ? " " : key.length === 1 ? key : `<${key}>`))
    .join("");
}

// The register name after `q`: start recording into it. Escape cancels.
function recordRegisterWaiter(key: string, state: HandlerState): HandleResult<void> {
  if (isEscapeKey(key)) return invalid();
  return effect("normal", () => state.macro?.startRecording(key), { preservesDotRepeat: true });
}

// The register name after `@` (or `@` again for `@@`): request replaying it
// [count] times. Escape cancels.
function replayRegisterWaiter(count: number): Handler<void> {
  return (key, state) => {
    if (isEscapeKey(key)) return invalid();
    return effect("normal", () => state.requestMacroReplay?.(key, count), { preservesDotRepeat: true });
  };
}

// A macro-control chord key claims one operator-depth level (like the count/
// register prefix and the find/replace char waiters), so a pending `q`/`@`
// surfaces in the status.
function deeper(state: HandlerState): HandlerState {
  return { ...cloneHandlerState(state), operatorDepth: state.operatorDepth + 1 };
}
