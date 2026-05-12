// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `visual` module
// - translated concepts: visual-mode state, visual motion extension, and visual delete
// - intentional differences: this first slice supports only forward charwise visual selections.
//   Visual-line, visual-block, backward selection fidelity, paste, yank, and multi-cursor
//   behavior remain future work.

import { VimEditorCapabilities } from "./editor.js";
import { applyMotion, Motion, motionForKey } from "./motion.js";
import { cursorAfterDeletingRange, deleteRange } from "./normal/delete.js";
import { Registers } from "./registers.js";
import { KeyResult, Position, TextRange, VimSelection, charwiseSelection, comparePositions, selectionHead } from "./state.js";

export type VisualKeyResult = {
  keyResult: KeyResult;
  exitVisual: boolean;
};

type VisualState = {
  kind: "charwise";
  anchor: Position;
  head: Position; // Vim cursor position; inclusive.
};

function handled({ exitVisual = false }: { exitVisual?: boolean } = {}): VisualKeyResult {
  return { keyResult: "handled", exitVisual };
}

export class VisualMode {
  private state: VisualState | undefined;

  constructor(
    private readonly editor: VimEditorCapabilities,
    private readonly registers: Registers
  ) {}

  enter(): void {
    const selection = this.editor.getSelections()[0];
    const head = selectionHead(selection);
    this.state = { kind: "charwise", anchor: head, head };
    this.editor.setCursorStyle("line");
    this.syncEditorSelection();
  }

  exit(): void {
    this.state = undefined;
    this.editor.setCursorStyle("block");
    this.editor.setSelections(this.editor.getSelections().map(selection => charwiseSelection(selectionHead(selection))));
  }

  onKey(key: string): VisualKeyResult {
    if (key === "d" || key === "x") {
      const state = this.state;
      if (state !== undefined) {
        deleteRange(
          this.editor,
          this.registers,
          undefined,
          () => visualDeleteRange(this.editor, state),
          cursorAfterDeletingRange
        );
      }
      this.state = undefined;
      this.editor.setCursorStyle("block");
      return handled({ exitVisual: true });
    }

    const motion = motionForKey(key);
    if (motion !== undefined && this.state !== undefined) {
      this.state = {
        ...this.state,
        head: visualHeadAfterMotion(this.editor, this.state, motion),
      };
      this.syncEditorSelection();
      return handled();
    }

    this.exit();
    return handled({ exitVisual: true });
  }

  private syncEditorSelection(): void {
    if (this.state === undefined) return;
    this.editor.setSelections([visualStateToEditorSelection(this.editor, this.state)]);
  }
}

function visualHeadAfterMotion(editor: VimEditorCapabilities, state: VisualState, motion: Motion): Position {
  const head = applyMotion(editor, state.head, motion, 1);
  if (motion.type === "nextWordStart" && head.row === state.head.row && head.column > state.head.column) {
    const line = editor.line(head.row);
    if (head.column > 0 && /\s/.test(line[head.column - 1])) {
      return { row: head.row, column: head.column - 1 };
    }
  }
  return head;
}

function visualStateToEditorSelection(editor: VimEditorCapabilities, state: VisualState): VimSelection {
  if (isForwardVisualState(state)) {
    return {
      type: "charwise",
      anchor: state.anchor,
      head: exclusiveVisualHead(editor, state.head),
    };
  }

  return {
    type: "charwise",
    anchor: exclusiveVisualHead(editor, state.anchor),
    head: state.head,
  };
}

function visualDeleteRange(editor: VimEditorCapabilities, state: VisualState): TextRange {
  if (isForwardVisualState(state)) {
    return {
      start: state.anchor,
      end: exclusiveVisualHead(editor, state.head),
    };
  }

  return {
    start: state.head,
    end: exclusiveVisualHead(editor, state.anchor),
  };
}

function isForwardVisualState(state: VisualState): boolean {
  return comparePositions(state.anchor, state.head) <= 0;
}

function exclusiveVisualHead(editor: VimEditorCapabilities, head: Position): Position {
  const lineLength = editor.lineLength(head.row);
  if (lineLength === 0) return head;
  return { row: head.row, column: Math.min(head.column + 1, lineLength) };
}
