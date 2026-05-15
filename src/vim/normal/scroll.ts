// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/scroll.rs plus z-prefix keymap entries in assets/keymaps/vim.json
// - translated concepts: normal-mode scroll/page/reveal/fold host actions
// - intentional differences: VSCode owns viewport, navigation history, undo/redo, and folding;
//   this module only maps resolved actions to host capabilities.

import { VimEditorCapabilities } from "../editor.js";
import { NormalChordAction } from "./chord.js";

export function handleHostAction(
  editor: VimEditorCapabilities,
  action: NormalChordAction,
  takeCount: (defaultValue: number) => number
): void {
  switch (action.type) {
    case "z":
      handleZKey(editor, action.key);
      return;
    case "host":
      handleHostKey(editor, action.key, takeCount);
      return;
  }
}

function handleZKey(editor: VimEditorCapabilities, key: string): void {
  switch (key) {
    case "z":
      editor.revealCurrentLine("center");
      return;
    case "t":
      editor.revealCurrentLine("top");
      return;
    case "b":
      editor.revealCurrentLine("bottom");
      return;
    case "a":
      editor.executeFoldCommand("toggle");
      return;
    case "o":
      editor.executeFoldCommand("open");
      return;
    case "c":
      editor.executeFoldCommand("close");
      return;
    case "O":
      editor.executeFoldCommand("openRecursive");
      return;
    case "C":
      editor.executeFoldCommand("closeRecursive");
      return;
    case "R":
      editor.executeFoldCommand("openAll");
      return;
    case "M":
      editor.executeFoldCommand("closeAll");
      return;
    default:
      return;
  }
}

function handleHostKey(
  editor: VimEditorCapabilities,
  key: string,
  takeCount: (defaultValue: number) => number
): void {
  switch (key) {
    case "ctrl-o":
      editor.executeHostCommand("navigateBack");
      return;
    case "ctrl-i":
      editor.executeHostCommand("navigateForward");
      return;
    case "u":
      editor.executeHostCommand("undo");
      return;
    case "ctrl-r":
      editor.executeHostCommand("redo");
      return;
    case "ctrl-y":
      editor.scrollByLines("up", takeCount(1));
      return;
    case "ctrl-e":
      editor.scrollByLines("down", takeCount(1));
      return;
    default:
      return;
  }
}
