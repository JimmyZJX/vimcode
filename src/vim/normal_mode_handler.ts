// Zed reference:
// - sources: crates/vim/src/normal.rs and crates/vim/src/motion.rs
// - translated concepts: a normal-mode handler that turns motion keys into
//   cursor movement actions without handling operators or edits yet.

import type { VimEditorCapabilities } from "./editor.js";
import { Handler, mapHandler, unhandled } from "./key_handler.js";
import type { MotionResult } from "./motion.js";
import { motionHandler } from "./motion_handler.js";
import { charwiseSelection, selectionHead } from "./state.js";

export function normalModeMovementHandler(): Handler<void> {
  return (key, state) => {
    const editor = state.editor;
    state.mode = "normal";
    if (editor === undefined) return unhandled();

    return mapHandler(
      motionHandler(() => {
        const selections = editor.getSelections();
        return {
          starts: selections.map(selectionHead),
          goal: selections[0]?.goal,
        };
      }),
      (results) => applyMotionResults(editor, results)
    )(key, state);
  };
}

function applyMotionResults(
  editor: VimEditorCapabilities,
  results: readonly MotionResult[]
): void {
  editor.setSelections(
    results.map(({ position, goal }) => {
      const selection = charwiseSelection(position);
      return goal === undefined ? selection : { ...selection, goal };
    })
  );
}
