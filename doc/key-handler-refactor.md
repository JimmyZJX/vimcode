# Typed key-handler refactor

Status: in progress. The `KeyExecutor` is now the live key-dispatch entrypoint
(`Vim.dispatchTypedKey` -> `routeKeyThroughExecutor` -> `KeyExecutor.handle`).
User remaps are fully migrated onto the executor (`Vim.remapRootHandler` +
`remap.ts`). The bridge to the not-yet-migrated dispatcher lives entirely in
`Vim`, not in `KeyExecutor`: `handle` returns a plain `boolean` (claimed or
not), and when a key is unclaimed `Vim` runs the legacy `dispatchKey`. Keys the
executor emits (remap expansions) or replays (ambiguous-conflict suffixes) are
re-dispatched through `Vim.dispatchThroughPipeline` via the executor's generic
`redispatch` hook, so they take the same executor-then-legacy path as typed
keys. The executor has no knowledge of the legacy dispatcher. Remaining legacy
subsystems (waiting input, finite keymap, easymotion, operators, motions,
insert/replace, search, command, macros/repeat) are ported into
`Vim.executorHandlers` slice by slice.

## Migration progress

- [x] Core handler types and combinators (`key_handler.ts`).
- [x] Standalone executor with conflict/replay/queue (`key_executor.ts`).
- [x] Executor plumbing: per-key `allowRemap`, generic `redispatch` hook for
  emitted/replayed keys, `whenIdle`. `handle` returns `boolean`.
- [x] Entrypoint hook: `dispatchTypedKey` routes through the executor; the
  legacy bridge (`routeKeyThroughExecutor` + `dispatchThroughPipeline`) lives in
  `Vim`.
- [x] Remap layer migrated onto the executor; legacy remap mini-executor
  (`dispatchRemapKey`, `pendingRemap*`, `applyKeyAction`, `acceptPendingRemap`)
  removed. The host timeout still arrives as `RemapTimeoutKey` and is mapped to
  `KeyExecutor.acceptConflict`. `remapIsPending()` reads
  `KeyExecutor.pendingConflict()`.
- [x] Synchronous-until-async effect queue. `KeyExecutor` runs an effect inline
  when it completes synchronously and only defers to a microtask once an effect
  returns a promise; `mapHandler` preserves synchronicity the same way. This lets
  the synchronous `onKey`/`runKeys`/macro-replay paths observe editor effects
  immediately, while real (async) editor edits still serialize. `handleKey().run`
  awaits `KeyExecutor.whenIdle()`.
- [x] Normal-mode cursor movement (`normal_mode_handler.movementHandler`), wired
  via `Vim.normalMovementRootHandler`. It only claims from a clean idle normal
  state (`isExecutorMovementContext`) and only for keys in
  `MIGRATED_MOVEMENT_KEYS`; counted/operator/`ctrl-o` cases still fall through to
  legacy. `Vim.handleThroughExecutor` mirrors the legacy per-key bookkeeping
  (`repeat.maybeFinish`, macro/dot-repeat recording) for the keys it claims.
- [x] Phase 1 — count consolidated into `HandlerState.countText` (the shared
  parser state), replacing the standalone `Vim.countBuffer`.
- [x] Phase 2.1 — normal-mode **count** prefix migrated (`Vim.normalCountPrefix`).
  A count digit appends to the shared `handlerState.countText` and resolves
  immediately to idle (no executor-pending count state), so counts interoperate
  with still-legacy operators across the boundary (`2c` works) without any
  mirror/reset bridge. Movement now runs under the count prefix
  (`Vim.normalRootHandler` → `normalCountPrefix` → `normalMotionGrammar`), gated
  by `isExecutorNormalContext` (normal mode, no `temporaryNormal`, no legacy
  subsystem pending). `handleThroughExecutor` records any key the framework
  claims in normal context for macros/dot-repeat.
- [x] Phase 2.2a — all single-key cursor motions migrated. `normalMotionGrammar`
  delegates to `movementHandler`, which claims any key `motionForKey` recognizes
  (`h`/`j`/`k`/`l`/`w`/`W`/`e`/`E`/`b`/`B`/`0`/`^`/`$`/`%`/`H`/`M`/`L`/`(`/`)`/`{`/`}`/
  arrows/...). The bisecting whitelist is gone.
- [x] Executor pending tracking — `KeyExecutor.isPending()` plus `Vim.isPending`/
  `pendingDepth` reading it, so framework-pending chords (remap conflicts and
  future register/find/operator waits) surface correctly in status. This is a
  prerequisite for any executor-pending normal handler.
- [x] Role-aware recording bridge. `handleThroughExecutor` records every claimed
  key for macros (`recordMacroKey`) and, for dot-repeat, opens a recording on the
  first key of the chord (`beginRecording`) and records keys literally. The
  command declares dot-repeatability via its effect (`lastEffectDotRepeatable`);
  a non-repeatable command, a cancelled chord (`lastHandleWasCancel`), or a
  fall-through to legacy discards the recording. See "Dot-repeat (`.`) and macros"
  below for the full rules. This mirrors legacy, where waiting-input keys are
  recorded in `dispatchWaitingInput` via `recordMacroKey` (+ `recordRepeatKey` for
  change-extending chars like the `f`/`t`/jump target) and never via `maybeStart`.
- [x] Register prefix (`"`) migrated, in the shared `prefixHandler`
  (`prefix_handlers.ts`): an executor-pending continuation that writes
  `HandlerState.register` (the executor's env state). Bridged to legacy on yield
  (see the bridge section above).
- [x] Bare find motions `f`/`t`/`F`/`T` + target char (incl. `ctrl-k` digraph
  target via the shared `digraphWaiter`) and find-repeat `;`/`,`
  (`findHandler`/`repeatFindHandler`). The last find lives in an injected
  `FindState` (`HandlerState.find`, like `marks`); `applyResolvedMotion` is the
  root-motion counterpart of `movementHandler` for grammar-resolved motions, so
  behavior matches legacy (same `motion.ts` application). Marks `` ` ``/`'` (jump)
  are handled as operands; bare mark jumps still fall to legacy. Follow-up: the
  operator-operand find (`dfx`) does not yet record `lastFind` or support
  `ctrl-k`/space targets (pre-existing gap in `operandHandler`).
- [ ] Count-dependent motions: `%` is claimed by `movementHandler` as
  match-pair but a count makes it go-to-percentage (`20%`). The pure grammar
  needs count-aware motion resolution, or `%`/`G`/`gg` must stay on the legacy
  path until then.
- [ ] Line motions `G`/`gg`: `G` resolves via a line move that is not a `Motion`
  (and is also a linewise operator target), and `gg` needs the `g`-chord from
  the finite-keymap phase. Both still work via the legacy fallback.
- [x] Range operators (`d`/`c`/`y`/`>`/`<`/`=`) + operands, in
  `normal_mode_handler.ts` (`operatorRootHandler` → `operandHandler`). Operands:
  doubled-key linewise (`dd`/`>>`), text objects (`diw`/`dap`/...), forced
  motions (`dvj`/`dVj`, counted), char-input find (`dfx`/`dtx`), marks
  (`` d`a ``/`d'a`), line targets (`G`/`gg`), `g`-chord motions
  (`gM`/`g_`/`ge`/...), `]`/`[` bracket motions, and all single-key motions
  (incl. count-sensitive `%`). Counts multiply across operator/operand
  (`2d3w`); registers thread through; `change` targets insert mode via the
  effect's `mode` (see "Mode transitions" below); dot-repeat records the whole
  chord literally (the operator effect declares `dotRepeatable`), and an invalid
  operand cancels cleanly (`lastHandleWasCancel` discards the partial recording).
  Pending-depth is computed from the executor's `operatorDepth`. Convert operators
  (`gu`/`gU`/`g~`) remain on the legacy path (the top-level `g`-chord is not
  claimed by the framework) and work via the count/register bridge.
- [~] Search operands: `/`?` prompt, `n`/`N`/`*`/`#`, and `d/` (operator motion
  operand) are migrated (see the search slices below). `gn`/`cgn`/`dgn` still
  need visual mode; `test_gn`/`cgn`/`dgn` fail until then.
- [ ] Count + recursive remap: a buffered framework count is a *pending*
  continuation, so a remapped key typed after a count (`y`→`2x`, `x`→`"_x`)
  bypasses the remap handler (which only runs at the executor root). The count
  needs to either re-offer the post-count key to the root handlers (preserving
  the count) or resolve to idle as the pre-redo `normalCountPrefix` did.
- [x] Simple action table (`normal/simple_action.ts`, `SimpleAction` +
  `applySimpleAction`, wired via `simpleActionHandler`): `x`/`X` (delete chars),
  `~` (toggle case), `J` (join), `r{char}` (replace, incl. `ctrl-k` digraph),
  `ctrl-a`/`ctrl-x` (increment), `p`/`P` (paste). Each is dot/macro-repeatable via
  its recorded keys. Framework edits also update the change list (`g;`/`g,`) — see
  `routeKeyThroughExecutor`.
- [x] Insert-entry commands `i`/`a`/`I`/`A`/`o`/`O` (`insertEntryHandler` →
  injected `enterInsert` action; [Vim] owns the insert session and the
  count/separator). A readonly document reverts via
  `ensureNormalModeForReadonlyDocument` in `routeKeyThroughExecutor`.
- [x] Operator+operand aliases `s`=`cl`, `S`=`cc`, `C`=`c$`, `D`=`d$`
  (`changeDeleteShortcutHandler`, reusing the operator machinery with a fixed
  target).
- [x] Marks `m{char}` (`markHandler`) and mark jumps (`` `a ``/`'a`), via the
  `MarkState` injected into `HandlerState` (like `editor`/`registers`) — no
  per-operation action callbacks.
- [x] `g`-chords (`gChordHandler`). The framework owns `g`-chord parsing for
  every chord that does not depend on the (not-yet-migrated) visual-mode and
  search subsystems:
  - motions `gg`/`gj`/`gk`/`g_`/`gM`/`ge`/`gE` (count-aware, via
    `applyResolvedMotion`);
  - convert operators `gu`/`gU`/`g~`/`g?` (g-prefixed operators reusing the
    operand grammar, incl. the `guu`/`gugu` doubling and `dotRepeatable`);
  - cumulative increment `g ctrl-a`/`g ctrl-x` and `gJ` (simple actions);
  - native editor/LSP commands `gd`/`gD`/`gy`/`gI`/`gh`/`gx`/`g]`/`g[` and the
    `g r` chord (`g r r`/`g r n`/`g r a`), as `effect`s that call
    `editor.executeNativeCommand` and declare `syncAfter` (the executor reports
    it via `lastEffectSyncAfter`, and `routeKeyThroughExecutor` runs the
    post-command `syncFromEditorState`, mirroring the legacy `native` action);
  - multicursor `gl`/`gL`/`g>`/`g<`/`ga` (count repeats of the VSCode command,
    which reconciles via `syncSelectionAfter`);
  - editor tabs `gt`/`gT` (count-aware: `2gt` jumps to a tab index);
  - change list `g;`/`g,` (via the injected `state.changeList`); and
  - `gi` (re-enter insert at `state.lastInsertPosition`, an insert-entry effect).

  `state.changeList` (the `ChangeListState`) and `state.lastInsertPosition` are
  injected into the live handler state by `normalRootHandler`, like
  `editor`/`registers`/`marks`/`find`. All non-editing native chords declare
  `dotRepeatable: false`. Only `gv` (restore visual selection) and `gn`/`gN`
  (search-selection) remain on the legacy keymap resolver via the `legacyKeymap`
  action + `dispatchToLegacyKeymap` hook; they will migrate with the visual-mode
  and search slices, after which `legacyKeymap` can be deleted entirely.
- [ ] Count + recursive remap: a buffered framework count is a *pending*
  continuation, so a remapped key typed after a count (`y`→`2x`, `x`→`"_x`)
  bypasses the remap handler (which only runs at the executor root). The count
  needs to either re-offer the post-count key to the root handlers (preserving
  the count) or resolve to idle as the pre-redo `normalCountPrefix` did.
- [ ] Finite keymap `z`/`[`/`]`/`ctrl-w` chords (the `g`-chords are done; the
  same `legacyKeymap` delegation pattern applies to the rest).
- [x] Search navigation `n`/`N` (repeat) and `*`/`#` (word under cursor):
  framework motions from the injected `SearchState` (`searchActionHandler`),
  applied to the cursor; `*`/`#` clear the match highlights like the legacy path.
- [x] Search prompt mode `/`?` — the executor's **first non-normal mode**. The
  general mechanism: `executorHandlers` returns per-mode root handlers keyed on
  `state.mode` (normal → `[remap, normal]`, `search` → `[searchRoot]`), and the
  executor drives transitions via the action's target `mode` + `onEnterMode`
  (`enterModeFromExecutor` does the Vim-side entry/exit). `/`?` is an effect
  targeting `search` mode whose transition starts the incremental prompt
  (`SearchState.start`, the editable query stored Vim-side in `activeSearch`,
  injected live into the pure `searchModeHandler`). Each query key updates the
  incsearch preview and stays in `search` mode; `enter` resolves the search
  `Motion`, moves the cursor, and targets normal mode. Escape cancels via the
  legacy escape path (now framework-aware: `clearPendingGrammar` tears down
  `activeSearch`). Unknown non-input keys (`ctrl-a`) and escape are declined by
  the grammar; `ownsKey`/`routeKeyThroughExecutor` let non-escape declined keys
  go to the host without disturbing the prompt (so the native find widget keeps
  its chords). Macros record the query keys (search-mode keys are macro-recorded
  in `handleThroughExecutor`). The executor mode is resynced when *leaving*
  `search` (`setMode`), so legacy visual/command search (still on legacy) is
  untouched. This is the pattern visual mode will reuse. All search key bindings
  live in `search_handler.ts`; the shared `applyMotionResults`
  lower-to-selections helper moved to `motion_handler.ts`.
- [x] `d/` (and `c/`/`y/`): search as an operator motion operand
  (`searchOperandHandler`). Rather than entering the standalone `search` mode
  (which would rebuild the executor root handlers and discard the pending
  operator), it is an **in-graph prompt waiter**: a pending continuation *under*
  the operator that drives the incsearch query inline and, on `enter`, hands the
  resolved search `Motion` to the operator's `apply` (then clears the match
  preview). Escape / empty / no-match `enter` aborts the operator without
  editing. Dot-repeat works (the operator effect declares `dotRepeatable`).
- [ ] Search operands still pending: `gn`/`cgn`/`dgn` (need visual mode — `gn`
  selects the match into a visual selection).
- [~] Visual mode (second non-normal executor mode, same per-mode pattern as
  `search`). `VisualMode` is injected into `HandlerState` (`state.visual`) like
  `marks`/`search`; the pure dispatch lives in `visual_handler.ts`
  (`visualModeHandler`), reusing `VisualMode` for the selection geometry/edits.
  `executorHandlers` returns `[remap, visualRoot]` for the visual kinds; the
  executor resyncs on transitions to/from a framework-owned non-normal mode
  (`isExecutorOwnedNonNormalMode`); macros record visual-mode keys (generalized
  in `handleThroughExecutor`). Done so far (slice 3a):
  - entry `v`/`V`/`ctrl-v` from normal (`visualEntryHandler` → effect targeting
    the visual kind; `enterModeFromExecutor` starts the selection);
  - toggle `v`/`V`/`ctrl-v` within visual (`visualToggleHandler`, target mode
    computed from `VisualMode.currentMode()`);
  - count/register prefix and cursor motions that extend the selection
    (`visualMotionHandler` → `VisualMode.applyMotion`; `%` excluded — it is the
    `percentOrMatching` command, left to legacy);
  - (slice 3b) the `→normal` operators `d`/`x` (delete), `D` (delete to line
    end), `y`/`Y` (yank/linewise), `u`/`U`/`~` (convert), `>`/`<`/`=` (indent)
    via `visualOperatorHandler` → `VisualMode.handleCommand` (static target
    normal). Visual dot-repeat is the *same-size* `repeatAction` (not key-replay,
    which would re-run the motion and pick a different-size selection); it is
    recorded via the injected `RepeatState` (`state.repeatState`). The selected
    register (`"a`/`"_`) is threaded through `handleCommand`'s new
    `registerOverride` param, since the framework register lives in the executor,
    not the legacy `registerSelection`.
  - (slice 3b) visual change `c`/`s` (change the selection) and `R`
    (`changeLines`, whole lines) via `visualChangeHandler` → `VisualMode.handleCommand`
    (static target `insert`). The owner's mode transition (`enterModeFromExecutor`)
    starts the insert session with the *visual origin* (`isVisualModeKind(modeState)
    ? modeState : "normal"`) so a `visualBlock` change collapses cursors and
    replicates the typed text on escape. Visual-change dot-repeat is *deferred*:
    the inserted text is unknown until insert exits, so `changeKey` returns a
    `pendingRepeatChange` selection which the effect stashes on `RepeatState`
    (`setPendingVisualChange`); on insert-exit `finishInsertOrReplaceSession`
    pairs it with the typed text via `recordVisualAction({type:"change", ...})`.
    The pending change moved off the `Vim.pendingVisualRepeatChange` field onto
    `RepeatState` (`setPendingVisualChange`/`takePendingVisualChange`/
    `clearPendingVisualChange`) so both the framework effect and the legacy
    `applyVisualResult` (still used by the not-yet-migrated block-insert
    `I`/`A`) share one home.

  Still on the legacy dispatcher (next slices): visual text objects, `o`/`O`,
  `p`/`P`, join, surround, `I`/`A`, `%`, and `g`-chords; then `gn`/`gN`/`gv` and
  deleting `legacyKeymap`. Visual unhandled keys currently fall to legacy; the
  final fallback (quit visual + run the normal binding) lands once the visual
  grammar is complete.
- [ ] Remaining char-input waiters (digraph/surround/command).

### Where the normal-mode grammar lives

The normal-mode key grammar lives in `normal_mode_handler.ts` as
`normalModeHandler()`, a **pure** handler graph: every handler is
`(key, state) => HandleResult` with no injected dependencies. The live editor
and registers travel in `HandlerState` (`state.editor` / `state.registers`),
injected by `Vim.normalRootHandler`; count and register are owned by the shared
`prefixHandler` (`prefix_handlers.ts`) and live in the executor's env state
(`HandlerState.countText` / `HandlerState.register`), not on `Vim`. `vim.ts`
applies the entry gate (`isExecutorNormalContext` + remap precedence) in
`normalRootHandler` and owns the macro/dot-repeat recording bridge. New
normal-mode grammar should be added in `normal_mode_handler.ts`.

This pure grammar was redone from the earlier `NormalModeDeps`-based version
(now removed). It now covers the count/register prefix, single cursor motions
(`movementHandler`, incl. count-sensitive `%`), and the full range-operator
grammar (see the migration checklist). Not yet in the pure grammar: the simple
action table (`i`/`a`/`o`/`x`/`r`/`~`/`p`/`J`/...), the finite keymap
(`g`/`z`/...), the convert operators (`gu`/`gU`/`g~`), and search operands —
these fall back to the legacy dispatcher.

### Lazy operator targets (`OperatorTarget` descriptor → `resolveTarget`)

`OperatorTarget` is now a **lazy descriptor** (`{kind:"motion"|"object"|"line"|"lastLine"}`),
the operator analog of `Motion`. The concrete ranges are the separate
`ResolvedTarget` (charwise/linewise), produced only at execution time by
`resolveTarget(editor, target, count, {hasCount, forChange})`. The normal-mode
grammar builds descriptors; `applyOperator` resolves them just before applying
(and re-resolves the same descriptor on every `.` replay, so ranges track the
current cursor rather than positions captured when the command was first typed).
`applyOperatorToTarget` and the application modules still take the resolved
`ResolvedTarget`; visual mode lowers its live selection straight to a
`ResolvedTarget` (no descriptor). Lazy targets also mean a key-based `.`/macro
replay re-resolves the range against the cursor at replay time, for free.

### Mode transitions (executor-owned)

The executor owns Vim mode transitions. An accepted action carries a target
`mode` (the `mode` on `effect`/`KeyAction`); after running the action the
executor reports it via the `onEnterMode` option, which `Vim` implements
(`enterModeFromExecutor`) to start an insert session for a `change`, etc. Key
points:

- Only **`effect`** actions report their mode. `keys`/`sequence`/`commands`
  actions (remap expansions) take their mode from the leaf effects they
  redispatch; reporting their capture-time mode would clobber a transition a
  leaf just made (an insert-mode remap expanding to `<Esc>` must end in normal).
- The transition is applied **synchronously** right after the action runs, never
  inside the (possibly async) effect callback — keys dispatch synchronously, so
  the new mode must be observable immediately. The target mode is therefore
  decided synchronously by the handler from the computed target (e.g.
  `changeEntersInsert` mirrors `applyChange`: a no-op change like `ci"` with no
  quotes stays in normal mode). This can in principle disagree with the actual
  async edit result, but is accepted as fine in practice.
- `enterModeFromExecutor` only wires forward transitions the framework produces
  (entering insert from normal). Returning to normal stays with escape/explicit
  handling. `VimGrammarActions` consequently only carries `markMotion`.

### Dot-repeat (`.`) and macros — both key-based

Both `.` and named macros record **keystrokes** and replay them back through
`onKey`. This mirrors Vim, where the two are distinct char buffers (`redobuff`
for `.`, `recordbuff` for `q`) that are both replayed by feeding their chars into
the input stream. An earlier iteration recorded dot-repeat as a re-runnable
`RepeatableCommand` action; that was removed in favor of the simpler key-based
path, which works uniformly for migrated and not-yet-migrated commands and avoids
duplicating dispatch logic between live execution and replay.

The two buffers differ in *what* they record, exactly as in Vim:

- **Macros** (`MacroState`) are a verbatim transcript. While a register is
  recording, every key is appended to `currentKeys` (`recordKey`), stored on
  `stopRecording`, and replayed via `runKey = onKey`, `count` times. Counts,
  motions, and mistakes are all captured as typed.
- **Dot-repeat** (`RepeatState`) records only the last *change*. The **command
  declares** whether it is dot-repeatable, like Vim's `prep_redo` — not a key
  list. A leaf effect sets `dotRepeatable` in its `EffectMeta` (operators: every
  type but yank; simple actions and insert-entry: true; motions/marks: false),
  which `KeyExecutor` exposes after running it (`lastEffectDotRepeatable()`:
  `true`/`false`, or `undefined` when the key only left a pending chord).
  `recordKey` appends through the insert tail and terminating `<escape>`;
  `maybeFinish` commits when the chord returns to a non-pending normal state.
  Replay feeds the recorded keys through `onKey` (the `keys` `RepeatAction`
  variant). Count/register overrides (`3.` / `"a.`) and the numbered-paste
  auto-advance (`"1p` → `.` → `"2p`) are applied by rewriting the recorded key
  list (`keysWith{Count,Register}Override`, `advanceNumberedPasteRepeat`) and
  persisting the result back into `last`. Visual-mode changes keep a separate
  structured `visual` `RepeatAction` variant (`recordVisualAction` /
  `replayVisualAction`).

Recording is wired in `Vim`:

- `handleThroughExecutor` (framework path) opens a recording on the **first key**
  of any normal chord via `beginRecording` — no start-key gate. Count/register
  keys are recorded literally as typed (no seed needed), so the prefix is
  captured even for char-input operands like the register name `a`. After
  `KeyExecutor.handle`:
  - if the key **cancelled** a pending chord (`lastHandleWasCancel()`, the
    executor's `invalid` reset — e.g. `d.`), discard the recording and skip
    recording the cancelling key for dot-repeat (it is still recorded for macros);
  - else record the key, then discard the recording if the completed command was
    **not** dot-repeatable (`lastEffectDotRepeatable() === false`, e.g. a
    motion/yank/mark);
  - if the key instead **fell through** to legacy in normal context (an abandoned
    prefix like the `3` of `3gu`/`3.`), discard the recording — the legacy
    dispatcher restarts it from the bridged count. Insert-session keys also fall
    through but are not `recordable` (mode is insert), so the open recording
    survives.
- The legacy dispatcher (`dispatchKey`) still uses `recordRepeatableKey`
  (`maybeStart` + a `normalPendingChordForRepeat` seed) gated by
  `isRepeatableStartKey`, now trimmed to only the keys legacy still owns (`R`,
  `g`-chords, visual-entry). It shrinks to nothing as commands migrate and
  disappears with `dispatchKey`.

**Replay serialization.** Replay re-dispatches keys through `onKey`. The editor
contract is synchronous (`applyEdits`/`setSelections`/`editText` return `void`;
only the clipboard is async, pre-loaded by the `withSystemClipboard` wrapper
around the whole `.` dispatch), and the synchronous-until-async effect queue runs
each key's effect inline, so a `.`/macro replay completes each key before the
next without a deferred replayer.

### Temporary count/register bridge (`Vim.bridgePendingPrefixToLegacy`)

The framework owns the count/register prefix, accumulating them in the
executor's pending env state rather than the shared `Vim.handlerState`. Legacy
operations still read count/register from `Vim.handlerState`. When a key after a
framework-owned prefix is an operation that has not been migrated (e.g. `2cw`,
`"add`), it falls through to legacy, which would otherwise see an empty count /
no register. `bridgePendingPrefixToLegacy` copies the executor's pending
count/register into `Vim.handlerState` just before yielding (only non-empty
values, so a count typed directly into legacy via `d2w` is never clobbered).

This is a **temporary migration bridge**, to be deleted once the remaining
normal-mode commands are migrated (at which point counted/registered operations
never fall through). Reads that happen *before* the yield (the system-clipboard
register refresh in `handleKey.run`, the dot-repeat seed in
`normalPendingChordForRepeat`) consult `Vim.effectiveRegister` /
`KeyExecutor.currentParserState`, so a framework-pending register/count is
visible to them; `pendingDepth`/`isPending` still read `handlerState` directly so
the framework state is not double-counted with the executor's own pending flag.

### The idle-gate migration strategy

Normal-mode grammar (counts, registers, operators, motions) is tightly coupled
through legacy count/register state, so it cannot be split key-by-key cleanly: a
count typed into one subsystem must pair with the operation that consumes it. The
strategy is therefore: a migrated handler only claims a key from a **clean idle
state** and only handles the simple (count=1, default register) case; anything
counted or mid-chord falls through to the legacy dispatcher, which still owns the
count/register/operator machinery. Each migrated op is duplicated (executor +
legacy) during the transition. Counts/registers move into the executor last, once
its coverage is broad enough to take over from a clean state. Until then,
`handleThroughExecutor` mirrors the per-key bookkeeping that the legacy
dispatcher would have done for any key the executor claims.

### Notes for future slices

- The executor caches `handlerEnvs` between keys and only rebuilds them on
  construction, `reset`, and after an accepted action. The remap root handler
  works around staleness by reading live `Vim` mode/when-evaluator on each key;
  a continuation, once started, keeps the mode/evaluator captured when its chord
  began (this matches the legacy behavior). As more handlers move in, prefer
  syncing the executor's `HandlerState` from live `Vim` state at the start of an
  idle dispatch over per-handler live reads.
- `Vim.dispatchThroughPipeline` runs the legacy dispatcher synchronously. Once a
  migrated handler queues an `effect` in the same physical keystroke as an
  emitted key that falls through to legacy, the legacy fallback must also be
  enqueued (so action ordering is preserved). `whenIdle()` exists for draining
  the queue at the `KeyPlan.run()` boundary.

## Goal

The current Vim key path is split across several state machines:

- `Vim.ownsKey` decides VSCode key ownership synchronously.
- `RemapResolver` owns user remap prefixes and ambiguous remap timeout/replay.
- `VimKeymapResolver` owns finite built-in chords such as `g`, `z`, `[`, `]`, and `ctrl-w` chords.
- `VimOperatorStack` owns pending operator/input state.
- `Vim.countBuffer` and `Vim.selectedRegister` are separate pending fragments.
- `NormalMode`/`VisualMode` methods both parse and execute parts of normal/visual grammar.

This makes some invariants hard to see: whether a key is consumed or passed to VSCode, which pending state owns the next key, what status text should show, what happens after an ambiguous prefix times out, and what mode should be visible before queued async work runs.

The refactor should make key handling a typed parser/continuation state machine. Key handling should synchronously update only parser-visible Vim state: mode, pending handler, count/register environment, chord display, and timeout state. Editor-dependent semantic work should run later through the existing async queue, so it observes the editor after previous queued tasks have completed.

## Design principles

1. **Synchronous parser state, asynchronous editor effects.**
   `handleKey` should decide whether Vim owns the key, update pending parser state, and set the target mode synchronously. The returned `run` closure is queued and may compute ranges/selections/register effects when it actually runs.

2. **Handlers are continuations.**
   A pending operator, pending register name, pending finite chord, pending remap, search input, command input, insert digraph, etc. should be represented as a typed handler rather than as unrelated ad-hoc flags.

3. **One environment object.**
   Counts, selected register, operator depth/status metadata, buffered keys, and live services/callbacks needed by handlers live in one environment object. Avoid a second `Context` argument; centralizing dispatch means every handler has the same call shape.

4. **Ambiguity is first-class.**
   Ambiguous shorter-vs-longer matches need timeout and replay semantics. The design must preserve the existing remap behavior where an accepted shorter mapping may run and the extra keys are replayed if the longer candidate fails.

5. **Native passthrough is explicit.**
   VSCode needs a synchronous preventDefault decision. The result type must distinguish a Vim-handled key, an invalid Vim key that clears pending state, and an unhandled key that native keybindings may process.

6. **Incremental migration.**
   Do not rewrite remaps, keymaps, operators, insert keys, search, command input, macros, and repeat in one patch. Add a small typed core, migrate one layer at a time, and keep tests green at each step.

## Core vocabulary

```ts
type HandlerState = {
  mode: VimMode;
  repeat: number;
  register: RegisterName | undefined;
  operatorDepth: number;
};

type KeyAction =
  | { type: "effect"; mode: VimMode; run: () => void | Promise<void> }
  | { type: "keys"; mode: VimMode; keys: readonly { key: string; allowRemap: boolean }[] }
  | { type: "commands"; mode: VimMode; commands: readonly VimCommandMapping[] }
  | { type: "sequence"; mode: VimMode; actions: readonly KeyAction[] };

type HandlerEnv = {
  handler: Handler;
  state: HandlerState;
};

type HandleResult =
  | { type: "run"; action: KeyAction }
  | { type: "handler"; handlerEnvs: readonly HandlerEnv[] }
  | { type: "conflict"; accepted: KeyAction; pending: readonly HandlerEnv[] }
  | { type: "unhandled" }
  | { type: "invalid" };

type Handler = (key: string, state: HandlerState) => HandleResult;
```

Multiple pending handlers are a built-in result shape rather than a wrapper handler. The central executor/combinator combines branch results while preserving each branch's own `HandlerEnv`. `mapHandler` maps typed handler results by wrapping accepted actions while preserving pending/conflict structure.

### Handler modes and Helix

`VimMode` itself is a single flattened mode enum, matching Zed's `Mode` shape conceptually. This keeps Vim normal and Helix normal distinct without pairing a separate dialect field with a shared kind. Handler dispatch can switch directly on `"normal"`, `"helixNormal"`, `"visual"`, or `"helixSelect"`.

Search and command remain shared prompt modes for now.

## Key actions and mode visibility

`KeyAction.mode` is the target mode after the key is accepted, not an asynchronously computed result. The executor should switch the visible mode/current default handler synchronously before executing the action.

Only `effect` actions are queued. Key-sequence actions are synchronously re-dispatched through the executor, and command actions are handed to the integration layer. Effect actions should compute live editor-dependent values only when they run. For example, `d` followed by a motion should queue a delete action whose closure computes the motion target/range after previous queued tasks have completed, then deletes it. This avoids computing ranges against stale selections while still making the next-key mode visible immediately.

This implies a split:

- Parser state: synchronous, pure-ish, key/chord/count/register/mode-oriented.
- Editor effects: queued, live-editor-dependent, allowed to read current selections/text/registers.

## Ambiguity, timeout, and replay

A conflict means a shorter action is accepted but a longer handler is also possible. The state needs at least:

```ts
type Conflict = {
  accepted: KeyAction;
  pending: readonly HandlerEnv[];
  replaySuffix: string[]; // executor-owned, not part of HandleResult.conflict
};
```

If the timeout fires, run `accepted` and reset to its target mode/default handler.

If another key arrives first:

1. Feed the key to `pending`.
2. If it resolves to a run, discard `accepted` and run the longer action.
3. If it stays pending, append the key to the executor-owned `replaySuffix` and keep waiting.
4. If it is invalid/unhandled, run `accepted`, reset to `accepted.mode`, then replay `replaySuffix` through the new/default handler.

This generalizes the existing `RemapResolver` `matchedWithReplay` behavior. A single replay key is insufficient; ambiguity must carry the buffered suffix.

## Result semantics

`unhandled` means this handler did not claim the key. A surrounding/combined handler may try lower-priority handlers, or the controller may let VSCode handle the key.

`invalid` means this handler did claim the pending context, but the key is not valid for it. Without an accepted conflict, the pending state should be cleared. With an accepted conflict, the executor accepts the conflict and replays the invalidating key as part of the conflict suffix.

A no-op Vim command should be represented as a `run` whose closure does nothing, or a `run` that only clears/upates parser state. It should not be represented as `unhandled` or `invalid`.

## Handler composition

A priority combinator should preserve lower-priority pending branches when both handlers accept a prefix. `HandleResult` therefore carries `HandlerEnv[]` directly for pending branches. The central executor/combinator combines branch results, chooses the first completed run by priority, and keeps all still-pending branches until a later key disambiguates them.

Priority applies when two branches both produce completed runs for the same key. It should not discard a lower-priority branch that only becomes distinguishable on a later key.

## Relationship to current code

Likely mappings:

- `RemapHandler` is the first migrated handler: it implements the generic handler interface and represents shorter-vs-longer ambiguous remaps as `conflict` with replay metadata.
- `motion_handler.ts` is the first typed non-void handler scaffold: it resolves motion keys to live `MotionResult` values instead of editor actions.
- `normal_mode_handler.ts` is the first normal-mode handler scaffold: it handles only plain cursor movements by applying motion results to selections.
- `VimKeymapResolver` becomes a finite-chord handler. Its current `pendingScopes` is evidence that combined handlers need to preserve multiple candidates.
- `countBuffer` and `selectedRegister` move into `HandlerState`.
- Count and register prefixes are shared handler wrappers in `prefix_handlers.ts`; they should eventually replace the current legacy Vim count-buffer/selected-register plumbing.
- `VimOperatorStack` pending variants become typed continuation handlers over time.
- `NormalMode`/`VisualMode` execution helpers become queued action builders and effect functions rather than key parsers.
- `Vim.status` reads from the active handler/conflict state for chord, pending, pending depth, and operator/cursor shape.

## Target `vim.ts` shape

`vim.ts` should converge on being the owner of Vim state plus a small executor for the active key handler graph. It should not keep accumulating per-subsystem dispatch logic. The target flow is:

```text
key
  -> current handler envs
  -> combine handler results
  -> executor updates mode / active handlers / status state synchronously
  -> executor enqueues accepted runs
  -> executor synchronously re-dispatches replay keys, if any
```

In that target shape, remaps, finite keymaps, operators, search/command input, insert digraph/literal/register input, and mode-specific fallbacks are handlers. `vim.ts` owns cross-cutting execution concerns only: key ownership/native passthrough, async queueing, clipboard transactions, mode/status synchronization, synchronously re-dispatching replay keys, and readonly collapse.

`key_executor.ts` is the standalone scaffold for this target. It stores active `HandlerEnv`s, combines handler results, updates the synchronous mode/handler state when a run is accepted, preserves conflicts, accepts conflicts on timeout, enqueues accepted runs, and synchronously re-dispatches replay keys through the same executor. It never waits for an action to finish before replaying keys; actions are the only queued work. Runs have no return value; debugging hooks go through the executor's optional log interface. `prefix_handlers.ts` provides the common count/register prefix transformer that can wrap mode-specific handlers.

## Migration plan

Each phase should keep `npm run build -- --noEmit` and `npm test -- --runInBand` green.

1. **Introduce handler core types.**
   Add shared types for handler state/results, conflict replay, and combinators. No behavior change.

2. **Move count/register state behind the handler state shape.**
   Keep existing behavior, but stop threading count/register as separate `Vim` fields where possible.

3. **Port finite keymap resolution.**
   Wrap `VimKeymapResolver` in the new handler shape. Preserve `pendingScopes` and cancellation semantics.

4. **Port remap resolution.**
   Express ambiguous remaps as `conflict`; the key executor owns the replay suffix while the conflict is pending. Preserve timeout behavior exactly.

5. **Port one operator path.**
   Start with `d` + motion. The handler should set normal mode synchronously and queue a delete whose closure computes the live motion target and applies `applyOperatorToTarget`.

6. **Port remaining range operators.**
   Move `c`, `y`, convert, indent, forced motions, line doubling, and text objects.

7. **Port char-input waiters.**
   Replace/digraph/surround/register/mark/jump/search/command input can become typed handlers. This should reduce `VimOperatorStack.waitingInput`.

8. **Collapse status/pending calculation.**
   Once active pending state is handler-driven, remove duplicate `isPending`/`pendingDepth` sources.

## Open questions

- How `HandlerState.repeat` should map onto Vim's legacy count-buffer while the old dispatcher is still in use. The typed prefix handler keeps its in-progress count text in the handler closure rather than in `HandlerState`.
- Whether `operatorDepth` is enough for cursor shape, or whether status should ask handlers for a display depth/chord/operator label.
- How much of macro/repeat recording belongs in parser handling vs queued effects. Current code records near `dispatchKey`; migration should preserve existing repeat/macro tests before moving that boundary.
- How native/host command `KeyAction`s should handle selection synchronization once the executor is integrated into `vim.ts`.
