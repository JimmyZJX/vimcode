// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/vim.rs, crates/vim/src/test/vim_test_context.rs
// - translated concepts: editor operations are mediated through a testable host interface
// - intentional differences: VSCode and fake editors implement this capability interface directly

import {
  CursorStyle,
  Position,
  TextEdit,
  TextRange,
  VimSelection,
  charwiseSelection,
  comparePositions,
  orderedRange,
  position,
} from "./state.js";

// Zed: `vim::Vim::update_editor` is the closest
// equivalent boundary, but it closes over Zed's concrete `Editor`. This interface
// is intentionally local: production VSCode and fake tests both implement it.
export interface VimEditorCapabilities {
  lineCount(): number;
  line(row: number): string;
  lineLength(row: number): number;
  getText(range?: TextRange): string;

  getSelections(): readonly VimSelection[];
  setSelections(selections: readonly VimSelection[]): void;
  setCursorStyle(style: CursorStyle): void;

  applyEdits(edits: readonly TextEdit[], selectionsAfter: readonly VimSelection[]): void;

  readClipboard(): string;
  writeClipboard(text: string): void;
}

// Zed: clipping is usually handled by display-map/editor helpers such as
// `DisplaySnapshot::clip_point` / display-map helpers, for example in
// `normal::delete::Vim::delete_motion`.
export function clipPosition(editor: VimEditorCapabilities, pos: Position): Position {
  const row = Math.max(0, Math.min(pos.row, editor.lineCount() - 1));
  const column = Math.max(0, Math.min(pos.column, editor.lineLength(row)));
  return { row, column };
}

// Zed: normal-mode cursor fixups appear throughout operator implementations,
// e.g. `normal::delete::Vim::delete_motion` after delete motions.
export function normalCursorPosition(
  editor: VimEditorCapabilities,
  pos: Position
): Position {
  const clipped = clipPosition(editor, pos);
  const lineLength = editor.lineLength(clipped.row);
  if (lineLength === 0) return { row: clipped.row, column: 0 };
  return { row: clipped.row, column: Math.min(clipped.column, lineLength - 1) };
}

export function rangeText(editor: VimEditorCapabilities, range: TextRange): string {
  return editor.getText(range);
}

// Zed: `test::vim_test_context::VimTestContext` and
// `test::neovim_backed_test_context::NeovimBackedTestContext`
// motivate this fake editor. It is not a port of either; it is the local host
// implementation used for capability-interface tests.
export class InMemoryVimEditor implements VimEditorCapabilities {
  private lines: string[];
  private selections: VimSelection[];
  private clipboard = "";
  public cursorStyle: CursorStyle = "block";

  constructor(text = "") {
    this.lines = text.split("\n");
    this.selections = [charwiseSelection(position(0, 0))];
  }

  lineCount(): number {
    return this.lines.length;
  }

  line(row: number): string {
    return this.lines[row] ?? "";
  }

  lineLength(row: number): number {
    return this.line(row).length;
  }

  getText(range?: TextRange): string {
    if (range === undefined) return this.lines.join("\n");
    const start = clipPosition(this, range.start);
    const end = clipPosition(this, range.end);
    const ordered = orderedRange(start, end);
    if (ordered.start.row === ordered.end.row) {
      return this.line(ordered.start.row).slice(ordered.start.column, ordered.end.column);
    }

    const parts = [this.line(ordered.start.row).slice(ordered.start.column)];
    for (let row = ordered.start.row + 1; row < ordered.end.row; row++) {
      parts.push(this.line(row));
    }
    parts.push(this.line(ordered.end.row).slice(0, ordered.end.column));
    return parts.join("\n");
  }

  getSelections(): readonly VimSelection[] {
    return this.selections;
  }

  setSelections(selections: readonly VimSelection[]): void {
    if (selections.length === 0) {
      throw new Error("Vim selections cannot be empty");
    }
    this.selections = selections.map((selection) => {
      switch (selection.type) {
        case "charwise":
          return {
            ...selection,
            anchor: clipPosition(this, selection.anchor),
            head: clipPosition(this, selection.head),
          };
        case "linewise":
          return {
            ...selection,
            anchorLine: clipPosition(this, position(selection.anchorLine, 0)).row,
            headLine: clipPosition(this, position(selection.headLine, 0)).row,
            cursor: selection.cursor === undefined ? undefined : clipPosition(this, selection.cursor),
          };
        case "blockwise":
          return {
            ...selection,
            anchor: clipPosition(this, selection.anchor),
            head: clipPosition(this, selection.head),
            cursor: selection.cursor === undefined ? undefined : clipPosition(this, selection.cursor),
          };
      }
    });
  }

  setCursorStyle(style: CursorStyle): void {
    this.cursorStyle = style;
  }

  applyEdits(edits: readonly TextEdit[], selectionsAfter: readonly VimSelection[]): void {
    const sortedEdits = [...edits].sort((a, b) => -comparePositions(a.range.start, b.range.start));
    for (const edit of sortedEdits) {
      this.replace(edit.range, edit.text);
    }
    this.setSelections(selectionsAfter);
  }

  readClipboard(): string {
    return this.clipboard;
  }

  writeClipboard(text: string): void {
    this.clipboard = text;
  }

  private replace(range: TextRange, text: string): void {
    const ordered = orderedRange(clipPosition(this, range.start), clipPosition(this, range.end));
    const before = this.line(ordered.start.row).slice(0, ordered.start.column);
    const after = this.line(ordered.end.row).slice(ordered.end.column);
    const replacementLines = (before + text + after).split("\n");
    this.lines.splice(
      ordered.start.row,
      ordered.end.row - ordered.start.row + 1,
      ...replacementLines
    );
  }
}
