// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: `test::neovim_connection::{parse_state, encode_ranges}` and
//   `util::test::{marked_text_ranges, generate_marked_text}`
// - translated concepts: represent editor state as text with inline cursor/selection markers
// - intentional differences: this helper supports the visual marker shapes currently used
//   by enabled fixtures: one cursor, one charwise/linewise visual range, or one rectangular
//   visual-block range. Byte/UTF-8 column fidelity and multiple independent selections are
//   future work.

import { InMemoryVimEditor } from "../editor.js";
import { Vim } from "../vim.js";
import { Position, VimMode, VimSelection, VimSelectionGoal, charwiseSelection, comparePositions, selectionAnchor, selectionHead } from "../state.js";

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
  markedText = markedText.split("•").join(" ");
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
    throw new Error("only single forward visual selections are supported when parsing marked text for now");
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
    return encodeVisualMarkedText(text, { row: anchorRow, column: anchorColumn }, { row, column }, { row, column });
  }
  return insertMarker(text, { row, column }, cursorMarker);
}

export function editorFromMarkedText(markedText: string): { editor: InMemoryVimEditor; vim: Vim } {
  const parsed = parseMarkedText(markedText);
  const editor = new InMemoryVimEditor(parsed.text);
  editor.setSelections(selectionsFromParsedMarkedText(parsed));
  const vim = new Vim(editor);
  if (parsed.mode === "visual") vim.syncFromEditorState();
  return { editor, vim };
}

export function resetEditorFromMarkedText(editor: InMemoryVimEditor, vim: Vim, markedText: string): void {
  const parsed = parseMarkedText(markedText);
  editor.resetForTest(parsed.text, selectionsFromParsedMarkedText(parsed));
  vim.syncFromEditorState();
}

function selectionsFromParsedMarkedText(parsed: ParsedMarkedText): readonly VimSelection[] {
  if (parsed.mode === "visual") {
    return [
      {
        type: "charwise",
        anchor: { row: parsed.anchorRow!, column: parsed.anchorColumn! },
        head: { row: parsed.row, column: parsed.column },
      },
    ];
  }
  return [charwiseSelection({ row: parsed.row, column: parsed.column })];
}

export function markedTextFromEditor(editor: InMemoryVimEditor, mode: VimMode["kind"] = "normal"): string {
  const selection = editor.getSelections()[0];
  const head = selectionHead(selection);
  switch (mode) {
    case "visual": {
      const anchor = selectionAnchor(selection);
      if (selection.type === "charwise" && comparePositions(anchor, head) === 0) {
        return encodeMarkedText({ text: editor.getText(), row: head.row, column: head.column, mode: "normal" });
      }
      const cursorIsLineStartAcrossLines = selection.type === "charwise"
        && selection.cursor !== undefined
        && selection.cursor.column === 0
        && selection.cursor.row !== anchor.row;
      const cursor = cursorIsLineStartAcrossLines ? selection.cursor! : head;
      const end = cursorIsLineStartAcrossLines ? cursor : head;
      return encodeVisualMarkedText(editor.getText(), anchor, end, cursor);
    }
    case "visualLine":
      return selection.type === "linewise"
        ? encodeVisualLineSelectionMarkedText(editor.getText(), selection)
        : encodeVisualLineMarkedText(editor.getText(), head);
    case "visualBlock":
      if (selection.type !== "blockwise") return encodeMarkedText({ text: editor.getText(), row: head.row, column: head.column, mode: "normal" });
      return encodeVisualBlockMarkedText(editor.getText(), selection.anchor, selection.head, selection.goal);
    default:
      return encodeMarkedText({ text: editor.getText(), row: head.row, column: head.column, mode: "normal" });
  }
}

function exactlyOneMarker(text: string, marker: string): number {
  const index = text.indexOf(marker);
  if (index < 0) throw new Error(`marked text must contain ${marker}`);
  if (text.indexOf(marker, index + marker.length) >= 0) {
    throw new Error(`only one ${marker} marker is supported for now`);
  }
  return index;
}

function positionBeforeIndex(text: string, index: number): Position {
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

function encodeVisualMarkedText(text: string, anchor: Position, head: Position, cursor: Position): string {
  const start = comparePositions(anchor, head) <= 0 ? anchor : head;
  const end = comparePositions(anchor, head) <= 0 ? head : anchor;
  return insertMarkers(text, [
    { position: start, marker: visualStartMarker },
    { position: cursor, marker: cursorMarker },
    { position: end, marker: visualEndMarker },
  ]);
}

function encodeVisualLineSelectionMarkedText(text: string, selection: Extract<VimSelection, { type: "linewise" }>): string {
  const cursor = selection.cursor ?? { row: selection.headLine, column: 0 };
  const lines = text.split("\n");
  const selectedLine = lines[selection.headLine] ?? "";
  if (selection.anchorLine !== selection.headLine) {
    const start = { row: Math.min(selection.anchorLine, selection.headLine), column: 0 };
    const end = cursor;
    return insertMarkers(text, [
      { position: start, marker: visualStartMarker },
      { position: cursor, marker: cursorMarker },
      { position: end, marker: visualEndMarker },
    ]);
  }
  if (selectedLine.length === 0) {
    if (selection.headLine + 1 >= lines.length) {
      return insertMarker(text, { row: selection.headLine, column: 0 }, cursorMarker);
    }
    const start = { row: selection.headLine, column: 0 };
    const end = { row: selection.headLine + 1, column: 0 };
    return insertMarkers(text, [
      { position: start, marker: visualStartMarker },
      { position: end, marker: cursorMarker },
      { position: end, marker: visualEndMarker },
    ]);
  }
  return encodeVisualLineMarkedText(text, cursor);
}

function encodeVisualLineMarkedText(text: string, cursor: Position): string {
  const lines = text.split("\n");
  const line = lines[cursor.row] ?? "";
  if (line.length === 0 && cursor.row + 1 < lines.length) {
    const start = { row: cursor.row, column: 0 };
    const end = { row: cursor.row + 1, column: 0 };
    return insertMarkers(text, [
      { position: start, marker: visualStartMarker },
      { position: end, marker: cursorMarker },
      { position: end, marker: visualEndMarker },
    ]);
  }
  const start = { row: cursor.row, column: Math.min(cursor.column, line.length) };
  const end = { row: cursor.row, column: Math.min(start.column + 1, line.length) };
  return insertMarkers(text, [
    { position: start, marker: visualStartMarker },
    { position: end, marker: cursorMarker },
    { position: end, marker: visualEndMarker },
  ]);
}

function encodeVisualBlockMarkedText(text: string, anchor: Position, head: Position, goal?: VimSelectionGoal): string {
  const lines = text.split("\n");
  const startRow = Math.min(anchor.row, head.row);
  const endRow = Math.max(anchor.row, head.row);
  const startColumn = Math.min(anchor.column, head.column);
  const endColumn = Math.max(anchor.column, head.column);
  const cursorAtStart = head.column < anchor.column;
  const markers: { position: Position; marker: string }[] = [];

  for (let row = startRow; row <= endRow; row++) {
    const lineLength = lines[row]?.length ?? 0;
    if (startColumn >= lineLength) {
      if (startColumn === lineLength || row === head.row) {
        markers.push({ position: { row, column: lineLength }, marker: cursorMarker });
      }
      continue;
    }

    const start = { row, column: startColumn };
    const end = { row, column: goal?.type === "endOfLine" ? lineLength : Math.min(endColumn + 1, lineLength) };
    markers.push({ position: start, marker: visualStartMarker });
    markers.push({ position: cursorAtStart ? start : end, marker: cursorMarker });
    markers.push({ position: end, marker: visualEndMarker });
  }

  return insertMarkers(text, markers);
}

function insertMarkers(text: string, markers: readonly { position: Position; marker: string }[]): string {
  const lines = text.split("\n");
  const byRowAndColumn = new Map<string, string[]>();
  for (const { position, marker } of markers) {
    if (position.row < 0 || position.row >= lines.length) {
      throw new Error(`row ${position.row} is outside document with ${lines.length} lines`);
    }
    const line = lines[position.row];
    const column = Math.max(0, Math.min(position.column, line.length));
    const key = `${position.row}:${column}`;
    const existing = byRowAndColumn.get(key) ?? [];
    existing.push(marker);
    byRowAndColumn.set(key, existing);
  }

  for (let row = 0; row < lines.length; row++) {
    const entries = [...byRowAndColumn.entries()]
      .map(([key, markersForPosition]) => {
        const [rawRow, rawColumn] = key.split(":");
        return { row: Number(rawRow), column: Number(rawColumn), markersForPosition };
      })
      .filter(entry => entry.row === row)
      .sort((a, b) => b.column - a.column);
    for (const { column, markersForPosition } of entries) {
      lines[row] = lines[row].slice(0, column) + markersForPosition.join("") + lines[row].slice(column);
    }
  }
  return lines.join("\n");
}

function insertMarker(text: string, pos: Position, marker: string): string {
  return insertMarkers(text, [{ position: pos, marker }]);
}
