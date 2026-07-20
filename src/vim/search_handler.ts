// Zed reference:
// - sources: crates/vim/src/normal/search.rs and the `/`?`/`n`/`N`/`*`/`#`
//   bindings in assets/keymaps/vim.json
// - translated concepts: search as a typed handler graph — `/`?` is the
//   executor's `search` mode, and `n`/`N`/`*`/`#` are search motions. Both reuse
//   the shared [SearchState] (last pattern + incremental prompt UI), injected
//   into the handler state like editor/registers, so the handlers stay pure.

import type { VimEditorCapabilities } from "./editor.js";
import type { HandleResult, Handler, HandlerState } from "./key_handler.js";
import {
  cloneHandlerState,
  dynamicModeEffect,
  effect,
  handler,
  invalid,
  isEscapeKey,
  unhandled,
} from "./key_handler.js";
import type { Motion } from "./motion.js";
import { applyMotion } from "./motion.js";
import { applyMotionResults } from "./motion_handler.js";
import type { PendingSearch, SearchState } from "./normal/search.js";
import { searchUnderCursorMotion } from "./normal/search.js";
import type { Registers } from "./registers.js";
import { isVisualModeKind, rangeOfSelection, selectionHead } from "./state.js";
import type { VimMode } from "./state.js";

// `/` and `?`: enter `search` mode. The effect targets the mode; the owner's
// mode transition starts the incremental prompt (it owns the editable query),
// and [searchModeHandler] then drives input. Not a buffer change.
export function searchPromptHandler(
  key: string,
  state: HandlerState
): HandleResult<void> {
  if (key !== "/" && key !== "?") return unhandled();
  return effect("search", () => {}, {
    search: { backwards: key === "?" },
    dotRepeatable: false,
  });
}

// The `search` mode grammar: drive the in-flight `/`?` query. `enter` resolves
// the search [Motion] and moves the cursor (back to normal mode); other input
// keys update the query and incsearch preview, staying in `search` mode. Escape
// and unknown (non-input) keys are declined so the owner can cancel the prompt
// (escape) or let them through to the host (e.g. native find-widget chords).
export function searchModeHandler(
  key: string,
  state: HandlerState
): HandleResult<void> {
  const editor = state.editor;
  const search = state.search;
  const pending = state.activeSearch;
  const registers = state.registers;
  if (
    editor === undefined ||
    search === undefined ||
    pending === undefined ||
    registers === undefined
  ) {
    return unhandled();
  }
  // Escape cancels via the owner's escape handling.
  if (isEscapeKey(key)) return unhandled();
  if (key === "enter") {
    // A `/`?` started from visual mode extends the live selection to the match
    // and returns to that visual kind; from normal mode it moves the cursor and
    // returns to normal. Either way, `enter` resolves and ends the prompt.
    const origin = state.searchOrigin;
    if (origin !== undefined && isVisualModeKind(origin)) {
      const visual = state.visual;
      return effect(origin, () => {
        state.setPendingSearchNotFound?.(undefined);
        const motion = search.handleKey(pending, "enter", registers, editor).motion;
        if (motion !== undefined && !reportSearchMotionNotFound(state, editor, motion)) {
          visual?.applyMotion(motion, 1);
        }
        editor.clearSearchHighlights();
      });
    }
    return effect("normal", () => {
      state.setPendingSearchNotFound?.(undefined);
      const motion = search.handleKey(pending, "enter", registers, editor).motion;
      if (motion === undefined) return;
      reportSearchMotionNotFound(state, editor, motion);
      applyMotionResults(
        editor,
        editor.getSelections().map((selection) => ({
          position: applyMotion(editor, selectionHead(selection), motion, 1),
        }))
      );
      editor.clearSearchHighlights();
    });
  }
  // A query/edit key: update the prompt + incsearch preview, stay in search
  // mode. A key the mini-buffer does not understand is swallowed, loudly: an
  // open prompt owns the keyboard, and forwarding stray keys to the host would
  // turn typos into editor actions.
  return effect("search", () => {
    if (!search.handleKey(pending, key, registers, editor).handled) {
      state.reportSwallowedPromptKey?.(key);
    }
    state.setPendingSearchNotFound?.(search.pendingNotFoundQuery(pending, editor));
  }, {
    registerToRead: key === "ctrl-v" || key === "ctrl-y" ? { registerName: "+" } : undefined,
  });
}

// Search as an operator operand (`d/`/`c/`/`y/`). Unlike the standalone `search`
// mode, this is an *in-graph* prompt waiter: it stays a pending continuation
// *under* the operator (entering `search` mode would rebuild the executor's root
// handlers and discard the pending operator). It drives the incsearch query
// inline and, on `enter`, hands the resolved search [Motion] to [apply] (the
// operator application) and clears the match preview. Escape, or an empty /
// no-match `enter`, aborts the operator without editing.
export function searchOperandHandler(
  state: HandlerState,
  backwards: boolean,
  apply: (motion: Motion, state: HandlerState) => HandleResult<void>
): HandleResult<void> {
  const editor = state.editor;
  const search = state.search;
  if (editor === undefined || search === undefined) return invalid();
  // Build the pending prompt purely; the preview (a side effect) is deferred to
  // the pending continuation's effect so this handler body stays pure.
  const pending = search.createPending(backwards);
  return handler(
    [
      {
        handler: searchOperandWaiter(pending, apply),
        state: {
          ...cloneHandlerState(state),
          operatorDepth: state.operatorDepth + 1,
        },
      },
    ],
    { effect: { run: () => search.beginPreview(pending, editor) } }
  );
}

function searchOperandWaiter(
  pending: PendingSearch,
  apply: (motion: Motion, state: HandlerState) => HandleResult<void>
): Handler<void> {
  return (key, state) => {
    const editor = state.editor;
    const search = state.search;
    const registers = state.registers;
    if (editor === undefined || search === undefined || registers === undefined)
      return invalid();
    // Escape aborts the operator (no edit) and tears down the prompt preview.
    // Vim: the aborted query still enters the search history.
    if (isEscapeKey(key)) {
      return effect("normal", () => {
        state.setPendingSearchNotFound?.(undefined);
        search.recordHistory(pending);
        search.clearPending(editor, pending, { restoreViewport: true });
      });
    }
    if (key !== "enter") {
      // A query edit: update the incsearch preview as a deferred effect and
      // keep waiting for the next key (the body stays pure). A key the
      // mini-buffer does not understand is swallowed and reported, and the
      // operand prompt keeps waiting, like the standalone search prompt;
      // aborting the pending operator over a stray key would be worse than
      // ignoring it.
      return handler(
        [
          {
            handler: searchOperandWaiter(pending, apply),
            state: cloneHandlerState(state),
          },
        ],
        {
          effect: {
            run: () => {
              if (!search.handleKey(pending, key, registers, editor).handled) {
                state.reportSwallowedPromptKey?.(key);
              }
              state.setPendingSearchNotFound?.(search.pendingNotFoundQuery(pending, editor));
            },
            registerToRead: key === "ctrl-v" || key === "ctrl-y" ? { registerName: "+" } : undefined,
          },
        }
      );
    }
    // `enter`: resolve the pattern to a [Motion] purely, then apply the operator.
    // An empty / no-pattern input aborts the operator (still ending the preview).
    // The search's own side effects (preview teardown, history entry,
    // [last]/register/highlight update) and the operator edit are deferred into
    // the effect below.
    const motion = search.resolveMotion(pending);
    if (motion === undefined) {
      return effect("normal", () =>
        search.clearPending(editor, pending, { restoreViewport: false })
      );
    }
    return withClearHighlights(
      withSearchCommit(apply(motion, state), () => {
        state.setPendingSearchNotFound?.(undefined);
        search.recordHistory(pending);
        search.commitMotion(motion, registers, editor);
        // A missing match aborts the operator; make the abort loud (E486).
        reportSearchMotionNotFound(state, editor, motion);
      }),
      editor
    );
  };
}

// Vim E486: report a transient warning when a search motion has no match from
// the current cursor. Returns whether the pattern was missing.
export function reportSearchMotionNotFound(
  state: HandlerState,
  editor: VimEditorCapabilities,
  motion: Motion
): boolean {
  if (motion.type !== "searchForward" && motion.type !== "searchBackward") return false;
  const match = editor.findSearchMatch(
    motion.query,
    selectionHead(editor.getSelections()[0]),
    motion.type === "searchForward" ? "forward" : "backward",
    motion.options
  );
  if (match !== undefined) return false;
  state.reportSearchNotFound?.(motion.query);
  return true;
}

// Run [commit] (the deferred search side effects: preview teardown, [last] +
// register + highlight update) just before the operator's own effect, matching
// the original order where the search completed before the operator ran. The
// operator's mode/dot-repeatability are preserved by wrapping only its [run].
function withSearchCommit(
  result: HandleResult<void>,
  commit: () => void
): HandleResult<void> {
  if (result.type !== "run" || result.action.type !== "effect") return result;
  const action = result.action;
  const innerRun = action.run;
  return {
    type: "run",
    action: {
      ...action,
      run: () => {
        commit();
        return innerRun();
      },
    },
  };
}

// Clear the match highlights after the operator runs, matching the legacy
// search-completion path. The operator's effect is wrapped so the mode and
// dot-repeatability it declared are preserved.
function withClearHighlights(
  result: HandleResult<void>,
  editor: VimEditorCapabilities
): HandleResult<void> {
  if (result.type !== "run" || result.action.type !== "effect") return result;
  const action = result.action;
  const innerRun = action.run;
  return {
    type: "run",
    action: {
      ...action,
      run: () => {
        const value = innerRun();
        editor.clearSearchHighlights();
        return value;
      },
    },
  };
}

// `gn`/`gN` (standalone): select the next/previous search match as a charwise
// visual selection. From normal mode the current match counts (`includeStart`)
// and a fresh selection is created; from visual mode the selection extends to the
// match. Shared by the normal-mode `g`-chord ([gContinuation]) and the
// visual-mode `g`-chord ([visualGContinuation]). The target mode is dynamic:
// `visual` when a match is selected, otherwise unchanged (no match → stay put).
export function searchSelectionHandler(state: HandlerState, reversed: boolean): HandleResult<void> {
  const editor = state.editor;
  const search = state.search;
  const visual = state.visual;
  if (editor === undefined || search === undefined || visual === undefined) return invalid();
  const count = state.repeat;
  let target: VimMode = state.mode;
  return dynamicModeEffect(
    state.mode,
    () => {
      const fromVisual = isVisualModeKind(state.mode);
      const range = search.matchRangeForSelection(editor, { reversed, count, includeStart: !fromVisual });
      if (range === undefined) return;
      const current = editor.getSelections()[0];
      if (fromVisual && current?.type === "charwise") {
        // Extend the live selection to the next match (anchor fixed).
        const currentRange = rangeOfSelection(current);
        editor.setSelections([
          reversed
            ? { type: "charwise", anchor: currentRange.end, head: range.start }
            : { type: "charwise", anchor: currentRange.start, head: range.end },
        ]);
      } else {
        editor.setSelections([
          reversed
            ? { type: "charwise", anchor: range.end, head: range.start }
            : { type: "charwise", anchor: range.start, head: range.end },
        ]);
      }
      if (visual.adoptSelection(editor.getSelections()[0])) target = "visual";
    },
    () => target,
    { dotRepeatable: false }
  );
}

// Visual `*`/`#`: search for the selected text (forward / backward), leave visual
// mode, and jump to the match — the visual analogue of the normal-mode
// search-under-cursor. The query is the literal selection text (not whole-word,
// unlike `*`/`#` over the word under the cursor); an empty selection does nothing
// and stays in visual mode. Mirrors the legacy `applySearchUnderCursor` visual
// branch: clear the visual state and restore the block cursor (rather than
// [VisualMode.exit], so the selection is not remembered for `gv`), then run a
// normal-mode motion from the selection head. The target mode is dynamic:
// `normal` once a search runs, otherwise the (unchanged) visual mode.
export function visualSearchUnderCursorHandler(
  key: string,
  state: HandlerState
): HandleResult<void> {
  if (key !== "*" && key !== "#") return unhandled();
  const editor = state.editor;
  const search = state.search;
  const registers = state.registers;
  const visual = state.visual;
  if (editor === undefined || search === undefined || registers === undefined || visual === undefined) {
    return invalid();
  }
  const backwards = key === "#";
  const count = state.repeat;
  let target: VimMode = state.mode;
  return dynamicModeEffect(
    state.mode,
    () => {
      const selection = editor.getSelections()[0];
      if (selection === undefined) return;
      const query = editor.getText(rangeOfSelection(selection));
      if (query.length === 0) return;
      const motion = search.setLast(query, backwards, registers, editor, { regex: false });
      visual.clearState();
      editor.setCursorStyle("block");
      target = "normal";
      applyMotionResults(
        editor,
        editor.getSelections().map((selection) => ({
          position: applyMotion(editor, selectionHead(selection), motion, count),
        }))
      );
      editor.clearSearchHighlights();
    },
    () => target,
    { dotRepeatable: false }
  );
}

// Search navigation: `n`/`N` repeat the last search (forward/reversed), `*`/`#`
// search for the word under the cursor (forward/backward). Each produces a
// search [Motion] from the injected [SearchState] and moves the cursor; this is
// the navigation form (as an operator operand, `/` is handled by the search
// prompt). Not a buffer change, so not dot-repeatable.
export function searchActionHandler(
  key: string,
  state: HandlerState
): HandleResult<void> {
  switch (key) {
    case "n":
      return searchNavigation(
        state,
        (search) => search.repeat({ reversed: false }),
        { clearHighlights: false }
      );
    case "N":
      return searchNavigation(
        state,
        (search) => search.repeat({ reversed: true }),
        { clearHighlights: false }
      );
    case "*":
      return searchNavigation(
        state,
        (search, editor, registers) =>
          searchUnderCursorMotion(editor, search, registers, {
            backwards: false,
          }),
        { clearHighlights: true }
      );
    case "#":
      return searchNavigation(
        state,
        (search, editor, registers) =>
          searchUnderCursorMotion(editor, search, registers, {
            backwards: true,
          }),
        { clearHighlights: true }
      );
    default:
      return unhandled();
  }
}

// Run a search-navigation motion. [resolve] produces the [Motion] (it may have
// side-effects — `*`/`#` set the last pattern and update the search UI), so it
// runs inside the effect, then the cursor moves to the match. `*`/`#` clear the
// match highlights after jumping, matching the legacy `searchUnderCursor`.
function searchNavigation(
  state: HandlerState,
  resolve: (
    search: SearchState,
    editor: VimEditorCapabilities,
    registers: Registers
  ) => Motion | undefined,
  { clearHighlights }: { clearHighlights: boolean }
): HandleResult<void> {
  const editor = state.editor;
  const registers = state.registers;
  const search = state.search;
  if (editor === undefined || registers === undefined || search === undefined)
    return invalid();
  const count = state.repeat;
  return effect(
    "normal",
    () => {
      const motion = resolve(search, editor, registers);
      if (motion === undefined) return;
      reportSearchMotionNotFound(state, editor, motion);
      applyMotionResults(
        editor,
        editor.getSelections().map((selection) => ({
          position: applyMotion(
            editor,
            selectionHead(selection),
            motion,
            count
          ),
        }))
      );
      if (clearHighlights) editor.clearSearchHighlights();
    },
    { dotRepeatable: false }
  );
}
