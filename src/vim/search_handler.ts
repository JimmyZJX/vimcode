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
  effect,
  handler,
  invalid,
  unhandled,
} from "./key_handler.js";
import type { Motion } from "./motion.js";
import { applyMotion } from "./motion.js";
import { applyMotionResults } from "./motion_handler.js";
import type { PendingSearch, SearchState } from "./normal/search.js";
import { isSearchInputKey, searchUnderCursorMotion } from "./normal/search.js";
import type { Registers } from "./registers.js";
import { selectionHead } from "./state.js";

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
  // Escape cancels via the owner's escape handling; unknown keys go to the host.
  if (!isSearchInputKey(key) || isSearchEscape(key)) return unhandled();
  if (key === "enter") {
    return effect("normal", () => {
      const motion = search.handleKey(pending, "enter", registers, editor);
      if (motion === undefined) return;
      applyMotionResults(
        editor,
        editor.getSelections().map((selection) => ({
          position: applyMotion(editor, selectionHead(selection), motion, 1),
        }))
      );
      editor.clearSearchHighlights();
    });
  }
  // A query/edit key: update the prompt + incsearch preview, stay in search mode.
  return effect("search", () => {
    search.handleKey(pending, key, registers, editor);
  });
}

function isSearchEscape(key: string): boolean {
  return key === "<escape>" || key === "escape" || key === "ctrl-[";
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
  const pending = search.start(backwards, editor);
  return handler([
    {
      handler: searchOperandWaiter(pending, apply),
      state: {
        ...cloneHandlerState(state),
        operatorDepth: state.operatorDepth + 1,
      },
    },
  ]);
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
    if (isSearchEscape(key)) {
      return effect("normal", () =>
        search.clearPending(editor, pending, { restoreViewport: true })
      );
    }
    if (!isSearchInputKey(key)) return invalid();
    const motion = search.handleKey(pending, key, registers, editor);
    if (key !== "enter") {
      return handler([
        {
          handler: searchOperandWaiter(pending, apply),
          state: cloneHandlerState(state),
        },
      ]);
    }
    // `enter`: an empty query / no match aborts the operator (the prompt preview
    // was already ended by [handleKey]); otherwise apply the operator.
    if (motion === undefined) return effect("normal", () => {});
    return withClearHighlights(apply(motion, state), editor);
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
