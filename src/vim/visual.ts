// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `visual` module
// - translated concepts: visual-mode state, visual motion extension, and visual delete
// - intentional differences: this first slice supports only charwise visual selections.
//   Visual-line, visual-block, inclusive marker fidelity, paste, yank, and multi-cursor
//   behavior remain future work.

import { VimEditorCapabilities } from "./editor.js";
import { applyMotion, Motion, motionForKey } from "./motion.js";
import { deleteRange } from "./normal/delete.js";
import { Registers } from "./registers.js";
import { KeyResult, Position, charwiseSelection, selectionHead } from "./state.js";

export type VisualKeyResult = {
  keyResult: KeyResult;
  exitVisual: boolean;
};

function handled({ exitVisual = false }: { exitVisual?: boolean } = {}): VisualKeyResult {
  return { keyResult: "handled", exitVisual };
}

export class VisualMode {
  private anchor: Position | undefined;
  private lastMotion: Motion | undefined;

  constructor(
    private readonly editor: VimEditorCapabilities,
    private readonly registers: Registers
  ) {}

  enter(): void {
    const selection = this.editor.getSelections()[0];
    this.anchor = selectionHead(selection);
    this.lastMotion = undefined;
    this.editor.setCursorStyle("line");
  }

  exit(): void {
    this.anchor = undefined;
    this.lastMotion = undefined;
    this.editor.setCursorStyle("block");
    this.editor.setSelections(this.editor.getSelections().map(selection => charwiseSelection(selectionHead(selection))));
  }

  onKey(key: string): VisualKeyResult {
    if (key === "d" || key === "x") {
      if (this.anchor !== undefined) {
        deleteRange(
          this.editor,
          this.registers,
          undefined,
          head => ({ start: this.anchor!, end: visualDeleteEnd(this.editor, head, this.lastMotion) }),
          (_editor, range) => range.start
        );
      }
      this.anchor = undefined;
      this.lastMotion = undefined;
      this.editor.setCursorStyle("block");
      return handled({ exitVisual: true });
    }

    const motion = motionForKey(key);
    if (motion !== undefined && this.anchor !== undefined) {
      const head = applyMotion(this.editor, selectionHead(this.editor.getSelections()[0]), motion, 1);
      this.lastMotion = motion;
      this.editor.setSelections([{ type: "charwise", anchor: this.anchor, head }]);
      return handled();
    }

    this.exit();
    return handled({ exitVisual: true });
  }
}

function visualDeleteEnd(editor: VimEditorCapabilities, head: Position, motion: Motion | undefined): Position {
  if (motion?.type !== "nextWordEnd") return head;
  const lineLength = editor.lineLength(head.row);
  if (lineLength === 0) return head;
  return { row: head.row, column: Math.min(head.column + 1, lineLength) };
}

