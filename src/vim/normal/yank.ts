// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/yank.rs
// - translated concepts: yank by motion and yank current line
// - intentional differences: this first slice writes only an unnamed clipboard string.

import { VimEditorCapabilities, rangeText } from "../editor.js";
import { Motion, motionRange } from "../motion.js";
import { RegisterName, Registers } from "../registers.js";
import { TextRange, charwiseSelection, selectionHead } from "../state.js";

// Zed: `normal::yank::Vim::yank_motion`.
export function yankMotion(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  motion: Motion,
  count: number
): void {
  yankRange(editor, registers, registerName, (head) => motionRange(editor, head, motion, count));
}

export function yankRange(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  rangeForHead: (head: ReturnType<typeof selectionHead>) => TextRange
): void {
  const copied: string[] = [];

  for (const selection of editor.getSelections()) {
    copied.push(rangeText(editor, rangeForHead(selectionHead(selection))));
  }

  if (copied.length > 0) {
    registers.writeYank(
      registerName,
      copied.join("\n"),
      "characterwise",
      copied.map(text => ({ text, kind: "characterwise" }))
    );
  }
  editor.setSelections(editor.getSelections().map((selection) => charwiseSelection(selectionHead(selection))));
}

// Zed: `normal::Vim::yank_line` dispatches `Motion::CurrentLine` to `yank_motion`.
export function yankLines(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  count: number
): void {
  const copied: string[] = [];

  for (const selection of editor.getSelections()) {
    copied.push(linewiseContent(editor, selectionHead(selection).row, count));
  }

  if (copied.length > 0) {
    registers.writeYank(
      registerName,
      copied.join(""),
      "linewise",
      copied.map(text => ({ text, kind: "linewise" }))
    );
  }
  editor.setSelections(editor.getSelections().map((selection) => charwiseSelection(selectionHead(selection))));
}

function linewiseContent(editor: VimEditorCapabilities, row: number, count: number): string {
  const startRow = Math.max(0, Math.min(row, editor.lineCount() - 1));
  const endRow = Math.min(startRow + count, editor.lineCount());
  const lines: string[] = [];
  for (let current = startRow; current < endRow; current++) lines.push(editor.line(current));
  return `${lines.join("\n")}\n`;
}
