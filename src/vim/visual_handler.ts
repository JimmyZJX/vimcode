// Zed reference:
// - source: the `visual` module + the visual bindings in assets/keymaps/vim.json
// - translated concepts: the visual-mode key grammar as a typed handler graph.
//   The selection geometry and edits stay in [VisualMode] (injected into the
//   handler state like [marks]/[search]); this module is the pure dispatch that
//   decides which key drives which [VisualMode] operation. The resulting mode is
//   read back from the [VisualKeyResult]/[VisualMode] after the effect runs
//   (a dynamic target mode) rather than predicted per key.

import { cloneHandlerState, combineHandleResults, dynamicModeEffect, effect, handler, invalid, isEscapeKey, unhandled } from "./key_handler.js";
import type { Handler, HandleResult, HandlerState } from "./key_handler.js";
import type { RepeatState } from "./normal/repeat.js";
import type { RegisterName } from "./registers.js";
import { bracketChordHandler, ctrlWHandler, nativeKeyHandler, pageHandler, scrollHandler, zChordHandler } from "./finite_chord_handlers.js";
import type { FindApplier } from "./normal_mode_handler.js";
import { configuredTextwidth, convertTargetForKey, digraphWaiter, editorGChordHandler, findHandler, gChordMotion, keyForInput, lineMotionForKey, repeatFindHandler, resolveMotion, restoreVisualSelectionHandler } from "./normal_mode_handler.js";
import { prefixHandler } from "./prefix_handlers.js";
import { commandPromptHandler } from "./command_handler.js";
import { reportSearchMotionStatus, searchPromptHandler, searchSelectionHandler, visualSearchUnderCursorHandler } from "./search_handler.js";
import type { VimMode } from "./state.js";
import type { VisualKeyResult, VisualMode, VisualCommand, VisualModeKind, VisualSessionEnd } from "./visual.js";

// The full visual-mode grammar: the count/register prefix wrapping the raw
// grammar. Keys the framework declines fall through to the legacy dispatcher
// during migration; once the grammar is complete a declined key will quit visual
// and run the normal-mode binding.
export function visualModeHandler(): Handler<void> {
  return prefixHandler(rawVisualModeHandler());
}

function rawVisualModeHandler(): Handler<void> {
  return (key, state) =>
    combineHandleResults([
      visualToggleHandler(key, state),
      visualCommandHandler(key, state),
      visualPercentHandler(key, state),
      visualTextObjectHandler(key, state),
      visualSurroundHandler(key, state),
      visualReplaceHandler(key, state),
      visualGChordHandler(key, state),
      visualSimpleHandler(key, state),
      findHandler(key, state, visualFindApplier),
      repeatFindHandler(key, state, visualFindApplier),
      visualSearchNavHandler(key, state),
      visualSearchUnderCursorHandler(key, state),
      visualLineMotionHandler(key, state),
      searchPromptHandler(key, state),
      commandPromptHandler(key, state),
      zChordHandler(key, state),
      ctrlWHandler(key, state),
      bracketChordHandler(key, state),
      nativeKeyHandler(key, state),
      pageHandler(key, state),
      scrollHandler(key, state),
      visualMotionHandler(key, state),
    ]);
}

// Run a [VisualMode] operation and let its [VisualKeyResult] drive both the
// dot-repeat recording and the target mode. The target mode is dynamic: it is
// derived from the result (and the post-run [VisualMode] kind) after the effect
// runs, so commands whose outcome depends on the selection (a text object that
// becomes linewise, an `I`/`A` that only enters insert in some configs, a toggle
// that exits) all transition correctly without per-key prediction. Visual
// commands are never key-based dot-repeatable (`.` reapplies a same-shape
// selection via [RepeatState]), so `dotRepeatable` defaults false.
function visualResultEffect(
  state: HandlerState,
  run: (visual: VisualMode) => VisualKeyResult,
  {
    dotRepeatable = false,
    registerToRead,
  }: {
    dotRepeatable?: boolean;
    registerToRead?: { registerName: RegisterName | undefined };
  } = {}
): HandleResult<void> {
  const visual = state.visual;
  if (visual === undefined) return invalid();
  const repeatState = state.repeatState;
  let target: VimMode = state.mode;
  return dynamicModeEffect(
    state.mode,
    () => {
      const result = run(visual);
      recordVisualRepeat(result, repeatState);
      target = visualResultMode(result, state.mode, visual);
    },
    () => target,
    { dotRepeatable, registerToRead }
  );
}

// Record the dot-repeat consequence of a visual command. Operators/deletes/
// indents carry a same-size [repeatAction] (replayed directly, not as keys);
// changes carry a [pendingRepeatChange] whose inserted text is only known on
// insert-exit, so it is stashed for [finishInsertOrReplaceSession] to finalize.
function recordVisualRepeat(result: VisualKeyResult, repeatState: RepeatState | undefined): void {
  if (repeatState === undefined || repeatState.isReplaying()) return;
  if (result.repeatAction !== undefined) {
    repeatState.recordVisualAction(result.repeatAction.selection, result.repeatAction.action);
  }
  if (result.pendingRepeatChange !== undefined) {
    repeatState.setPendingVisualChange(result.pendingRepeatChange.selection);
  }
}

// Map a [VisualKeyResult] to the Vim mode to transition to. Entering insert and
// an explicit `nextMode` win; an exit goes to normal; otherwise the command
// stayed in visual mode and [VisualMode.currentMode] is the source of truth for
// the (possibly changed) visual kind.
function visualResultMode(result: VisualKeyResult, currentMode: VimMode, visual: VisualMode): VimMode {
  if (result.enterInsert) return "insert";
  if (result.nextMode !== undefined) return result.nextMode;
  if (result.exitVisual) return "normal";
  return visual.currentMode() ?? currentMode;
}

// Single-key visual commands dispatched through [VisualMode.handleCommand]:
// operators `d`/`x`/`D`/`y`/`Y`, convert `u`/`U`/`~`, indent `>`/`<`/`=`, change
// `c`/`s`/`R`, swap-ends `o`/`O`, paste `p`/`P`, and selection-insert `I`/`A`
// (block insert / VSCodeVim-style multiline insert). The dynamic target mode
// means `I`/`A` enter insert only when the command actually does (otherwise it
// stays visual). The register selection (`"a`/`"_`) is threaded via
// [handleCommand]'s `registerOverride` (the framework register lives in the
// executor, not the legacy `registerSelection`).
function visualCommandHandler(key: string, state: HandlerState): HandleResult<void> {
  const command = visualCommandForKey(key);
  if (command === undefined) return unhandled();
  if (state.visual === undefined) return invalid();
  return visualResultEffect(
    state,
    visual => visual.handleCommand(command, state.register),
    { registerToRead: command.type === "paste" ? { registerName: state.register } : undefined }
  );
}

function visualCommandForKey(key: string): VisualCommand | undefined {
  switch (key) {
    case "d":
    case "x":
      return { type: "delete" };
    case "D":
      return { type: "deleteToLineEnd" };
    case "y":
    case "ctrl-c":
      // Vim `v_CTRL-C` yanks the selection like `y` (Vim owns the key in visual
      // mode via [Vim.keyOwnership] so VSCode does not intercept it).
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
    case "c":
    case "s":
      return { type: "change" };
    case "R":
      // Vim `v_R`: the change always operates on whole lines.
      return { type: "changeLines" };
    case "o":
      return { type: "otherEnd", rowAware: true };
    case "O":
      return { type: "otherEnd", rowAware: false };
    case "p":
    case "P":
      return { type: "paste", preserveSourceRegister: key === "P" };
    case "I":
      return { type: "insertAtSelection", side: "start" };
    case "A":
      return { type: "insertAtSelection", side: "end" };
    default:
      return undefined;
  }
}

// Visual text objects: `i`/`a` start a two-key chord whose second key names the
// object (`viw`, `va(`). Unlike the legacy path this uses a pure continuation
// (no operator stack): [around] (`i` vs `a`) and the count ride in the captured
// handler state, and [VisualMode.applyTextObject] expands the live selection.
// The result mode is dynamic — a paragraph object becomes visualLine, others
// stay charwise/blockwise — so it flows through [visualResultEffect].
function visualTextObjectHandler(key: string, state: HandlerState): HandleResult<void> {
  const around = textObjectAroundForKey(key);
  if (around === undefined) return unhandled();
  if (state.visual === undefined) return invalid();
  return handler([{ handler: visualTextObjectContinuation(around), state: visualDeeper(state) }]);
}

function visualTextObjectContinuation(around: boolean): Handler<void> {
  return (key, state) => {
    if (state.visual === undefined) return invalid();
    return visualResultEffect(state, visual => visual.applyTextObject(around, key, state.repeat));
  };
}

function textObjectAroundForKey(key: string): boolean | undefined {
  switch (key) {
    case "i":
      return false;
    case "a":
      return true;
    default:
      return undefined;
  }
}

// Visual surround: `S` starts a two-key chord whose second key is the pair to
// wrap the selection with (vim-surround `S)`, `S{`, …). Pure continuation (no
// operator stack); [VisualMode.addSurround] reads the live selection and exits
// to normal.
function visualSurroundHandler(key: string, state: HandlerState): HandleResult<void> {
  if (key !== "S") return unhandled();
  if (state.visual === undefined) return invalid();
  return handler([{ handler: visualSurroundContinuation, state: visualDeeper(state) }]);
}

function visualSurroundContinuation(key: string, state: HandlerState): HandleResult<void> {
  if (state.visual === undefined) return invalid();
  // `St`/`S<`: tag entry mode — collect the tag body until `>`/enter.
  if (key === "t" || key === "<") {
    return visualTagEntry(state, "");
  }
  return visualResultEffect(state, visual => visual.addSurround(key));
}

function visualTagEntry(state: HandlerState, collected: string): HandleResult<void> {
  return handler([
    {
      handler: (key, entryState) => {
        if (entryState.visual === undefined) return invalid();
        if (isEscapeKey(key)) return invalid();
        if (key === ">" || key === "enter") {
          const tagBody = collected;
          return visualResultEffect(entryState, visual => visual.addTagSurround(tagBody));
        }
        if (key === "backspace") return visualTagEntry(entryState, collected.slice(0, -1));
        const char = keyForInput(key);
        if (char.length !== 1) return invalid();
        return visualTagEntry(entryState, collected + char);
      },
      state: visualDeeper(state),
    },
  ]);
}

// Visual `r{char}`: replace every character in the selection with the next typed
// char (`v_r`). Like the normal-mode `r` waiter, `ctrl-k` begins a digraph;
// escape cancels the replace and keeps the selection.
function visualReplaceHandler(key: string, state: HandlerState): HandleResult<void> {
  if (key !== "r") return unhandled();
  if (state.visual === undefined) return invalid();
  return handler([{ handler: visualReplaceContinuation, state: visualDeeper(state) }]);
}

function visualReplaceContinuation(key: string, state: HandlerState): HandleResult<void> {
  if (state.visual === undefined) return invalid();
  if (isEscapeKey(key)) return invalid();
  if (key === "ctrl-k") {
    return handler([{ handler: digraphWaiter(visualReplaceWith), state: visualDeeper(state) }]);
  }
  return visualReplaceWith(keyForInput(key), state);
}

function visualReplaceWith(char: string, state: HandlerState): HandleResult<void> {
  return visualResultEffect(state, visual => visual.replaceSelection(char));
}

// A pending visual chord (text object / surround) claims one operator-depth
// level, like the count/register prefix and the normal-mode operand grammar.
function visualDeeper(state: HandlerState): HandlerState {
  return { ...cloneHandlerState(state), operatorDepth: state.operatorDepth + 1 };
}

// `%` in visual mode: count-sensitive like normal mode — go to a percentage of
// the file with a count, otherwise extend a charwise selection to the matching
// bracket. The framework count (`state.repeat` when `hasCount`) is threaded into
// [VisualMode.percentOrMatching], keeping the legacy `percentKey` cursor logic.
function visualPercentHandler(key: string, state: HandlerState): HandleResult<void> {
  if (key !== "%") return unhandled();
  if (state.visual === undefined) return invalid();
  const count = state.hasCount === true ? state.repeat : undefined;
  return visualResultEffect(state, visual => visual.percentOrMatching(count));
}

// `v`/`V`/`ctrl-v` within visual mode: toggle the visual kind, or exit to normal
// when the key matches the current kind (`v` in charwise-visual exits).
// [toggleMode]'s result drives the dynamic target mode.
function visualToggleHandler(key: string, state: HandlerState): HandleResult<void> {
  const kind = visualKindForToggleKey(key);
  if (kind === undefined) return unhandled();
  if (state.visual === undefined) return invalid();
  return visualResultEffect(state, visual => visual.toggleMode(kind));
}

// The `g`-chord prefix in visual mode. The dedicated visual continuation handles
// the chords whose visual semantics differ from normal mode — g-motions extend
// the selection, `gr` replaces it with a register, `gu`/`gU`/`g~`/`g?`
// convert the selection, `gJ` joins it,
// `g ctrl-a`/`g ctrl-x` increment it, `gv` swaps to the last selection, `gn`/`gN`
// extend to a search match — reusing the shared leaf helpers
// ([gChordMotion]/[convertTargetForKey]/[restoreVisualSelectionHandler]/
// [searchSelectionHandler]). The mode-agnostic editor `g`-chords (native
// `gd`/`gh`/…, multicursor `gl`/…, tabs `gt`/`gT`, change list `g;`/`g,`) are
// shared via [editorGChordHandler], which keeps the visual selection.
function visualGChordHandler(key: string, state: HandlerState): HandleResult<void> {
  if (key !== "g") return unhandled();
  if (state.visual === undefined) return invalid();
  return handler([{ handler: visualGContinuation, state: visualDeeper(state) }]);
}

function visualGContinuation(key: string, state: HandlerState): HandleResult<void> {
  const visual = state.visual;
  if (visual === undefined) return invalid();

  // VSCodeVim ReplaceWithRegister: when enabled, visual `gr` replaces the
  // selected character or line range immediately. VSCodeVim does not define it
  // for visual block; when disabled the shared `g r` LSP chord handles the key.
  if (key === "r" && state.configuration?.replaceWithRegister === true) {
    if (state.mode === "visualBlock") return invalid();
    return visualResultEffect(
      state,
      live => live.handleCommand({ type: "replaceWithRegister" }, state.register),
      { registerToRead: { registerName: state.register } }
    );
  }

  // g-motions extend the live selection (`gg`/`gj`/`gk`/`g_`/`gM`/`ge`/`gE`).
  const motion = gChordMotion(key);
  if (motion !== undefined) {
    const count = state.repeat;
    return effect(state.mode, () => visual.applyMotion(motion, count), { dotRepeatable: false });
  }

  // Convert the selection: `gu`/`gU`/`g~`/`g?` then exit to normal.
  const convertTarget = convertTargetForKey(key);
  if (convertTarget !== undefined) {
    return exitVisualEffect(state, live => live.convertSelections(convertTarget));
  }

  // `gq`/`gw`: format the selected lines (`gw` keeps the cursor) and exit to
  // normal.
  if (key === "q" || key === "w") return visualFormat(state, key === "w");

  // `gc`/`gC` (vim-commentary): toggle line comments over the selected rows /
  // a block comment over the exact selection, then exit to normal.
  if (key === "c" || key === "C") {
    return exitVisualEffect(state, visual => visual.commentSelections({ block: key === "C" }));
  }

  // `gJ`: join the selected lines without inserting whitespace.
  if (key === "J") return visualJoin(state, false);

  // `g ctrl-a`/`g ctrl-x`: cumulative increment over the selection.
  if (key === "ctrl-a") return visualIncrement(state, "increment", true);
  if (key === "ctrl-x") return visualIncrement(state, "decrement", true);

  // `gv`: swap to the last visual selection.
  if (key === "v") return restoreVisualSelectionHandler(state);

  // `gn`/`gN`: extend the selection to the next/previous search match.
  if (key === "n" || key === "N") return searchSelectionHandler(state, key === "N");

  // Editor-level `g`-chords shared with normal mode (native `gd`/`gh`/…,
  // multicursor `gl`/…, tabs `gt`/`gT`, change list `g;`/`g,`, `g r`); they keep
  // the visual selection (the leaf effects target the current mode).
  const editorGChord = editorGChordHandler(key, state);
  if (editorGChord !== undefined) return editorGChord;

  // Any other `g`-chord (incl. normal-only `gi`) does nothing in visual; cancel.
  return invalid();
}

// Visual `J` joins the selected lines (with a space); `ctrl-a`/`ctrl-x` increment
// the numbers in the selection (step ±count). All exit to normal.
function visualSimpleHandler(key: string, state: HandlerState): HandleResult<void> {
  switch (key) {
    case "J":
      return visualJoin(state, true);
    case "ctrl-a":
      return visualIncrement(state, "increment", false);
    case "ctrl-x":
      return visualIncrement(state, "decrement", false);
    default:
      return unhandled();
  }
}

// The one way the visual grammar exits to normal with an edit outside the
// [VisualCommand] funnel: the command body must return the [VisualSessionEnd]
// proof, which only VisualMode's session-ending methods produce. A new command
// written through this helper cannot compile without the visual-session
// teardown (the runtime invariant in [Vim.assertModeStateInvariants] backstops
// any path that bypasses it).
function exitVisualEffect(state: HandlerState, run: (visual: VisualMode) => VisualSessionEnd): HandleResult<void> {
  const visual = state.visual;
  if (visual === undefined) return invalid();
  return effect(
    "normal",
    () => {
      void run(visual);
    },
    { dotRepeatable: false }
  );
}

// Visual `gq`/`gw`: format the lines the selection covers, like the linewise
// operator on the selected row range. `gq` leaves the cursor on the last
// formatted line; `gw` keeps it. The visual-session teardown (remember for
// `gv`, clear the state) lives in [VisualMode.formatSelections], like the
// other visual commands.
function visualFormat(state: HandlerState, keepCursor: boolean): HandleResult<void> {
  return exitVisualEffect(state, visual => visual.formatSelections({ textwidth: configuredTextwidth(state), keepCursor }));
}

function visualJoin(state: HandlerState, insertWhitespace: boolean): HandleResult<void> {
  return exitVisualEffect(state, visual => visual.joinSelections({ insertWhitespace }));
}

function visualIncrement(
  state: HandlerState,
  direction: "increment" | "decrement",
  cumulative: boolean
): HandleResult<void> {
  const delta = (direction === "increment" ? 1 : -1) * state.repeat;
  return exitVisualEffect(state, visual => visual.increment(delta, cumulative ? delta : 0));
}

// Find motions (`f`/`t`/`F`/`T` + char, `;`/`,`) in visual mode extend the live
// selection rather than moving a single cursor. The chord/digraph parsing is
// shared with normal mode ([findHandler]/[repeatFindHandler]); this applier just
// swaps the cursor move for [VisualMode.applyMotion] and records a fresh find so
// `;`/`,` can repeat it.
const visualFindApplier: FindApplier = (state, motion, { record }) => {
  const visual = state.visual;
  if (visual === undefined) return invalid();
  const count = state.repeat;
  return effect(
    state.mode,
    () => {
      visual.applyMotion(motion, count);
      if (record) state.find?.record(motion);
    },
    { dotRepeatable: false }
  );
};

// Search navigation `n`/`N` in visual mode: repeat the last search (forward /
// reversed) and extend the live selection to the match (like the legacy
// `repeatSearch` → `applyMotion` path). `*`/`#` (search the selection) and `/`?`
// (the prompt) stay on the legacy dispatcher for now.
function visualSearchNavHandler(key: string, state: HandlerState): HandleResult<void> {
  if (key !== "n" && key !== "N") return unhandled();
  const editor = state.editor;
  const visual = state.visual;
  const search = state.search;
  if (editor === undefined || visual === undefined || search === undefined) return invalid();
  const count = state.repeat;
  const reversed = key === "N";
  return effect(
    state.mode,
    () => {
      const motion = search.repeat({ reversed });
      if (motion === undefined) return;
      if (reportSearchMotionStatus(state, editor, motion)) return;
      visual.applyMotion(motion, count);
    },
    { dotRepeatable: false }
  );
}

// Line motions (`G`/`+`/`-`) in visual mode extend the live selection, like the
// cursor motions but resolved via [lineMotionForKey] (which is kept out of
// [resolveMotion] so the operator grammar is unaffected). `G` is count-aware
// (line N, else the last line); `+`/`-` move count lines to the first non-blank.
function visualLineMotionHandler(key: string, state: HandlerState): HandleResult<void> {
  const motion = lineMotionForKey(key, state);
  if (motion === undefined) return unhandled();
  const visual = state.visual;
  if (visual === undefined) return invalid();
  const count = state.repeat;
  return effect(state.mode, () => visual.applyMotion(motion, count), { dotRepeatable: false });
}

// Cursor motions in visual mode extend the live selection (anchor fixed, head
// moves) rather than moving a single cursor. The motion resolution is shared
// with normal mode ([resolveMotion]); [VisualMode.applyMotion] does the
// selection extension. Motions the shared resolver does not cover (`g`-chords)
// fall through to the legacy dispatcher for now.
function visualMotionHandler(key: string, state: HandlerState): HandleResult<void> {
  const visual = state.visual;
  if (visual === undefined) return unhandled();
  // `%` is a visual command (`percentOrMatching`), not a plain motion; leave it
  // (and other not-yet-migrated commands) to the legacy dispatcher.
  if (key === "%") return unhandled();
  const motion = resolveMotion(key, state);
  if (motion === undefined) return unhandled();
  const count = state.repeat;
  // Motions never change the visual kind, so the target mode is static.
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
