// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/change_list.rs and editor::ChangeList usage
// - translated concepts: grouped change-list positions and g; / g, navigation
// - intentional differences: this local model stores one primary model position per
//   changed row group. Zed stores editor anchors for all selections over the display map.

import { VimEditorCapabilities } from "../editor.js";
import { Position, selectionHead } from "../state.js";

export type ChangeListDirection = "older" | "newer";

export class ChangeListState {
  private positions: Position[] = [];
  private nextIndex = 0;

  record(editor: VimEditorCapabilities, { insertMode }: { insertMode: boolean }): void {
    const head = selectionHead(editor.getSelections()[0]);
    const position = insertMode ? saturatingLeft(editor, head) : head;
    const previous = this.positions[this.positions.length - 1];
    if (previous !== undefined && previous.row === position.row) {
      this.positions[this.positions.length - 1] = position;
    } else {
      this.positions.push(position);
    }
    this.nextIndex = this.positions.length;
  }

  move(count: number, direction: ChangeListDirection): Position | undefined {
    if (this.positions.length === 0) return undefined;
    switch (direction) {
      case "older":
        this.nextIndex = Math.max(0, this.nextIndex - count);
        break;
      case "newer":
        this.nextIndex = Math.min(this.positions.length - 1, this.nextIndex + count);
        break;
    }
    return this.positions[this.nextIndex];
  }
}

function saturatingLeft(editor: VimEditorCapabilities, position: Position): Position {
  if (position.column > 0) return { row: position.row, column: position.column - 1 };
  if (position.row > 0) return { row: position.row - 1, column: editor.lineLength(position.row - 1) };
  return position;
}
