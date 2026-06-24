// Zed reference:
// - sources: crates/vim/src/normal.rs and crates/vim/src/motion.rs
// - translated concepts: a normal-mode handler that turns movement keys into
//   cursor movement actions and supports a first delete-operator slice.

import type { VimEditorCapabilities } from "./editor.js";
import type { HandleResult, HandlerState } from "./key_handler.js";
import {
  Handler,
  cloneHandlerState,
  combineHandleResults,
  effect,
  handler,
  invalid,
  mapHandler,
  prefixedHandler,
  unhandled,
} from "./key_handler.js";
import type { MotionResult } from "./motion.js";
import { motionForKey } from "./motion.js";
import { motionHandler } from "./motion_handler.js";
import {
  applyOperatorToTarget,
  lineOperatorTarget,
  operatorTarget,
} from "./operator_target.js";
import { charwiseSelection, selectionHead } from "./state.js";

type NormalModeAction = (state: HandlerState) => HandleResult<void>;

type NormalModeChord = {
  chords: readonly string[];
  action: NormalModeAction;
};

const normalModeChords: readonly NormalModeChord[] = [
  { chords: ["d", "d"], action: deleteLineAction },
];

export function normalModeMovementHandler(): Handler<void> {
  return (key, state) => {
    state.mode = "normal";

    return combineHandleResults([
      handleFixedChord([key], state),
      prefixedHandler("d", deleteByMotionAction)(key, state),
      movementHandler(key, state),
    ]);
  };
}

export function movementHandler(key: string, state: HandlerState): HandleResult<void> {
  return mapHandler(
    motionHandler((state) => {
      const selections = state.editor?.getSelections() ?? [];
      return {
        starts: selections.map(selectionHead),
        goal: selections[0]?.goal,
      };
    }),
    (results, state) => {
      const editor = state.editor;
      if (editor === undefined) return;
      applyMotionResults(editor, results);
    }
  )(key, state);
}

function handleFixedChord(
  keys: readonly string[],
  state: HandlerState
): HandleResult<void> {
  const chord = normalModeChords.find(
    ({ chords }) =>
      chords.length === keys.length &&
      chords.every((key, index) => key === keys[index])
  );
  if (chord !== undefined) return chord.action(state);

  const hasLongerChord = normalModeChords.some(
    ({ chords }) =>
      keys.length < chords.length &&
      keys.every((key, index) => key === chords[index])
  );
  return hasLongerChord
    ? handler([
        {
          handler: (key, handlerState) =>
            handleFixedChord([...keys, key], handlerState),
          state: {
            ...cloneHandlerState(state),
            operatorDepth: state.operatorDepth + 1,
          },
        },
      ])
    : unhandled();
}

function deleteLineAction(state: HandlerState): HandleResult<void> {
  const editor = state.editor;
  const registers = state.registers;
  if (editor === undefined || registers === undefined) return invalid();
  return effect(state.mode, () => {
    applyOperatorToTarget(
      editor,
      registers,
      state.register,
      { type: "delete" },
      lineOperatorTarget(editor, state.repeat)
    );
  });
}

function deleteByMotionAction(
  key: string,
  state: HandlerState
): HandleResult<void> {
  const editor = state.editor;
  const registers = state.registers;
  if (editor === undefined || registers === undefined) return invalid();
  const motion = motionForKey(key);
  if (motion === undefined) return invalid();
  return effect(state.mode, () => {
    applyOperatorToTarget(
      editor,
      registers,
      state.register,
      { type: "delete" },
      operatorTarget(editor, motion, state.repeat)
    );
  });
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
