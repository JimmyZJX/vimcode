// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: `test::neovim_connection::{parse_state, encode_ranges}` and
//   `util::test::{marked_text_ranges, generate_marked_text}`
// - translated concepts: represent editor state as text with inline cursor/selection markers
// - intentional differences: this helper supports one cursor or one charwise visual selection.
//   Byte/UTF-8 column fidelity, multiple selections, and visual block markers are future work.

import { InMemoryVimEditor } from "../editor.js";
import { Vim } from "../vim.js";
import { VimMode, charwiseSelection, comparePositions, selectionAnchor, selectionHead } from "../state.js";

export const cursorMarker = "ˇ";
export const visualStartMarker = "«";
export const visualEndMarker = "»";

export type ParsedMarkedText = {
  text: string;
  row: number;
  column: number;
  anchorRow?: number;
  anchorColumn?: number;
  mode: VimMode["kind"];
};

export function parseMarkedText(markedText: string): ParsedMarkedText {
  const cursorIndex = exactlyOneMarker(markedText, cursorMarker);
  const hasVisualStart = markedText.includes(visualStartMarker);
  const hasVisualEnd = markedText.includes(visualEndMarker);
  if (hasVisualStart !== hasVisualEnd) {
    throw new Error("visual marked text must contain both visual markers");
  }

  if (!hasVisualStart) {
    const text = markedText.slice(0, cursorIndex) + markedText.slice(cursorIndex + cursorMarker.length);
    const cursor = positionBeforeIndex(markedText, cursorIndex);
    return { text, row: cursor.row, column: cursor.column, mode: "normal" };
  }

  const visualStartIndex = exactlyOneMarker(markedText, visualStartMarker);
  const visualEndIndex = exactlyOneMarker(markedText, visualEndMarker);
  if (!(visualStartIndex < cursorIndex && cursorIndex < visualEndIndex)) {
    throw new Error("only forward visual selections with cursor inside the visual markers are supported for now");
  }

  const text = markedText
    .replace(visualStartMarker, "")
    .replace(cursorMarker, "")
    .replace(visualEndMarker, "");
  const anchor = positionBeforeIndex(markedText, visualStartIndex);
  const cursor = positionBeforeIndex(markedText, cursorIndex - visualStartMarker.length);
  return {
    text,
    row: cursor.row,
    column: cursor.column,
    anchorRow: anchor.row,
    anchorColumn: anchor.column,
    mode: "visual",
  };
}

export function encodeMarkedText({ text, row, column, anchorRow, anchorColumn, mode }: ParsedMarkedText): string {
  if (mode === "visual" && anchorRow !== undefined && anchorColumn !== undefined) {
    return encodeVisualMarkedText(text, { row: anchorRow, column: anchorColumn }, { row, column });
  }
  return insertMarker(text, { row, column }, cursorMarker);
}

export function editorFromMarkedText(markedText: string): { editor: InMemoryVimEditor; vim: Vim } {
  const parsed = parseMarkedText(markedText);
  const editor = new InMemoryVimEditor(parsed.text);
  editor.setSelections([charwiseSelection({ row: parsed.row, column: parsed.column })]);
  const vim = new Vim(editor);
  if (parsed.mode === "visual") {
    editor.setSelections([
      {
        type: "charwise",
        anchor: { row: parsed.anchorRow!, column: parsed.anchorColumn! },
        head: { row: parsed.row, column: parsed.column },
      },
    ]);
  }
  return { editor, vim };
}

export function markedTextFromEditor(editor: InMemoryVimEditor, mode: VimMode["kind"] = "normal"): string {
  const selection = editor.getSelections()[0];
  const head = selectionHead(selection);
  if (mode === "visual") {
    const anchor = selectionAnchor(selection);
    return encodeVisualMarkedText(editor.getText(), anchor, head);
  }
  return encodeMarkedText({ text: editor.getText(), row: head.row, column: head.column, mode: "normal" });
}

function exactlyOneMarker(text: string, marker: string): number {
  const index = text.indexOf(marker);
  if (index < 0) throw new Error(`marked text must contain ${marker}`);
  if (text.indexOf(marker, index + marker.length) >= 0) {
    throw new Error(`only one ${marker} marker is supported for now`);
  }
  return index;
}

function positionBeforeIndex(text: string, index: number): { row: number; column: number } {
  const beforeMarker = text
    .slice(0, index)
    .split(visualStartMarker).join("")
    .split(visualEndMarker).join("")
    .split(cursorMarker).join("");
  const linesBeforeMarker = beforeMarker.split("\n");
  return {
    row: linesBeforeMarker.length - 1,
    column: linesBeforeMarker[linesBeforeMarker.length - 1].length,
  };
}

function encodeVisualMarkedText(text: string, anchor: { row: number; column: number }, head: { row: number; column: number }): string {
  if (comparePositions(anchor, head) > 0) {
    throw new Error("backward visual selections are not supported by the marked-text encoder yet");
  }
  const withEnd = insertMarker(text, visualEndPosition(text, head), visualEndMarker);
  const withCursor = insertMarker(withEnd, head, cursorMarker);
  return insertMarker(withCursor, anchor, visualStartMarker);
}

function visualEndPosition(text: string, head: { row: number; column: number }) {
  const line = text.split("\n")[head.row] ?? "";
  return { row: head.row, column: Math.min(head.column + 1, line.length) };
}

function insertMarker(text: string, pos: { row: number; column: number }, marker: string): string {
  const lines = text.split("\n");
  if (pos.row < 0 || pos.row >= lines.length) {
    throw new Error(`row ${pos.row} is outside document with ${lines.length} lines`);
  }
  const line = lines[pos.row];
  const clippedColumn = Math.max(0, Math.min(pos.column, line.length));
  lines[pos.row] = line.slice(0, clippedColumn) + marker + line.slice(clippedColumn);
  return lines.join("\n");
}
