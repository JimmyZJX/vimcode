// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/change.rs
// - translated concepts: change by motion and change current line
// - intentional differences: this first slice reuses delete behavior and lets the caller
//   switch to insert mode; Zed has richer recording, indentation, and selection fixups.

import { VimEditorCapabilities } from "../editor.js";
import { Motion } from "../motion.js";
import { RegisterName, Registers } from "../registers.js";
import { deleteLines, deleteMotion } from "./delete.js";

// Zed: `normal::change::Vim::change_motion`.
export function changeMotion(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  motion: Motion,
  count: number
): void {
  deleteMotion(editor, registers, registerName, motion, count);
}

// Zed: `Motion::CurrentLine` flowing into `normal::change::Vim::change_motion`.
export function changeLines(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  count: number
): void {
  deleteLines(editor, registers, registerName, count);
}
