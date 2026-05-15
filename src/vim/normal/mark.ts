// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/mark.rs and mark fields in `state::VimGlobals`
// - translated concepts: local mark creation and mark jumps via `'` / `` ` ``
// - intentional differences: this first slice stores marks as in-buffer model positions;
//   cross-buffer/path marks, visual marks, and builtin change/jump marks remain future work.

import { VimEditorCapabilities } from "../editor.js";
import { Motion } from "../motion.js";
import { Position, selectionHead } from "../state.js";

export type PendingMark =
  | { type: "create" }
  | { type: "jump"; line: boolean };

export class MarkState {
  private readonly marks = new Map<string, Position>();
  private previousContext: Position | undefined;
  private pending: PendingMark | undefined;

  isPending(): boolean {
    return this.pending !== undefined;
  }

  pendingChord(): string {
    if (this.pending === undefined) return "";
    switch (this.pending.type) {
      case "create":
        return "m";
      case "jump":
        return this.pending.line ? "'" : "`";
    }
  }

  createMark(editor: VimEditorCapabilities, key: string): void {
    this.marks.set(key, selectionHead(editor.getSelections()[0]));
  }

  jumpMotion(editor: VimEditorCapabilities, key: string, { line }: { line: boolean }): Motion | undefined {
    const target = this.markForJump(key);
    if (target === undefined) return undefined;
    this.previousContext = selectionHead(editor.getSelections()[0]);
    return { type: "jump", position: target, line };
  }

  startCreate(): void {
    this.pending = { type: "create" };
  }

  startJump({ line }: { line: boolean }): void {
    this.pending = { type: "jump", line };
  }

  clearPending(): void {
    this.pending = undefined;
  }

  handleKey(editor: VimEditorCapabilities, key: string): Motion | undefined {
    const pending = this.pending;
    this.pending = undefined;
    if (pending === undefined) return undefined;

    switch (pending.type) {
      case "create": {
        this.createMark(editor, key);
        return undefined;
      }
      case "jump":
        return this.jumpMotion(editor, key, { line: pending.line });
    }
  }

  private markForJump(key: string): Position | undefined {
    if (key === "`" || key === "'") return this.previousContext;
    return this.marks.get(key);
  }
}
