// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/yank.rs
// - translated concepts: yank by motion and yank current line
// - intentional differences: this first slice writes only an unnamed clipboard string.

import { VimEditorCapabilities, rangeText } from "../editor.js";
import { Motion, lineRange, motionRange } from "../motion.js";
import { charwiseSelection, selectionHead } from "../state.js";

// Zed: `normal::yank::Vim::yank_motion`.
export function yankMotion(editor: VimEditorCapabilities, motion: Motion, count: number): void {
  const copied: string[] = [];

  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const range = motionRange(editor, head, motion, count);
    copied.push(rangeText(editor, range));
  }

  if (copied.length > 0) editor.writeClipboard(copied.join("\n"));
  editor.setSelections(editor.getSelections().map((selection) => charwiseSelection(selectionHead(selection))));
}

// Zed: `normal::Vim::yank_line` dispatches `Motion::CurrentLine` to `yank_motion`.
export function yankLines(editor: VimEditorCapabilities, count: number): void {
  const copied: string[] = [];

  for (const selection of editor.getSelections()) {
    copied.push(rangeText(editor, lineRange(editor, selectionHead(selection).row, count)));
  }

  if (copied.length > 0) editor.writeClipboard(copied.join("\n"));
  editor.setSelections(editor.getSelections().map((selection) => charwiseSelection(selectionHead(selection))));
}
