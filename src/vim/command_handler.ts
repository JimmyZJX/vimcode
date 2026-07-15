// Zed reference:
// - source: crates/vim/src/command.rs and the `:` binding in
//   assets/keymaps/vim.json
// - translated concepts: `:` command mode as a typed prompt handler, mirroring
//   the `/`?` search prompt (`search_handler.ts`). The command line
//   ([CommandLine]) is injected into the handler state like the search query;
//   the ex-command execution is owner-side (Vim), because it re-enters the key
//   pipeline (`:normal`/`:g`) and must run after the effect queue has drained.

import type { HandleResult, HandlerState } from "./key_handler.js";
import { effect, isEscapeKey, unhandled } from "./key_handler.js";
import { historyNavigationKey } from "./prompt_history.js";

// `:` enters command mode. Like the `/`?` search prompt the effect only targets
// the mode; the owner's transition ([enterModeFromExecutor]) creates the
// editable command line (prefilling the `'<,'>` range from a visual selection)
// and routes subsequent keys here via [commandModeHandler]. Wired into both the
// normal and visual grammars.
export function commandPromptHandler(key: string, _state: HandlerState): HandleResult<void> {
  if (key !== ":") return unhandled();
  return effect("command", () => {}, { dotRepeatable: false });
}

// The `command` mode grammar: drive the `:` command-line mini-buffer. `enter`
// submits and targets normal mode — the owner runs the accumulated command
// when it applies that transition, *after* the effect queue drains, so a
// `:normal`/`:g` command that re-enters the key pipeline runs its keys
// synchronously (like the legacy path). [SingleLineEditor] keys move the
// cursor and edit around it; `<Up>`/`<Down>`/`<C-p>`/`<C-n>` recall history.
// Escape is declined so the owner cancels the prompt. Every other key is
// *swallowed* — an open prompt owns the keyboard; forwarding stray keys to the
// host (or a later mode) turns typos into editor actions — and reported so the
// host can show a warning.
export function commandModeHandler(key: string, state: HandlerState): HandleResult<void> {
  const command = state.activeCommand;
  if (command === undefined) return unhandled();
  if (isEscapeKey(key)) return unhandled();
  if (key === "enter") {
    return effect("normal", () => {}, { dotRepeatable: false });
  }
  // `<Up>`/`<Down>`/`<C-p>`/`<C-n>`: recall through the command history.
  if (historyNavigationKey(key) !== undefined) {
    return effect(
      "command",
      () => {
        command.historyKey(key);
      },
      { dotRepeatable: false }
    );
  }
  if (key.length === 1) {
    return effect("command", () => command.insert(key), { dotRepeatable: false });
  }
  return effect(
    "command",
    () => {
      if (!command.tryKey(key)) state.reportSwallowedPromptKey?.(key);
    },
    { dotRepeatable: false }
  );
}
