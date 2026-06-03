// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/scroll.rs plus z-prefix keymap entries in assets/keymaps/vim.json
// - translated concepts: normal-mode scroll/page/reveal/fold host actions
// - intentional differences: VSCode owns viewport, navigation history, undo/redo, and folding;
//   this module only maps resolved actions to host capabilities.

import { HostCommand, HostFoldCommand, HostRevealTarget, VimEditorCapabilities } from "../editor.js";
import { NormalChordAction } from "./chord.js";

type ZKeyAction =
  | { type: "reveal"; target: HostRevealTarget }
  | { type: "fold"; command: HostFoldCommand };

type HostKeyAction =
  | { type: "command"; command: HostCommand }
  | { type: "scroll"; direction: "up" | "down" };

const zKeyActions: ReadonlyMap<string, ZKeyAction> = new Map([
  ["z", { type: "reveal", target: "center" }],
  ["t", { type: "reveal", target: "top" }],
  ["b", { type: "reveal", target: "bottom" }],
  ["a", { type: "fold", command: "toggle" }],
  ["o", { type: "fold", command: "open" }],
  ["c", { type: "fold", command: "close" }],
  ["O", { type: "fold", command: "openRecursive" }],
  ["C", { type: "fold", command: "closeRecursive" }],
  ["R", { type: "fold", command: "openAll" }],
  ["M", { type: "fold", command: "closeAll" }],
]);

const hostKeyActions: ReadonlyMap<string, HostKeyAction> = new Map([
  ["ctrl-o", { type: "command", command: "navigateBack" }],
  ["ctrl-i", { type: "command", command: "navigateForward" }],
  ["u", { type: "command", command: "undo" }],
  ["ctrl-r", { type: "command", command: "redo" }],
  ["ctrl-y", { type: "scroll", direction: "up" }],
  ["ctrl-e", { type: "scroll", direction: "down" }],
]);

export function handleHostAction(
  editor: VimEditorCapabilities,
  action: NormalChordAction,
  takeCount: (defaultValue: number) => number
): HostCommand | undefined {
  switch (action.type) {
    case "z":
      handleZKey(editor, action.key);
      return undefined;
    case "host":
      return handleHostKey(editor, action.key, takeCount);
  }
}

function handleZKey(editor: VimEditorCapabilities, key: string): void {
  const action = zKeyActions.get(key);
  if (action === undefined) return;
  switch (action.type) {
    case "reveal":
      editor.revealCurrentLine(action.target);
      return;
    case "fold":
      editor.executeFoldCommand(action.command);
      return;
  }
}

function handleHostKey(
  editor: VimEditorCapabilities,
  key: string,
  takeCount: (defaultValue: number) => number
): HostCommand | undefined {
  const action = hostKeyActions.get(key);
  if (action === undefined) return undefined;
  switch (action.type) {
    case "command":
      editor.executeHostCommand(action.command);
      return action.command;
    case "scroll":
      editor.scrollByLines(action.direction, takeCount(1));
      return undefined;
  }
}
