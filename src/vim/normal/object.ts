// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/normal.rs normal_object
// - translated concepts: the paragraph-object cancellation rule consumed by
//   `textObjectOperatorTarget`; the operator dispatch itself lives in
//   operator_target.ts.

import { VimEditorCapabilities } from "../editor.js";
import { Position, TextRange } from "../state.js";

// Zed: `normal_object`'s paragraph special case — `ap` on a trailing blank
// run at end of file fails without editing.
export function paragraphObjectCancelled(
  editor: VimEditorCapabilities,
  head: Position,
  range: TextRange,
  { around }: { around: boolean }
): boolean {
  return around
    && range.start.row === range.end.row
    && range.start.column === range.end.column
    && editor.line(head.row).trim().length === 0
    && endOfParagraph(editor, head.row) === editor.lineCount() - 1;
}

function endOfParagraph(editor: VimEditorCapabilities, row: number): number {
  const currentIsBlank = editor.line(row).trim().length === 0;
  for (let current = row + 1; current < editor.lineCount(); current++) {
    if ((editor.line(current).trim().length === 0) !== currentIsBlank) return current - 1;
  }
  return editor.lineCount() - 1;
}
