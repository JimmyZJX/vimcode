// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/normal.rs JoinLines / JoinLinesNoWhitespace
// - translated concepts: normal and visual line joining
// - intentional differences: this is a model-buffer implementation and only models
//   the whitespace behavior needed by current fixtures.

import { VimEditorCapabilities } from "../editor.js";
import { charwiseSelection } from "../state.js";

export function joinLines(
  editor: VimEditorCapabilities,
  row: number,
  count: number,
  { insertWhitespace }: { insertWhitespace: boolean }
): void {
  const lineCount = editor.lineCount();
  if (row < 0 || row + 1 >= lineCount) return;

  const lines = editor.getText().split("\n");
  const times = Math.max(1, count);
  const startRow = Math.max(0, Math.min(row, lines.length - 1));
  let cursorColumn = editor.lineLength(startRow);

  for (let index = 0; index < times && startRow + 1 < lines.length; index++) {
    const current = lines[startRow].replace(/\s+$/, "");
    const next = insertWhitespace ? lines[startRow + 1].replace(/^\s+/, "") : lines[startRow + 1];
    cursorColumn = current.length;
    lines.splice(startRow, 2, `${current}${insertWhitespace ? " " : ""}${next}`);
  }

  const lastRow = editor.lineCount() - 1;
  editor.applyEdits(
    [{
      range: {
        start: { row: 0, column: 0 },
        end: { row: lastRow, column: editor.lineLength(lastRow) },
      },
      text: lines.join("\n"),
    }],
    [charwiseSelection({ row: startRow, column: cursorColumn })]
  );
}
