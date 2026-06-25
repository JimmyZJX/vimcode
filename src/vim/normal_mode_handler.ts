// Zed reference:
// - sources: crates/vim/src/normal.rs and crates/vim/src/motion.rs
// - translated concepts: the normal-mode key grammar as a typed, pure handler
//   graph. Count/register are handled by the shared [prefixHandler]; motions
//   resolve through [motionHandler]/[resolveMotion]; operators apply through
//   [operator_target]. Editor, registers, and Vim-level effects travel in
//   [HandlerState], so handlers stay pure `(key, state) => result` with no
//   injected dependencies.

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
  unhandled,
} from "./key_handler.js";
import type { FindMotion, Motion, MotionResult } from "./motion.js";
import { applyMotion, lineRange, motionForKey } from "./motion.js";
import { motionHandler } from "./motion_handler.js";
import { prefixHandler } from "./prefix_handlers.js";
import {
  OperatorTarget,
  RangeOperator,
  applyOperatorToTarget,
  lineOperatorTarget,
  operatorTarget,
  rowOperatorTarget,
  textObjectOperatorTarget,
} from "./operator_target.js";
import { textObjectForKey, textObjectRange } from "./object.js";
import { addSurrounds, changeSurrounds, deleteSurrounds } from "./surrounds.js";
import { TextRange, charwiseSelection, selectionHead } from "./state.js";

// The full normal-mode grammar: the count/register prefix wrapping the raw
// grammar (operators + motions).
export function normalModeHandler(): Handler<void> {
  return prefixHandler(rawNormalModeHandler());
}

function rawNormalModeHandler(): Handler<void> {
  return (key, state) =>
    combineHandleResults([
      operatorRootHandler(key, state),
      movementHandler(key, state),
    ]);
}

// ---------------------------------------------------------------------------
// Motions
// ---------------------------------------------------------------------------

// Key -> motion, including the count-sensitive `%` (match-pair without a count,
// go-to-percentage with one). Char-input motions (`f`/`t`), line targets
// (`G`/`gg`), and marks are resolved by their own grammar arms, not here.
function resolveMotion(key: string, state: HandlerState): Motion | undefined {
  if (key === "%") {
    return state.hasCount === true
      ? { type: "goToPercentage", percent: state.repeat }
      : { type: "matching" };
  }
  return motionForKey(key);
}

// A bare cursor-motion handler, exported for reuse. Returns unhandled for any
// key that is not a motion the framework owns for plain movement.
export function movementHandler(key: string, state: HandlerState): HandleResult<void> {
  const motion = resolveMotion(key, state);
  if (motion === undefined) return unhandled();
  return mapHandler(
    motionHandlerForMotion(motion),
    (results, state) => {
      const editor = state.editor;
      if (editor === undefined) return;
      applyMotionResults(editor, results);
    }
  )(key, state);
}

// Wrap a resolved [Motion] in a [motionHandler]-style effect over the live
// selections. Unlike [motionHandler] (which re-resolves the key), this uses the
// already-resolved motion so count-sensitive keys (`%`) move correctly.
function motionHandlerForMotion(motion: Motion): Handler<readonly MotionResult[]> {
  // [motionHandler] resolves the key itself via [motionForKey]; for `%` with a
  // count we need go-to-percentage instead, so resolve through the effect with
  // the motion we already computed.
  if (motion.type === "goToPercentage") {
    return (_key, state) =>
      effect(state.mode, () => {
        const editor = state.editor;
        if (editor === undefined) return [];
        return editor.getSelections().map((selection) => {
          const start = selectionHead(selection);
          return { position: applyMotion(editor, start, motion, state.repeat), goal: undefined };
        });
      });
  }
  return motionHandler((state) => {
    const selections = state.editor?.getSelections() ?? [];
    return {
      starts: selections.map(selectionHead),
      goal: selections[0]?.goal,
    };
  });
}

function applyMotionResults(editor: VimEditorCapabilities, results: readonly MotionResult[]): void {
  editor.setSelections(
    results.map(({ position, goal }) => {
      const selection = charwiseSelection(position);
      return goal === undefined ? selection : { ...selection, goal };
    })
  );
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

type OperatorSpec = {
  key: string;
  operator: RangeOperator;
  // `c`: expand `cw` to `ce`, and (with text objects) use change-specific
  // cancellation; also enters insert mode after applying.
  forChange: boolean;
};

function operatorForKey(key: string): OperatorSpec | undefined {
  switch (key) {
    case "d":
      return { key, operator: { type: "delete" }, forChange: false };
    case "c":
      return { key, operator: { type: "change" }, forChange: true };
    case "y":
      return { key, operator: { type: "yank" }, forChange: false };
    case ">":
      return { key, operator: { type: "indent", direction: "in" }, forChange: false };
    case "<":
      return { key, operator: { type: "indent", direction: "out" }, forChange: false };
    case "=":
      return { key, operator: { type: "indent", direction: "auto" }, forChange: false };
    default:
      return undefined;
  }
}

// Claims an operator key from a clean state and continues into the operand
// grammar (the operand owns its own count via [prefixHandler]).
function operatorRootHandler(key: string, state: HandlerState): HandleResult<void> {
  const spec = operatorForKey(key);
  if (spec === undefined) return unhandled();
  // Pending-depth: the operator's own count (typed before it) folds into the
  // operator entry rather than adding a level (`2d` is one entry). A fresh
  // operand count typed after the operator is its own entry.
  const operatorDepth = state.hasCount === true ? state.operatorDepth : state.operatorDepth + 1;
  return handler([
    {
      handler: prefixHandler(operandHandler(spec)),
      state: { ...cloneHandlerState(state), operatorDepth },
    },
  ]);
}

// The operand grammar after an operator: doubled key (linewise), text objects
// (`i`/`a`), forced motions (`v`/`V`), char-input find (`f`/`t`/`F`/`T`), marks
// (`` ` ``/`'`), line targets (`G`/`gg`), and plain motions. Any unrecognized
// key cancels the operator (`invalid`).
function operandHandler(spec: OperatorSpec): Handler<void> {
  return (key, state) => {
    const editor = state.editor;
    const registers = state.registers;
    if (editor === undefined || registers === undefined) return invalid();

    // Doubled operator key: linewise on [repeat] lines (`dd`/`cc`/`yy`/`>>`).
    if (key === spec.key) {
      return applyOperator(spec, state, lineOperatorTarget(editor, state.repeat));
    }

    // Text objects: `i`/`a` then the object key.
    if (key === "i" || key === "a") {
      return handler([{ handler: objectHandler(spec, key === "a"), state: deeper(state) }]);
    }

    // Surround (`ys`/`ds`/`cs`): `s` after the operator.
    if (key === "s") {
      return startSurround(spec, state);
    }

    // Forced motions: `v` (charwise) / `V` (linewise) then a (counted) motion.
    if (key === "v" || key === "V") {
      return handler([
        {
          handler: prefixHandler(motionOperand(spec, key === "V" ? "linewise" : "charwise")),
          state: deeper(state),
        },
      ]);
    }

    // `G`: linewise to the last line (or line N with a count). It is a row
    // target rather than a `Motion`, so it is handled here, not in the motion
    // grammar.
    if (key === "G") {
      return applyOperator(spec, state, rowOperatorTarget(editor, lineTargetRow(state)));
    }

    // Everything else is a motion: single keys (incl. `%`), char-input find
    // (`f`/`t`/`F`/`T`), marks (`` ` ``/`'`), `g`-chords (`gg`/`gM`/`ge`/...),
    // and `]`/`[` bracket motions. Unrecognized keys cancel the operator.
    return motionOperand(spec, undefined)(key, state);
  };
}

function objectHandler(spec: OperatorSpec, around: boolean): Handler<void> {
  return (key, state) => {
    const editor = state.editor;
    if (editor === undefined) return invalid();
    const object = textObjectForKey(key);
    if (object === undefined) return invalid();
    return applyOperator(
      spec,
      state,
      textObjectOperatorTarget(editor, object, { around, count: state.repeat, forChange: spec.forChange })
    );
  };
}

// Operand motion grammar for an operator, applying the operator to the resolved
// motion's target. [forced] applies a forced-motion override (`dvj`/`dVj`).
function motionOperand(spec: OperatorSpec, forced: "charwise" | "linewise" | undefined): Handler<void> {
  return motionChordHandler((motion, state) => {
    const editor = state.editor;
    if (editor === undefined) return invalid();
    return applyOperator(
      spec,
      state,
      operatorTarget(editor, motion, state.repeat, { forcedMotion: forced, forChange: spec.forChange })
    );
  });
}

// Parses one motion — single key, char-input find, mark, `g`-chord, or `]`/`[`
// bracket motion — and hands the resolved [Motion] to [apply]. Used for both
// operator operands and forced-motion operands.
function motionChordHandler(
  apply: (motion: Motion, state: HandlerState) => HandleResult<void>
): Handler<void> {
  return (key, state) => {
    if (state.editor === undefined) return invalid();

    // Char-input find motions (`f`/`t`/`F`/`T`) then the target char.
    const findKind = findKindForKey(key);
    if (findKind !== undefined) {
      return handler([
        {
          handler: (char, charState) =>
            char.length === 1 ? apply(findMotionForChar(findKind, char), charState) : invalid(),
          state: { ...deeper(state), awaitingCharInput: true },
        },
      ]);
    }

    // Marks (`` `a ``/`'a`) then the mark name.
    if (key === "`" || key === "'") {
      const line = key === "'";
      return handler([
        {
          handler: (name, markState) => {
            const motion = markState.actions?.markMotion(name, { line });
            return motion === undefined ? invalid() : apply(motion, markState);
          },
          state: { ...deeper(state), awaitingCharInput: true },
        },
      ]);
    }

    // `g`-chord motions (`gg`/`g_`/`gM`/`ge`/`gE`/`gj`/`gk`).
    if (key === "g") {
      return handler([
        {
          handler: (key2, gState) => {
            const motion = gChordMotion(key2);
            return motion === undefined ? invalid() : apply(motion, gState);
          },
          state: deeper(state),
        },
      ]);
    }

    // `]`/`[` bracket motions (`]}`/`])`/`[{`/`[(`).
    if (key === "]" || key === "[") {
      const bracket = key;
      return handler([
        {
          handler: (key2, bracketState) => {
            const motion = bracketMotion(bracket, key2);
            return motion === undefined ? invalid() : apply(motion, bracketState);
          },
          state: deeper(state),
        },
      ]);
    }

    // Single-key motions (incl. count-sensitive `%`).
    const motion = resolveMotion(key, state);
    if (motion !== undefined) return apply(motion, state);
    return invalid();
  };
}

// `g`-chord motions usable as operator operands. Non-motion `g`-chords (convert,
// tabs, ...) are not operands and resolve to undefined (cancel).
function gChordMotion(key: string): Motion | undefined {
  switch (key) {
    case "g":
      // `gg`: go to the first line (or line N with a count); [operatorTarget]
      // resolves [startOfDocument] linewise with the count.
      return { type: "startOfDocument" };
    case "_":
      return { type: "lastNonWhitespace" };
    case "M":
      return { type: "middleOfLine" };
    case "e":
      return { type: "previousWordEnd", bigWord: false };
    case "E":
      return { type: "previousWordEnd", bigWord: true };
    case "j":
      return { type: "down", displayLine: true };
    case "k":
      return { type: "up", displayLine: true };
    default:
      return undefined;
  }
}

function bracketMotion(bracket: string, key: string): Motion | undefined {
  if (bracket === "]" && key === "}") return { type: "unmatchedForward", char: "}" };
  if (bracket === "]" && key === ")") return { type: "unmatchedForward", char: ")" };
  if (bracket === "[" && key === "{") return { type: "unmatchedBackward", char: "{" };
  if (bracket === "[" && key === "(") return { type: "unmatchedBackward", char: "(" };
  return undefined;
}

// Apply an operator to a computed target. For `change`, enter insert mode when
// the change was not cancelled (e.g. `ci"` with no quotes does nothing and stays
// in normal mode).
function applyOperator(spec: OperatorSpec, state: HandlerState, target: OperatorTarget): HandleResult<void> {
  const editor = state.editor;
  const registers = state.registers;
  if (editor === undefined || registers === undefined) return invalid();
  const register = state.register;
  const actions = state.actions;
  return effect(state.mode, () => {
    const outcome = applyOperatorToTarget(editor, registers, register, spec.operator, target);
    if (outcome.enterInsert) actions?.enterInsert({});
  });
}

// `G`/`gg` target row: line N-1 with a count, else the last/first line. (The
// last-line vs first-line distinction is in the caller; this handles `G`.)
function lineTargetRow(state: HandlerState): number {
  const editor = state.editor;
  const lastRow = editor === undefined ? 0 : editor.lineCount() - 1;
  return state.hasCount === true ? Math.max(0, state.repeat - 1) : lastRow;
}

// ---------------------------------------------------------------------------
// Surround (vim-surround: `ys`/`ds`/`cs`)
// ---------------------------------------------------------------------------

type SurroundTarget = { ranges: readonly TextRange[]; linewise: boolean };

// `s` after an operator: add (`ys`), delete (`ds`), or change (`cs`) surrounds.
function startSurround(spec: OperatorSpec, state: HandlerState): HandleResult<void> {
  switch (spec.operator.type) {
    case "yank":
      // `ys`: capture a range (motion/object/`yss` line), then the pair char.
      return handler([{ handler: prefixHandler(addSurroundRangeHandler()), state: deeper(state) }]);
    case "delete":
      // `ds{char}`: delete the surrounding pair named by the next char.
      return handler([
        { handler: deleteSurroundHandler(), state: { ...deeper(state), awaitingCharInput: true } },
      ]);
    case "change":
      // `cs{from}{to}`: change the `from` pair to the `to` pair.
      return handler([
        { handler: changeSurroundHandler(undefined), state: { ...deeper(state), awaitingCharInput: true } },
      ]);
    default:
      return invalid();
  }
}

// `ys` range capture: a motion, a text object (`ysiw`), or doubling `s` for the
// trimmed current line (`yss`). Resolves to the pair-char waiter.
function addSurroundRangeHandler(): Handler<void> {
  return (key, state) => {
    const editor = state.editor;
    if (editor === undefined) return invalid();
    // `yss`: trimmed current line(s).
    if (key === "s") {
      const ranges = editor.getSelections().map((selection) =>
        trimmedLineRange(editor, selectionHead(selection).row, state.repeat)
      );
      return surroundPairWaiter(state, { ranges, linewise: false });
    }
    // `ysiw` / `ysaw` etc.: text object range.
    if (key === "i" || key === "a") {
      return handler([{ handler: addSurroundObjectHandler(key === "a"), state: deeper(state) }]);
    }
    // `ysw` etc.: motion range.
    const motion = resolveMotion(key, state);
    if (motion !== undefined) {
      const ranges = surroundRangesForTarget(editor, operatorTarget(editor, motion, state.repeat));
      return surroundPairWaiter(state, ranges);
    }
    return invalid();
  };
}

function addSurroundObjectHandler(around: boolean): Handler<void> {
  return (key, state) => {
    const editor = state.editor;
    if (editor === undefined) return invalid();
    const object = textObjectForKey(key);
    if (object === undefined) return invalid();
    const ranges = editor.getSelections().map((selection) =>
      textObjectRange(editor, selectionHead(selection), object, { around, count: state.repeat })
    );
    return surroundPairWaiter(state, { ranges, linewise: false });
  };
}

// Pending continuation that consumes the pair character and applies the add.
function surroundPairWaiter(state: HandlerState, target: SurroundTarget): HandleResult<void> {
  return handler([
    {
      handler: (key, state) => {
        const editor = state.editor;
        if (editor === undefined) return invalid();
        return effect(state.mode, () =>
          addSurrounds(editor, target.ranges, keyForInput(key), { linewise: target.linewise })
        );
      },
      state: { ...deeper(state), awaitingCharInput: true },
    },
  ]);
}

function deleteSurroundHandler(): Handler<void> {
  return (key, state) => {
    const editor = state.editor;
    if (editor === undefined) return invalid();
    return effect(state.mode, () => deleteSurrounds(editor, keyForInput(key)));
  };
}

function changeSurroundHandler(fromKey: string | undefined): Handler<void> {
  return (key, state) => {
    const editor = state.editor;
    if (editor === undefined) return invalid();
    if (fromKey === undefined) {
      return handler([
        {
          handler: changeSurroundHandler(keyForInput(key)),
          state: { ...deeper(state), awaitingCharInput: true },
        },
      ]);
    }
    const from = fromKey;
    return effect(state.mode, () => changeSurrounds(editor, from, keyForInput(key)));
  };
}

function surroundRangesForTarget(editor: VimEditorCapabilities, target: OperatorTarget): SurroundTarget {
  switch (target.kind) {
    case "charwise":
      return { ranges: target.targets.map(({ range }) => range), linewise: false };
    case "linewise":
      return {
        ranges: target.rows.map(({ startRow, endRow }) => ({
          start: { row: startRow, column: 0 },
          end: { row: endRow, column: editor.lineLength(endRow) },
        })),
        linewise: true,
      };
  }
}

function trimmedLineRange(editor: VimEditorCapabilities, row: number, count: number): TextRange {
  const range = lineRange(editor, row, count);
  if (range.start.row !== range.end.row) return range;
  const line = editor.line(row);
  const first = line.search(/\S/);
  if (first < 0) return range;
  const last = line.search(/\s*$/);
  return { start: { row, column: first }, end: { row, column: last } };
}

function keyForInput(key: string): string {
  return key === "space" ? " " : key;
}

// ---------------------------------------------------------------------------
// Find motions (char input)
// ---------------------------------------------------------------------------

type FindKind = "findForward" | "tillForward" | "findBackward" | "tillBackward";

function findKindForKey(key: string): FindKind | undefined {
  switch (key) {
    case "f":
      return "findForward";
    case "t":
      return "tillForward";
    case "F":
      return "findBackward";
    case "T":
      return "tillBackward";
    default:
      return undefined;
  }
}

function findMotionForChar(kind: FindKind, char: string): FindMotion {
  switch (kind) {
    case "findForward":
      return { type: "findForward", before: false, char };
    case "tillForward":
      return { type: "findForward", before: true, char };
    case "findBackward":
      return { type: "findBackward", after: false, char };
    case "tillBackward":
      return { type: "findBackward", after: true, char };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deeper(state: HandlerState): HandlerState {
  return { ...cloneHandlerState(state), operatorDepth: state.operatorDepth + 1 };
}
