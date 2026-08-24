// Zed reference:
// - source: crates/vim/src/motion.rs and assets/keymaps/vim.json
// - translated concepts: key-to-motion parsing as a typed handler that resolves
//   to live MotionResult values instead of editing the editor directly.

import type { VimEditorCapabilities } from "./editor.js";
import { effect, unhandled } from "./key_handler.js";
import type { Handler, HandlerState } from "./key_handler.js";
import type { MotionResult } from "./motion.js";
import { applyMotionWithGoal, motionForKey } from "./motion.js";
import { charwiseSelection } from "./state.js";
import type { Position, VimSelectionGoal } from "./state.js";

// Lower resolved motion results onto the editor selections (the shared tail of
// every cursor-moving handler). A [goal] (target column) is carried through so
// vertical motions keep their desired column.
export function applyMotionResults(
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

export type MotionHandlerInput = {
  starts: readonly Position[];
  goal?: VimSelectionGoal;
  allowEndOfLine?: boolean;
};

export function motionHandler(input: (state: HandlerState) => MotionHandlerInput): Handler<readonly MotionResult[]> {
  return (key, state) => {
    const motion = motionForKey(key);
    const editor = state.editor;
    if (motion === undefined || editor === undefined) return unhandled();
    return effect(state.mode, () => {
      const { starts, goal, allowEndOfLine = false } = input(state);
      return starts.map(start =>
        applyMotionWithGoal(
          editor,
          start,
          motion,
          state.repeat,
          goal,
          { allowEndOfLine }
        ));
    });
  };
}
