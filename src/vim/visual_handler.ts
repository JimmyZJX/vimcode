// Zed reference:
// - source: the `visual` module + the visual bindings in assets/keymaps/vim.json
// - translated concepts: the visual-mode key grammar as a typed handler graph.
//   The selection geometry and edits stay in [VisualMode] (injected into the
//   handler state like [marks]/[search]); this module is the pure dispatch that
//   decides which key drives which [VisualMode] operation, and what mode each
//   leaves us in.

import { combineHandleResults, effect, invalid, unhandled } from "./key_handler.js";
import type { Handler, HandleResult, HandlerState } from "./key_handler.js";
import type { VisualCommand, VisualModeKind } from "./keymap.js";
import { resolveMotion } from "./normal_mode_handler.js";
import { prefixHandler } from "./prefix_handlers.js";
import type { VimMode } from "./state.js";

// The full visual-mode grammar: the count/register prefix wrapping the raw
// grammar. Operators and the remaining visual commands fall through to the
// legacy dispatcher for now (migrated in later slices); a key the framework
// declines is handled by [Vim] (eventually: quit visual + run the normal
// binding).
export function visualModeHandler(): Handler<void> {
  return prefixHandler(rawVisualModeHandler());
}

function rawVisualModeHandler(): Handler<void> {
  return (key, state) =>
    combineHandleResults([
      visualToggleHandler(key, state),
      visualOperatorHandler(key, state),
      visualChangeHandler(key, state),
      visualMotionHandler(key, state),
    ]);
}

// Visual change: `c`/`s` change the selection (charwise/linewise/blockwise),
// `R` changes the highlighted lines (`changeLines`). Like the operators it
// reuses [VisualMode.handleCommand], but it deletes the selection and enters
// insert (static target `insert`); the owner's mode transition
// ([enterModeFromExecutor]) starts the insert session with the visual origin so
// a blockwise change collapses cursors and replicates the typed text on escape.
// Visual-change dot-repeat is deferred: the inserted text is unknown until
// insert exits, so [changeKey] returns a [pendingRepeatChange] selection that is
// stashed on [repeatState] here and combined with the inserted text on
// insert-exit (Vim's `finishInsertOrReplaceSession`). Key-based dot-repeat
// recording is off in visual context, so this declares `dotRepeatable: false`.
function visualChangeHandler(key: string, state: HandlerState): HandleResult<void> {
  const command = visualChangeCommandForKey(key);
  if (command === undefined) return unhandled();
  const visual = state.visual;
  if (visual === undefined) return invalid();
  const repeatState = state.repeatState;
  return effect(
    "insert",
    () => {
      const result = visual.handleCommand(command, state.register);
      if (result.pendingRepeatChange !== undefined && repeatState !== undefined && !repeatState.isReplaying()) {
        repeatState.setPendingVisualChange(result.pendingRepeatChange.selection);
      }
    },
    { dotRepeatable: false }
  );
}

function visualChangeCommandForKey(key: string): VisualCommand | undefined {
  switch (key) {
    case "c":
    case "s":
      return { type: "change" };
    case "R":
      // Vim `v_R`: the change always operates on whole lines.
      return { type: "changeLines" };
    default:
      return undefined;
  }
}

// Visual operators that act on the selection and return to normal mode:
// `d`/`x` (delete), `D` (delete to line end), `y`/`Y` (yank/linewise),
// `u`/`U`/`~` (convert case), `>`/`<`/`=` (indent). The edit + selection cleanup
// reuse [VisualMode.handleCommand]; the static target mode is normal. Visual
// dot-repeat is the same-size [repeatAction] recorded here (not key-replay), so
// these declare `dotRepeatable: false` (the framework key-based recording is off
// in visual context anyway). Change (`c`/`s`/`R`) targets insert and is handled
// by [visualChangeHandler].
function visualOperatorHandler(key: string, state: HandlerState): HandleResult<void> {
  const command = visualOperatorCommandForKey(key);
  if (command === undefined) return unhandled();
  const visual = state.visual;
  if (visual === undefined) return invalid();
  const repeatState = state.repeatState;
  return effect(
    "normal",
    () => {
      const result = visual.handleCommand(command, state.register);
      if (result.repeatAction !== undefined && repeatState !== undefined && !repeatState.isReplaying()) {
        repeatState.recordVisualAction(result.repeatAction.selection, result.repeatAction.action);
      }
    },
    { dotRepeatable: false }
  );
}

function visualOperatorCommandForKey(key: string): VisualCommand | undefined {
  switch (key) {
    case "d":
    case "x":
      return { type: "delete" };
    case "D":
      return { type: "deleteToLineEnd" };
    case "y":
      return { type: "yank" };
    case "Y":
      return { type: "yankLinewise" };
    case "u":
      return { type: "convert", key: "u" };
    case "U":
      return { type: "convert", key: "U" };
    case "~":
      return { type: "convert", key: "~" };
    case ">":
      return { type: "indent", key: ">" };
    case "<":
      return { type: "indent", key: "<" };
    case "=":
      return { type: "indent", key: "=" };
    default:
      return undefined;
  }
}

// `v`/`V`/`ctrl-v` within visual mode: toggle the visual kind, or exit to normal
// when the key matches the current kind (`v` in charwise-visual exits). The
// target mode is computed from the current kind so the executor's mode
// transition matches [VisualMode.toggleMode]'s state change.
function visualToggleHandler(key: string, state: HandlerState): HandleResult<void> {
  const kind = visualKindForToggleKey(key);
  if (kind === undefined) return unhandled();
  const visual = state.visual;
  if (visual === undefined) return invalid();
  const target: VimMode = visual.currentMode() === kind ? "normal" : kind;
  return effect(
    target,
    () => {
      visual.toggleMode(kind);
    },
    { dotRepeatable: false }
  );
}

// Cursor motions in visual mode extend the live selection (anchor fixed, head
// moves) rather than moving a single cursor. The motion resolution is shared
// with normal mode ([resolveMotion]); [VisualMode.applyMotion] does the
// selection extension. Motions the shared resolver does not cover (find,
// `g`-chords, line targets) fall through to the legacy dispatcher for now.
function visualMotionHandler(key: string, state: HandlerState): HandleResult<void> {
  const visual = state.visual;
  if (visual === undefined) return unhandled();
  // `%` is a visual command (`percentOrMatching`), not a plain motion; leave it
  // (and other not-yet-migrated commands) to the legacy dispatcher.
  if (key === "%") return unhandled();
  const motion = resolveMotion(key, state);
  if (motion === undefined) return unhandled();
  const count = state.repeat;
  return effect(state.mode, () => visual.applyMotion(motion, count), { dotRepeatable: false });
}

function visualKindForToggleKey(key: string): VisualModeKind | undefined {
  switch (key) {
    case "v":
      return "visual";
    case "V":
      return "visualLine";
    case "ctrl-v":
      return "visualBlock";
    default:
      return undefined;
  }
}
