// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/convert.rs
// - translated concepts: first normal-mode opposite-case conversion for `~`
// - intentional differences: this slice only handles simple model-buffer characterwise
//   normal-mode conversion; motion/object/visual conversions remain future work.

import { VimEditorCapabilities, normalCursorPosition, rangeText } from "../editor.js";
import type { OperatorTarget } from "../operator_target.js";
import { TextEdit, TextRange, VimSelection, charwiseSelection, selectionHead } from "../state.js";

export type ConvertTarget = "lower" | "upper" | "toggle" | "rot13";

// Zed: `normal::convert::Vim::convert_motion` / `convert_object`; one
// application for every convert target source (motion, object, line, visual).
export function applyConvert(
  editor: VimEditorCapabilities,
  target: ConvertTarget,
  operatorTarget: OperatorTarget
): void {
  switch (operatorTarget.kind) {
    case "charwise":
      // Vim `:h gu`: the cursor is left at the start of the operated text.
      convertRanges(editor, operatorTarget.targets.map(({ range }) => range), target);
      return;
    case "linewise": {
      const ranges = operatorTarget.rows.map(({ startRow, endRow }) => ({
        start: { row: startRow, column: 0 },
        end: { row: endRow, column: editor.lineLength(endRow) },
      }));
      // Vim: linewise conversion keeps the cursor column on the first
      // operated row (clamped), like other linewise operations.
      convertRanges(editor, ranges, target, (range, index) =>
        normalCursorPosition(editor, { row: range.start.row, column: operatorTarget.rows[index].column }));
      return;
    }
  }
}

// Zed: `normal::convert::Vim::convert_motion` with `ConvertTarget::OppositeCase`.
export function toggleCaseCharacters(editor: VimEditorCapabilities, count: number): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];

  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const line = editor.line(head.row);
    // Vim: the count is in characters; astral characters span two UTF-16
    // columns (`4~` over `C😀é1` toggles all four characters).
    let endColumn = head.column;
    for (let index = 0; index < count && endColumn < line.length; index++) {
      const code = line.charCodeAt(endColumn);
      endColumn += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    }
    if (head.column >= endColumn) {
      selectionsAfter.push(charwiseSelection(head));
      continue;
    }

    const text = editor.line(head.row).slice(head.column, endColumn);
    edits.push({
      range: { start: head, end: { row: head.row, column: endColumn } },
      text: toggleCase(text),
    });
    selectionsAfter.push(charwiseSelection(normalCursorPosition(editor, {
      row: head.row,
      column: endColumn,
    })));
  }

  editor.applyEdits(edits, selectionsAfter);
}

export function convertRanges(
  editor: VimEditorCapabilities,
  ranges: readonly TextRange[],
  target: ConvertTarget,
  cursorForRange: (range: TextRange, index: number) => TextRange["start"] = range => range.start
): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  ranges.forEach((range, index) => {
    edits.push({ range, text: convertText(rangeText(editor, range), target) });
    selectionsAfter.push(charwiseSelection(cursorForRange(range, index)));
  });
  editor.applyEdits(edits, selectionsAfter);
}

function convertText(text: string, target: ConvertTarget): string {
  switch (target) {
    case "lower":
      return text.toLocaleLowerCase();
    case "upper":
      return text.toLocaleUpperCase();
    case "toggle":
      return toggleCase(text);
    case "rot13":
      return rot13(text);
  }
}

// Vim `g?`: ROT13 encoding over ASCII letters only.
function rot13(text: string): string {
  return [...text].map(char => {
    if (char >= "a" && char <= "z") {
      return String.fromCharCode(((char.charCodeAt(0) - 97 + 13) % 26) + 97);
    }
    if (char >= "A" && char <= "Z") {
      return String.fromCharCode(((char.charCodeAt(0) - 65 + 13) % 26) + 65);
    }
    return char;
  }).join("");
}

function toggleCase(text: string): string {
  return [...text].map(toggleCaseCharacter).join("");
}

function toggleCaseCharacter(char: string): string {
  const lower = char.toLocaleLowerCase();
  const upper = char.toLocaleUpperCase();
  if (lower === upper) return char;
  return char === lower ? upper : lower;
}
