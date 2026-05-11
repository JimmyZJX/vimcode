// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: `test::neovim_connection::{parse_state, encode_ranges}` and
//   `util::test::{marked_text_ranges, generate_marked_text}`
// - translated concepts: represent editor state as text with inline cursor markers
// - intentional differences: this first TypeScript helper supports a single `ˇ` cursor
//   marker only. Visual markers and byte/UTF-8 column fidelity are future work.

import { InMemoryVimEditor } from "../editor.js";
import { Vim } from "../vim.js";
import { charwiseSelection, selectionHead } from "../state.js";

export const cursorMarker = "ˇ";

export type ParsedMarkedText = {
  text: string;
  row: number;
  column: number;
};

export function parseMarkedText(markedText: string): ParsedMarkedText {
  const markerIndex = markedText.indexOf(cursorMarker);
  if (markerIndex < 0) {
    throw new Error(`marked text must contain ${cursorMarker}`);
  }
  if (markedText.indexOf(cursorMarker, markerIndex + cursorMarker.length) >= 0) {
    throw new Error("only one cursor marker is supported for now");
  }

  const text = markedText.slice(0, markerIndex) + markedText.slice(markerIndex + cursorMarker.length);
  const beforeMarker = markedText.slice(0, markerIndex);
  const linesBeforeMarker = beforeMarker.split("\n");
  return {
    text,
    row: linesBeforeMarker.length - 1,
    column: linesBeforeMarker[linesBeforeMarker.length - 1].length,
  };
}

export function encodeMarkedText({ text, row, column }: ParsedMarkedText): string {
  const lines = text.split("\n");
  if (row < 0 || row >= lines.length) {
    throw new Error(`row ${row} is outside document with ${lines.length} lines`);
  }
  const line = lines[row];
  const clippedColumn = Math.max(0, Math.min(column, line.length));
  lines[row] = line.slice(0, clippedColumn) + cursorMarker + line.slice(clippedColumn);
  return lines.join("\n");
}

export function editorFromMarkedText(markedText: string): { editor: InMemoryVimEditor; vim: Vim } {
  const parsed = parseMarkedText(markedText);
  const editor = new InMemoryVimEditor(parsed.text);
  editor.setSelections([charwiseSelection({ row: parsed.row, column: parsed.column })]);
  return { editor, vim: new Vim(editor) };
}

export function markedTextFromEditor(editor: InMemoryVimEditor): string {
  const selection = editor.getSelections()[0];
  const head = selectionHead(selection);
  return encodeMarkedText({ text: editor.getText(), row: head.row, column: head.column });
}
