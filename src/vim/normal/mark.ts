// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/mark.rs and mark fields in `state::VimGlobals`
// - translated concepts: local mark creation and mark jumps via ' / `
// - intentional differences: this first slice stores marks as in-buffer model positions;
//   cross-buffer/path marks, visual marks, and builtin change/jump marks remain future work.

import { VimEditorCapabilities } from "../editor.js";
import { Motion } from "../motion.js";
import { Position, VimSelection, rangeOfSelection, selectionHead } from "../state.js";

export class MarkState {
  private readonly marks = new Map<string, Position>();
  private previousContext: Position | undefined;

  createMark(editor: VimEditorCapabilities, key: string): void {
    this.marks.set(key, selectionHead(editor.getSelections()[0]));
  }

  setBuiltinMark(key: "." | "^", position: Position): void {
    this.marks.set(key, position);
  }

  setVisualSelectionMarks(editor: VimEditorCapabilities, selection: VimSelection): void {
    const range = rangeOfSelection(selection);
    this.marks.set("<", range.start);
    this.marks.set(">", previousPosition(editor, range.end));
  }

  position(key: string): Position | undefined {
    return this.marks.get(key);
  }

  jumpMotion(editor: VimEditorCapabilities, key: string, { line }: { line: boolean }): Motion | undefined {
    const target = this.markForJump(key);
    if (target === undefined) return undefined;
    this.previousContext = selectionHead(editor.getSelections()[0]);
    return { type: "jump", position: target, line };
  }

  private markForJump(key: string): Position | undefined {
    if (key === "`" || key === "'") return this.previousContext;
    return this.marks.get(key);
  }
}

function previousPosition(editor: VimEditorCapabilities, position: Position): Position {
  if (position.column > 0) return { row: position.row, column: position.column - 1 };
  if (position.row > 0) return { row: position.row - 1, column: Math.max(0, editor.lineLength(position.row - 1) - 1) };
  return position;
}
