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
import { applyComment } from "./normal/comment.js";
import { ConvertTarget, applyConvert } from "./normal/convert.js";
import { applyDelete } from "./normal/delete.js";
import { applyFormat } from "./normal/format.js";
import { IndentDirection, applyIndent } from "./normal/indent.js";
import { paragraphObjectCancelled } from "./normal/object.js";
import { applyYank } from "./normal/yank.js";
import { TextObject, argumentObjectFound, blankLineAroundWordRows, surroundObjectFound, tagObjectFound, textObjectRange } from "./object.js";
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

// A *resolved* operator target: concrete model-coordinate ranges/rows, ready to
// hand to an application module. Zed: `MotionKind` survives into operator
// application; locally inclusivity is resolved into concrete range extents at
// resolution, so only charwise/linewise remain. A blockwise variant is reserved
// for the visual-block fold-in.
// Vim `o_v`/`o_V`: a pending operator's motion can be forced charwise/linewise.
export type ForcedMotion = "charwise" | "linewise";

export type ResolvedTarget =
  | { kind: "charwise"; targets: readonly CharwiseTarget[] }
  | { kind: "linewise"; rows: readonly RowRange[] };

// A *lazy* operator target: a description of what an operator should act on,
// resolved to concrete ranges only at execution time via [resolveTarget] — the
// same value/resolution split as [Motion]/[applyMotion]. This is what the
// normal-mode grammar builds and what a repeatable command stores, so a replay
// (`.`) re-resolves the range against the cursor at replay time rather than
// reusing positions captured when the command was first typed. Visual-mode
// operators do not use this: their range is the live selection, already a
// [ResolvedTarget].
export type OperatorTarget =
  // A motion (`dw`, `d}`, `d%`, `dvj` with a forced motion, `dgg` via
  // [startOfDocument]); [count] is the motion repeat.
  | { kind: "motion"; motion: Motion; forced?: ForcedMotion }
  // A text object (`diw`, `dap`); [around] selects `a`/`i`, [count] the object
  // count.
  | { kind: "object"; object: TextObject; around: boolean }
  // The doubled operator key (`dd`/`cc`/`yy`/`>>`): [count] whole lines.
  | { kind: "line" }
  // `G`: linewise to the last line, or to line [count] when a count was given.
  | { kind: "lastLine" };

// Zed: `state::Operator`, restricted to the operators that consume a
// motion/object/line/visual-derived range.
export type RangeOperator =
  | { type: "delete" }
  | { type: "change" }
  | { type: "yank" }
  | { type: "convert"; target: ConvertTarget }
  | { type: "indent"; direction: IndentDirection }
  // `gq`/`gw`; [keepCursor] is `gw`. The effective 'textwidth' is resolved from
  // the configuration when the operator is built (the application modules have
  // no configuration access).
  | { type: "format"; keepCursor: boolean; textwidth: number }
  // `gc` (line) / `gC` (block): toggle comments via the host's native
  // commenting commands (vim-commentary / VSCodeVim compat).
  | { type: "comment"; block: boolean };

export type OperatorOutcome = { enterInsert: boolean };

// Zed: `motion::Motion::range` deciding `MotionKind::Linewise`. Per-motion
// linewise metadata is declared here and nowhere else.
function isLinewiseMotion(motion: Motion): boolean {
  switch (motion.type) {
    case "up":
    case "down":
    case "startOfDocument":
    case "windowLine":
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
): ResolvedTarget {
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

  // Vim `exclusive-linewise` rule 2: an exclusive motion ending in column
  // one, starting at or before the first non-blank, becomes a linewise
  // operation on the rows above the target (condition checked on the primary
  // selection). `d]}` from the indentation deletes whole lines.
  if (motion.type === "unmatchedForward") {
    const head = heads[0];
    const target = applyMotion(editor, head, motion, count);
    if (target.row > head.row
      && target.column === 0
      && head.column <= firstNonWhitespaceColumn(editor.line(head.row))) {
      return {
        kind: "linewise",
        rows: heads.map(selectionHead => {
          const targetPosition = applyMotion(editor, selectionHead, motion, count);
          return rowRange(selectionHead, { row: Math.max(0, targetPosition.row - 1), column: targetPosition.column });
        }),
      };
    }
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
    // `H`/`M`/`L`: linewise between the cursor row and the window line,
    // including the same-row case (`dM` on the middle line deletes one line).
    if (motion.type === "windowLine") {
      return {
        kind: "linewise",
        rows: heads.map(head => rowRange(head, applyMotion(editor, head, motion, count))),
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
): ResolvedTarget {
  const selections = editor.getSelections();

  // Vim: paragraph text objects operate linewise after an operator (`:h ap`),
  // so `dap`/`yap`/`cip` produce linewise registers and whole-line edits.
  // A single blank line is a valid one-row paragraph; only `ap` on a trailing
  // blank run at end of file fails (cancelled: no edit, change does not enter
  // insert).
  // Linewise text objects: paragraphs (`:h ap`), and the plugin objects that
  // operate on whole lines (vim-indent-object `ii`/`ai`/`aI`,
  // vim-textobj-entire `ie`/`ae`).
  if (object.type === "paragraph" || object.type === "indent" || object.type === "entire") {
    const rows: RowRange[] = [];
    const charwise: CharwiseTarget[] = [];
    for (const selection of selections) {
      const head = selectionHead(selection);
      const range = textObjectRange(editor, head, object, { around, count });
      if (object.type === "paragraph" && paragraphObjectCancelled(editor, head, range, { around })) {
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
      // Vim: a surround/tag object with no pair at the cursor fails the
      // operator (`ci"` with no quotes ahead, `cit` outside any tag, must not
      // enter insert).
      const cancelled =
        (object.type === "surround" && !surroundObjectFound(editor, head, object))
        || (object.type === "tag" && !tagObjectFound(editor, head, count))
        || (object.type === "argument" && !argumentObjectFound(editor, head))
          ? true
          : undefined;
      return { head, range, cancelled };
    }),
  };
}

// Zed: `dd`/`cc`/`yy` are operator + `motion::Motion::CurrentLine`. Doubling
// the pending operator's final key targets [count] whole lines from the cursor.
export function lineOperatorTarget(editor: VimEditorCapabilities, count: number): ResolvedTarget {
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
export function rowOperatorTarget(editor: VimEditorCapabilities, targetRow: number): ResolvedTarget {
  const clampedRow = Math.max(0, Math.min(targetRow, editor.lineCount() - 1));
  return {
    kind: "linewise",
    rows: editor.getSelections().map(selection => {
      const head = selectionHead(selection);
      return rowRange(head, { row: clampedRow, column: head.column });
    }),
  };
}

// Resolve a lazy [OperatorTarget] descriptor to concrete ranges against the
// current editor — the operator analog of [applyMotion] for [Motion]. Called at
// execution time (including each `.` replay), so the ranges always reflect the
// cursor as it is now, not as it was when the command was first typed. [count]
// is the combined operator/operand count; [hasCount] distinguishes `G`
// (last line) from `{count}G` (line N); [forChange] applies the change-specific
// adjustments (`cw`-as-`ce`, object cancellation).
export function resolveTarget(
  editor: VimEditorCapabilities,
  target: OperatorTarget,
  count: number,
  { hasCount = false, forChange = false }: { hasCount?: boolean; forChange?: boolean } = {}
): ResolvedTarget {
  switch (target.kind) {
    case "motion":
      return operatorTarget(editor, target.motion, count, { forcedMotion: target.forced, forChange });
    case "object":
      return textObjectOperatorTarget(editor, target.object, { around: target.around, count, forChange });
    case "line":
      return lineOperatorTarget(editor, count);
    case "lastLine":
      return rowOperatorTarget(editor, hasCount ? Math.max(0, count - 1) : editor.lineCount() - 1);
  }
}

// Zed: `normal::Vim::normal_motion` / `normal_object`. The only switch over
// operators; application modules are each total over target kinds, so a new
// targeting source cannot stub an operator silently.
export function applyOperatorToTarget(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  operator: RangeOperator,
  target: ResolvedTarget
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
    case "format":
      applyFormat(editor, target, { textwidth: operator.textwidth, keepCursor: operator.keepCursor });
      return { enterInsert: false };
    case "comment":
      applyComment(editor, target, { block: operator.block });
      return { enterInsert: false };
  }
}
