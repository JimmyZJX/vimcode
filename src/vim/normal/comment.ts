// vim-commentary / VSCodeVim `gc`/`gC`: toggle line or block comments over an
// operator target. Like VSCodeVim, the actual commenting is delegated to the
// host's native, language-aware commands (`editor.action.commentLine` /
// `editor.action.blockComment`); the model core cannot know comment syntax.
// The flow is: select the target, run the native toggle, then restore the
// cursor once the (asynchronous) command completes via the
// [NativeCommandOptions.selectionsAfter] hook.

import { VimEditorCapabilities } from "../editor.js";
import type { ResolvedTarget } from "../operator_target.js";
import { Position, VimSelection, charwiseSelection, selectionHead } from "../state.js";

export function applyComment(
  editor: VimEditorCapabilities,
  target: ResolvedTarget,
  { block, cursorsAfter }: { block: boolean; cursorsAfter?: readonly Position[] }
): void {
  const selections = commentSelections(editor, target);
  if (selections.length === 0) return;
  const restore = (cursorsAfter ?? editor.getSelections().map(selectionHead)).map(cursor =>
    charwiseSelection(cursor)
  );
  editor.setSelections(selections);
  editor.executeNativeCommand(
    block ? "editor.action.blockComment" : "editor.action.commentLine",
    [],
    { selectionsAfter: restore }
  );
}

// The host selections the native toggle should operate on: whole lines for the
// linewise `gc` (a selection touching a row comments that row), the exact
// range for the charwise `gC` (block comments wrap the selection).
function commentSelections(editor: VimEditorCapabilities, target: ResolvedTarget): VimSelection[] {
  switch (target.kind) {
    case "linewise":
      return target.rows.map(({ startRow, endRow }) => {
        const first = Math.min(startRow, endRow);
        const last = Math.max(startRow, endRow);
        return {
          type: "charwise",
          anchor: { row: first, column: 0 },
          head: { row: last, column: editor.lineLength(last) },
        };
      });
    case "charwise":
      return target.targets.flatMap(({ range, cancelled }) =>
        cancelled === true || (range.start.row === range.end.row && range.start.column === range.end.column)
          ? []
          : [{ type: "charwise" as const, anchor: range.start, head: range.end }]
      );
  }
}
