// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/motion.rs (`Motion::range`, `MotionKind`) and
//   crates/vim/src/normal.rs (`normal_motion` / `normal_object` operator dispatch)
// - translated concepts: every range-consuming operator goes through one target
//   producer (which owns linewise/inclusive/forced-motion semantics) and one
//   operator dispatch over targets.
// - intentional differences: Zed's targets are the editor's live anchored
//   selections (`Motion::expand_selection` mutates them); `OperatorTarget` is an
//   immutable model-coordinate value so application modules stay testable and
//   host-independent. See doc/operator-redesign.md.

import { VimEditorCapabilities } from "./editor.js";
import {
  Motion,
  applyMotion,
  changeMotionRange,
  firstNonWhitespaceColumn,
  hostViewLineSelectionsForMotion,
  motionRange,
} from "./motion.js";
import { applyChange } from "./normal/change.js";
import { ConvertTarget, applyConvert } from "./normal/convert.js";
import { applyDelete } from "./normal/delete.js";
import { IndentDirection, applyIndent } from "./normal/indent.js";
import { paragraphObjectCancelled } from "./normal/object.js";
import { applyYank } from "./normal/yank.js";
import { TextObject, blankLineAroundWordRows, surroundObjectFound, textObjectRange } from "./object.js";
import type { ForcedMotion } from "./operator.js";
import { RegisterName, Registers } from "./registers.js";
import { Position, TextRange, selectionHead } from "./state.js";

export type RowRange = {
  startRow: number;
  endRow: number;
  /** Cursor column to restore after the operation. */
  column: number;
  /** Cursor-after-delete override for targets whose cursor rule is
      source-specific (visual linewise deletes clamp against the line that
      follows the deleted range); when absent, the application module's
      default rule applies. */
  cursor?: Position;
};

export type CharwiseTarget = {
  range: TextRange;
  /** The cursor position the target was produced from. Application modules use
      it for cursor-after-operation rules (e.g. yank keeps the cursor in place
      unless the range starts before it; `:h quote_quote` cursor semantics). */
  head: Position;
  /** Cursor-after-delete override for targets whose cursor rule is
      object-specific (paragraph deletes); when absent, the application
      module's default rule applies. */
  cursor?: Position;
  /** Vim: some objects fail without producing an edit (`cap` on a trailing
      blank line); a cancelled target keeps the cursor in place and suppresses
      insert-mode entry for change. */
  cancelled?: boolean;
};

// Zed: `MotionKind` survives into operator application; locally inclusivity is
// resolved into concrete range extents at target production, so only
// charwise/linewise remain. A blockwise variant is reserved for the visual-block
// fold-in.
export type OperatorTarget =
  | { kind: "charwise"; targets: readonly CharwiseTarget[] }
  | { kind: "linewise"; rows: readonly RowRange[] };

// Zed: `state::Operator`, restricted to the operators that consume a
// motion/object/line/visual-derived range.
export type RangeOperator =
  | { type: "delete" }
  | { type: "change" }
  | { type: "yank" }
  | { type: "convert"; target: ConvertTarget }
  | { type: "indent"; direction: IndentDirection };

export type OperatorOutcome = { enterInsert: boolean };

// Zed: `motion::Motion::range` deciding `MotionKind::Linewise`. Per-motion
// linewise metadata is declared here and nowhere else.
function isLinewiseMotion(motion: Motion): boolean {
  switch (motion.type) {
    case "up":
    case "down":
    case "startOfDocument":
      return true;
    default:
      return false;
  }
}

function rowRange(head: Position, target: Position): RowRange {
  return {
    startRow: Math.min(head.row, target.row),
    endRow: Math.max(head.row, target.row),
    column: head.column,
  };
}

// Zed: `Motion::range` (one place that knows which motions are linewise or
// inclusive, plus forced-motion overrides) feeding `normal::Vim::normal_motion`.
export function operatorTarget(
  editor: VimEditorCapabilities,
  motion: Motion,
  count: number,
  { forcedMotion, forChange = false }: { forcedMotion?: ForcedMotion; forChange?: boolean } = {}
): OperatorTarget {
  const selections = editor.getSelections();
  const heads = selections.map(selectionHead);

  // Vim `o_V`: a forced-linewise motion operates on whole lines from the
  // cursor row through the motion target row.
  if (forcedMotion === "linewise") {
    return {
      kind: "linewise",
      rows: heads.map(head => rowRange(head, applyMotion(editor, head, motion, count))),
    };
  }

  if (forcedMotion === "charwise") {
    // Vim `exclusive-linewise` rule 2: a forced-charwise vertical motion whose
    // range would end in column one, starting at or before the first
    // non-blank, becomes a linewise operation on the rows above the target
    // (condition checked on the primary selection).
    if (motion.type === "up" || motion.type === "down") {
      const head = heads[0];
      const target = applyMotion(editor, head, motion, count);
      if (target.row > head.row
        && Math.min(head.column, editor.lineLength(target.row)) === 0
        && head.column <= firstNonWhitespaceColumn(editor.line(head.row))) {
        const verticalMotion = motion;
        return {
          kind: "linewise",
          rows: heads.map(selectionHead => {
            const targetPosition = applyMotion(editor, selectionHead, verticalMotion, count);
            return rowRange(selectionHead, { row: Math.max(0, targetPosition.row - 1), column: targetPosition.column });
          }),
        };
      }
    }
    // Vim `o_v`: wrapping the motion bypasses the linewise specializations
    // below and routes through the forced-charwise range in [motionRange].
    motion = { type: "forcedCharwise", motion };
  }

  if (isLinewiseMotion(motion)) {
    // Fold/view-aware vertical targets come from the host when it has them.
    const hostSelections = hostViewLineSelectionsForMotion(editor, motion, count, { displayLine: false, extend: false });
    if (hostSelections !== undefined) {
      return {
        kind: "linewise",
        rows: heads.flatMap((head, index) => {
          const target = selectionHead(hostSelections[index] ?? selections[index]);
          // Vim: `j`/`k` that cannot move (first/last line) fails the operation.
          return target.row === head.row ? [] : [rowRange(head, target)];
        }),
      };
    }
    if (motion.type === "up" || motion.type === "down") {
      const rowDelta = motion.type === "up" ? -count : count;
      return {
        kind: "linewise",
        rows: heads.flatMap(head => {
          const targetRow = Math.max(0, Math.min(head.row + rowDelta, editor.lineCount() - 1));
          return targetRow === head.row ? [] : [rowRange(head, { row: targetRow, column: head.column })];
        }),
      };
    }
    // `gg`: linewise between the cursor row and the (counted) target line,
    // including the same-row case.
    return {
      kind: "linewise",
      rows: heads.map(head => rowRange(head, { row: Math.min(count - 1, editor.lineCount() - 1), column: head.column })),
    };
  }

  return {
    kind: "charwise",
    targets: heads.map(head => {
      // Vim: `cw` on a word acts like `ce` (`:h cw`); the adjustment lives
      // behind [forChange] (Zed: change's expanded word range).
      const range = forChange ? changeMotionRange(editor, head, motion, count) : motionRange(editor, head, motion, count);
      // Vim: a backward word motion that cannot move at all fails the
      // operator outright — `cb` at the start of the buffer must not enter
      // insert. A motion that moves but selects nothing (`cb` onto an empty
      // line under the `exclusive-linewise` rule) still changes.
      const cancelled = motionFailureCancels(motion) && (() => {
        const target = applyMotion(editor, head, motion, count);
        return target.row === head.row && target.column === head.column;
      })()
        ? true
        : undefined;
      return { head, range, cancelled };
    }),
  };
}

function motionFailureCancels(motion: Motion): boolean {
  switch (motion.type) {
    case "previousWordStart":
    case "previousWordEnd":
      return true;
    default:
      return false;
  }
}

// Zed: `normal::Vim::normal_object` expanding the selection through
// `object::Object::range`, including the paragraph fixups from
// normal/delete.rs. Operator-specific adjustments are declared here, behind
// flags, so application modules stay free of object knowledge.
export function textObjectOperatorTarget(
  editor: VimEditorCapabilities,
  object: TextObject,
  { around, count, forChange = false }: { around: boolean; count: number; forChange?: boolean }
): OperatorTarget {
  const selections = editor.getSelections();

  // Vim: paragraph text objects operate linewise after an operator (`:h ap`),
  // so `dap`/`yap`/`cip` produce linewise registers and whole-line edits.
  // A single blank line is a valid one-row paragraph; only `ap` on a trailing
  // blank run at end of file fails (cancelled: no edit, change does not enter
  // insert).
  if (object.type === "paragraph") {
    const rows: RowRange[] = [];
    const charwise: CharwiseTarget[] = [];
    for (const selection of selections) {
      const head = selectionHead(selection);
      const range = textObjectRange(editor, head, object, { around, count });
      if (paragraphObjectCancelled(editor, head, range, { around })) {
        charwise.push({ head, range: { start: head, end: head }, cancelled: forChange ? true : undefined });
        continue;
      }
      rows.push({ startRow: range.start.row, endRow: range.end.row, column: head.column });
    }
    if (rows.length === 0) return { kind: "charwise", targets: charwise };
    return { kind: "linewise", rows };
  }

  // Vim: `aw` on an empty line is linewise when it cannot reach a word (the
  // blank lines themselves are the object); see [blankLineAroundWordRows].
  if (object.type === "word" && around) {
    const rows: RowRange[] = [];
    const charwise: CharwiseTarget[] = [];
    for (const selection of selections) {
      const head = selectionHead(selection);
      const blankRows = count === 1 ? blankLineAroundWordRows(editor, head) : undefined;
      if (blankRows === "cancelled") {
        charwise.push({ head, range: { start: head, end: head }, cancelled: forChange ? true : undefined });
        continue;
      }
      if (blankRows !== undefined) {
        rows.push({ ...blankRows, column: head.column });
        continue;
      }
      charwise.push({ head, range: textObjectRange(editor, head, object, { around, count }) });
    }
    if (rows.length > 0) return { kind: "linewise", rows };
    return { kind: "charwise", targets: charwise };
  }

  return {
    kind: "charwise",
    targets: selections.map(selection => {
      const head = selectionHead(selection);
      const range = textObjectRange(editor, head, object, { around, count });
      // Vim: a surround object with no pair at the cursor fails the operator
      // (`ci"` with no quotes ahead must not enter insert).
      const cancelled = object.type === "surround" && !surroundObjectFound(editor, head, object) ? true : undefined;
      return { head, range, cancelled };
    }),
  };
}

// Zed: `dd`/`cc`/`yy` are operator + `motion::Motion::CurrentLine`. Doubling
// the pending operator's final key targets [count] whole lines from the cursor.
export function lineOperatorTarget(editor: VimEditorCapabilities, count: number): OperatorTarget {
  return {
    kind: "linewise",
    rows: editor.getSelections().map(selection => {
      const head = selectionHead(selection);
      return {
        startRow: head.row,
        endRow: Math.min(head.row + count - 1, editor.lineCount() - 1),
        column: head.column,
      };
    }),
  };
}

// Vim: `dG`/`d{count}G` and friends operate linewise between the cursor row
// and an absolute target row (`:h G`: "not a motion character" semantics are
// resolved by the caller; the target row arrives precomputed).
export function rowOperatorTarget(editor: VimEditorCapabilities, targetRow: number): OperatorTarget {
  const clampedRow = Math.max(0, Math.min(targetRow, editor.lineCount() - 1));
  return {
    kind: "linewise",
    rows: editor.getSelections().map(selection => {
      const head = selectionHead(selection);
      return rowRange(head, { row: clampedRow, column: head.column });
    }),
  };
}

// Zed: `normal::Vim::normal_motion` / `normal_object`. The only switch over
// operators; application modules are each total over target kinds, so a new
// targeting source cannot stub an operator silently.
export function applyOperatorToTarget(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  operator: RangeOperator,
  target: OperatorTarget
): OperatorOutcome {
  switch (operator.type) {
    case "delete":
      applyDelete(editor, registers, registerName, target);
      return { enterInsert: false };
    case "change":
      return { enterInsert: applyChange(editor, registers, registerName, target) };
    case "yank":
      applyYank(editor, registers, registerName, target);
      return { enterInsert: false };
    case "convert":
      applyConvert(editor, operator.target, target);
      return { enterInsert: false };
    case "indent":
      applyIndent(editor, operator.direction, target);
      return { enterInsert: false };
  }
}
