// Zed reference:
// - source: crates/vim/src/... (Zed has no direct easyMotion; this mirrors the
//   VSCodeVim leader-triggered easyMotion overlay, ported onto the typed
//   framework)
// - translated concept: easyMotion as an *in-graph* interactive overlay. The
//   leader key starts a pending continuation (like the `d/` search operand); each
//   subsequent key advances the shared [EasyMotionState] and either keeps waiting
//   (repainting the marker overlay) or completes with a jump / cancel.
//
// The handler body stays pure: [EasyMotionState.decide] computes the outcome
// without mutating, and the state advance + marker repaint ([commit]) are
// deferred into the pending continuation's [PendingEffect] (stay-pending) or the
// completing [effect] (jump/clear). Every result is transparent to dot-repeat
// ([preservesDotRepeat]): easyMotion is a navigation overlay and must neither
// enter nor cancel the `.` register, exactly like the legacy dispatcher (which
// recorded the keys for macros but never committed them to dot-repeat).

import type { HandleResult, HandlerState } from "./key_handler.js";
import {
  cloneHandlerState,
  effect,
  handler,
  isEscapeKey,
  unhandled,
} from "./key_handler.js";

// Drive the easyMotion overlay for one key. Claims the leader key (from a clean
// normal/visual context, gated by the owner's root handler) to start the overlay,
// and every key while it is pending. Declines escape (the owner's escape handling
// cancels the overlay) and any key easyMotion does not recognize while idle.
export function easyMotionHandler(key: string, state: HandlerState): HandleResult<void> {
  const easyMotion = state.easyMotion;
  const editor = state.editor;
  const configuration = state.configuration;
  if (easyMotion === undefined || editor === undefined || configuration === undefined) {
    return unhandled();
  }
  // Escape is not an easyMotion key: decline so the owner's escape handling
  // cancels the overlay (clearing markers + pending). Matches the legacy
  // dispatcher, where escape was intercepted before easyMotion saw it.
  if (isEscapeKey(key)) return unhandled();

  const outcome = easyMotion.decide(editor, configuration, key);
  if (outcome === undefined) return unhandled();

  switch (outcome.type) {
    case "pending":
      // Advance the overlay (mutate pending + repaint markers) as a deferred
      // effect and keep waiting for the next key. The body stays pure.
      return handler(
        [{ handler: easyMotionHandler, state: cloneHandlerState(state) }],
        { effect: { run: () => easyMotion.commit(editor, outcome) }, preservesDotRepeat: true }
      );
    case "clear":
      // End the overlay without moving (invalid trigger / no match / empty input).
      return effect(state.mode, () => easyMotion.commit(editor, outcome), {
        preservesDotRepeat: true,
      });
    case "jump":
      // End the overlay and jump: clear the markers, then apply the motion (a
      // cursor move in normal mode, a selection extension in visual mode).
      return effect(
        state.mode,
        () => {
          easyMotion.commit(editor, outcome);
          state.applyEasyMotionJump?.(outcome.position);
        },
        { preservesDotRepeat: true }
      );
  }
}
