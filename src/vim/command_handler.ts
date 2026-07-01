// Zed reference:
// - source: crates/vim/src/command.rs and the `:` binding in
//   assets/keymaps/vim.json
// - translated concepts: `:` command mode as a typed prompt handler, mirroring
//   the `/`?` search prompt (`search_handler.ts`). The command line
//   ([CommandLine]) is injected into the handler state like the search query;
//   the ex-command execution is owner-side (Vim), because it re-enters the key
//   pipeline (`:normal`/`:g`) and must run after the effect queue has drained.

import { isCommandInputKey } from "./command.js";
import type { HandleResult, HandlerState } from "./key_handler.js";
import { effect, unhandled } from "./key_handler.js";

// `:` enters command mode. Like the `/`?` search prompt the effect only targets
// the mode; the owner's transition ([enterModeFromExecutor]) creates the
// editable command line (prefilling the `'<,'>` range from a visual selection)
// and routes subsequent keys here via [commandModeHandler]. Wired into both the
// normal and visual grammars.
export function commandPromptHandler(key: string, _state: HandlerState): HandleResult<void> {
  if (key !== ":") return unhandled();
  return effect("command", () => {}, { dotRepeatable: false });
}

// The `command` mode grammar: drive the `:` command line. `enter` submits and
// targets normal mode — the owner runs the accumulated command when it applies
// that transition, *after* the effect queue drains, so a `:normal`/`:g` command
// that re-enters the key pipeline runs its keys synchronously (like the legacy
// path). `backspace` deletes the last char; any other input key appends to the
// line. Escape and unknown (non-input) keys are declined so the owner cancels
// the prompt (escape) or leaves them to the host.
export function commandModeHandler(key: string, state: HandlerState): HandleResult<void> {
  const command = state.activeCommand;
  if (command === undefined) return unhandled();
  if (!isCommandInputKey(key) || isCommandEscape(key)) return unhandled();
  if (key === "enter") {
    return effect("normal", () => {}, { dotRepeatable: false });
  }
  if (key === "backspace") {
    return effect("command", () => command.backspace(), { dotRepeatable: false });
  }
  return effect("command", () => command.append(key), { dotRepeatable: false });
}

function isCommandEscape(key: string): boolean {
  return key === "<escape>" || key === "escape" || key === "ctrl-[";
}
