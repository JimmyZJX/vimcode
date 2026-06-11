# Operator pipeline redesign

Status: implemented (all seven migration phases). This document is kept as the
design rationale; see "Implementation deviations" at the end for where the
landed code intentionally differs. Read alongside the README tracker.
Zed reference commit: `e727080af232cec481bafb2d080585091c3f5db7`.

## Problem

Operator application is duplicated across targeting paths. The operator switch
(`delete`/`change`/`yank`) appears in `applyOperatorToMotion`,
`applyOperatorToLinewiseSelections`, `applyLinewiseOperatorToRow`,
`handleLineOperator`, `applyTextObjectOperator`, and again per-command in
`visual.ts`. Each of `deleteMotion`/`changeMotion`/`yankMotion` re-implements
the same motion special cases (vertical = linewise, `gg`/`G`, host view-line
motions). Convert (`gu`/`gU`/`g~`) and indent (`>`/`<`/`=`) are second-class:
they re-parse counts/motions/doubling/objects imperatively in
`handleConvertKey`/`handleIndentKey`, a third copy of the key grammar.

Observed consequences: `yj`/`yk` were a silent no-op for months (a
`case "yank": return false` stub in one of the duplicated switches), forced
motions needed wiring in two places, and normal-vs-visual applications of the
same operator can drift.

## Zed mapping

Zed funnels every range-consuming operator through one path: a motion or text
object produces a range with a kind, and one dispatch applies the operator.

| Zed | This design | Notes |
| --- | --- | --- |
| `state::Operator` (one enum: Change, Delete, Yank, Lowercase, Indent, Rot13, AddSurrounds, ...) | `RangeOperator` + char-input waiting classes | We split by what the operator consumes; Zed splits at dispatch time. |
| `Motion::range`, `Motion::linewise()`, `MotionKind` | `operatorTarget()` + `motionKind()` + `OperatorTarget` | One place knows which motions are linewise/inclusive. |
| `normal::normal_motion` / `normal::normal_object` | `applyOperatorToTarget` | The only operator switch. |
| `visual::visual_operate`-style per-mode code | visual state lowered to `OperatorTarget` | Normal and visual share `apply*`. |

We do not mirror GPUI actions, Zed's display map, or its anchor model; targets
are plain model-buffer ranges/rows, with host (VSCode) capabilities consulted
only inside target computation (folds, view lines).

## Core types

```ts
// operator_target.ts
export type RowRange = { startRow: number; endRow: number; column: number };

export type OperatorTarget =
  | { kind: "charwise"; ranges: readonly TextRange[] }   // one per selection
  | { kind: "linewise"; rows: readonly RowRange[] };
  // { kind: "blockwise"; ... } reserved for visual-block fold-in; design the
  // union expecting it, do not build speculatively.

// All operators that consume a motion/object/line/visual-derived target.
export type RangeOperator =
  | { type: "delete" }
  | { type: "change" }
  | { type: "yank" }
  | { type: "convert"; target: ConvertTarget }       // gu / gU / g~ (later rot13)
  | { type: "indent"; direction: IndentDirection }   // > / < / =
  | { type: "addSurrounds" };                        // ys: capture target, then await char
  // future, each one apply function + one binding: rewrap (gq), toggleComments
```

Target producers (the only places that know motion semantics):

```ts
operatorTarget(editor, motion, count,
  { forcedMotion?, forChange? }): OperatorTarget        // Zed: Motion::range
lineOperatorTarget(editor, count): OperatorTarget       // dd/cc/yy/guu/>> doubling
textObjectOperatorTarget(editor, object, around, count): OperatorTarget
visualOperatorTarget(state): OperatorTarget             // visual fold-in phase
```

`operatorTarget` owns: `motionKind(motion)` (linewise: `j`/`k`/`gg`/`G`/`+`/
`-`/`enter`; everything else charwise), `isInclusiveMotion`, forced-motion
overrides (`o_v`/`o_V`), the `exclusive-linewise` promotion rules, host
view-line/fold-aware vertical targets, and the `cw`-as-`ce` adjustment behind
`forChange` (Zed: change's expanded word selection).

The single dispatch, and the only operator switch in the codebase:

```ts
applyOperatorToTarget(operator: RangeOperator, target: OperatorTarget): OperatorOutcome
```

Application modules, each total over target kinds, each owning its register
writes (kind falls out of `target.kind`) and its cursor-after-operation rule
as a named, `:h`-cited helper:

```ts
applyDelete(editor, registers, registerName, target): void
applyChange(...): { enterInsert: ... }
applyYank(...): void
applyConvert(..., convertTarget): void
applyIndent(..., direction, count): void
captureSurroundTarget(target): void   // then pushes the pair-char waiter
```

## Key grammar integration

- `operatorContext()` reports convert/indent (and future range operators) as
  operator-pending peers of d/c/y, not `"other"`. Counts, motions, objects,
  and forced motions resolve through the central keymap grammar;
  `handleConvertKey`/`handleIndentKey` parsing is deleted.
- Doubling generalizes: `dd`/`yy`/`cc`/`guu`/`gUgU`/`>>` are one rule —
  repeating the pending operator's final key yields `lineOperatorTarget`.
- `waitingInput` shrinks to true char-consumers only: replace char, surround
  pair chars, object selector (`i`/`a` + key), digraphs, register/mark/jump
  names, search/command/find input. Invariant: **range-awaiting operators go
  through the keymap; char-awaiting input goes through the waiting
  dispatcher.**

Pipeline after the redesign:

```text
key
 └─ waiting input (char-consumers, one classifier, structurally first)
 └─ keymap resolution (context-gated bindings)
     └─ action: push RangeOperator | motion | object | ...
         └─ target producer (operatorTarget / line / object / visual)
             └─ applyOperatorToTarget (the one switch)
```

## Invariants

1. Exactly one switch over operators; exactly one over target kinds per apply
   module. A new targeting source cannot stub an operator silently.
2. No dispatch arm returns do-nothing success. Unimplemented combinations are
   loud (raise in tests, clear pending with a status note in production).
3. Normal and visual mode apply an operator through the same `apply*`.
4. Per-motion metadata (linewise, inclusive) is declared once, in
   `operator_target.ts`, never inferred at application sites.

## Migration plan (fixture suite is the oracle; keep green per step)

1. `operatorTarget` + `applyDelete`/`applyYank`/`applyChange`; port the
   normal-mode motion path. Probes for `yj`/`dj`/`cj` cursor + register parity.
2. Line operators (`dd`/`cc`/`yy`) and `gg`/`G` paths; delete
   `applyOperatorToLinewiseSelections`/`applyLinewiseOperatorToRow`.
3. Text objects via `textObjectOperatorTarget`; delete
   `applyTextObjectOperator`'s switch.
4. Indent + convert join `RangeOperator`; delete their key parsers; update
   `operatorContext`/keymap conditions; convert/indent fixtures + `gu3w`-style
   probes.
5. Surround capture (`ys`) consumes `operatorTarget`.
6. Visual fold-in: visual d/y/c/u/U/~/>/</= become
   `applyOperatorToTarget(op, visualOperatorTarget(state))`.
7. Victory lap proving extension cost: rot13 (`test_convert_to_rot13`) and/or
   `gq` (`test_gq`) from the disabled backlog — each must touch zero dispatch
   code.


## MotionKind caveat (verified against Zed)

Zed's `MotionKind` (`motion.rs:26`) is three-way — `Linewise | Exclusive |
Inclusive` — and survives into operator application; this design resolves
inclusivity into concrete range extents at target production and keeps only
charwise/linewise. If a fixture surfaces a rule that needs
inclusive-vs-exclusive at application time (register or cursor placement),
add a kind field to the charwise variant rather than inferring it downstream.
Zed's target is also the editor's live anchored selection set
(`Motion::expand_selection`, `motion.rs:1472`, mutates selections);
`OperatorTarget` is deliberately an immutable model-coordinate value so the
core stays testable against the in-memory editor and never round-trips Vim
semantics through VSCode's boundary-based selections.

## Implementation notes for the executing agent

Verified Zed anchors: `state.rs:89` (`Operator` enum), `motion.rs:1335`
(`Motion::range`), `normal.rs:398/426/501` (the operator dispatch matches,
including `Indent`/`Lowercase` as peers of delete/change/yank).

Current call sites to replace (the duplication being deleted):

- `normal.ts`: `applyOperatorToMotion`, `applyOperatorToLinewiseSelections`,
  `applyLinewiseOperatorToRow`, `handleLineOperator`, and the
  `handleConvertKey`/`handleIndentKey` imperative parsers (phase 4).
- `normal/delete.ts` / `normal/change.ts` / `normal/yank.ts`: the
  `deleteMotion`/`changeMotion`/`yankMotion` entry points each re-implement
  vertical/linewise special cases; `changeMotion` also owns the `cw`-as-`ce`
  adjustment (moves behind `forChange`).
- `normal/object.ts`: `applyTextObjectOperator`'s operator switch (phase 3).
- `visual.ts`: `deleteKey`/`yankKey`/`changeKey`/`convert`/`indentKey`
  (phase 6).
- Forced motions currently live in two places and must collapse into
  `operatorTarget`: the `forcedCharwise` wrapper handling in
  `motion.ts:motionRange` and the `exclusive-linewise` rule-2 branch in
  `normal.ts:applyOperatorToMotion`.

Behavior recently fixed via fixtures — do not regress (all covered by the
enabled suite): `yj`/`yk` linewise yank (`yankLineRanges`), backward charwise
yank moves the cursor to range start, multiline charwise paste parks the
cursor on the first pasted character, forced-motion fixtures
(`test_forced_motion_*`).

Workflow: `npm run build -- --noEmit` and `npx jest --runInBand` after every
phase (suite currently 433 enabled / 88 disabled, all green). For quick
semantic checks, write a temporary `src/vim/probe.test.ts` with
`InMemoryVimEditor` + `runKeys`, log results, and delete it. Repeat/macro
recording is positionally uniform in `dispatchKey` — operator refactoring must
not move key-recording call sites. Phase 4 touches the key grammar:
`operatorContext()` in `operator.ts`, `isEditOperatorContext` gates in
`keymap.ts`, and the `normalConvert`/`normalIndent` arms of `waitingInput`
(delete them once convert/indent resolve centrally).

## Implementation deviations (post-landing)

The migration landed as designed, with these deliberate differences:

- `CharwiseTarget` is `{ range, head, cursor?, cancelled? }` rather than a bare
  range list: `head` feeds cursor-after-operation rules (yank's backward-motion
  rule), `cursor` is a producer-side override for object-specific cursor rules
  (paragraph deletes), and `cancelled` models objects that fail without editing
  (`cap` on a trailing blank line suppresses insert-mode entry). `RowRange`
  likewise has an optional `cursor` override (visual linewise deletes clamp
  against the line after the deleted range).
- Operator-specific target adjustments are flags on the producers (`forChange`
  on `operatorTarget`, `forDelete`/`forChange` on `textObjectOperatorTarget`)
  instead of a `MotionKind`-style field, matching the `cw`-as-`ce` precedent.
- `addSurrounds` did not join `RangeOperator`/`applyOperatorToTarget`; instead
  the awaiting-range `ys` state participates in the keymap grammar (operator
  context `"surround"`, doubling key `s`) and its three capture sites consume
  `operatorTarget`/`textObjectRange`/the trimmed line directly. The waiting
  dispatcher now sees surrounds only as char-consumers, satisfying the
  invariant; folding capture into the one dispatch remains possible later.
- Doubling is one rule, but it lives at the top of `resolveVimAction`, ahead of
  both keymap phases, because a doubling key can shadow a motion-mode key
  (`g??` vs backward search) — the equivalent of Zed's per-operator
  `vim_operator` context precedence.
- The visual fold-in covers charwise and linewise targets; blockwise visual
  operators stay on the bespoke helpers until the reserved blockwise target
  variant is built. Visual linewise change now shares `changeLineRange`, so it
  preserves indentation like `cc` (matches nvim with `autoindent`).
- The phase-1..7 probes were kept (not deleted) as
  `src/vim/operator_target.test.ts`; they pin nvim-verified behaviors the
  fixture suite does not cover (`yG` stub fix, `gu3w` counts, `gub` cursor,
  `ys3w`, `Vc` indentation, `g??`).
