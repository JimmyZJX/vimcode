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
  key for macros (`recordMacroKey`), but only feeds **command** keys to
  dot-repeat (`maybeFinish` + `recordRepeatableKey`/`maybeStart`). A char-input
  continuation sets `Vim.executorInputKey` while it consumes its key, so the key
  is recorded for macros only and never reaches `maybeStart` (which would
  otherwise misread the register name `a` as `append`). This mirrors legacy,
  where waiting-input keys are recorded in `dispatchWaitingInput` via
  `recordMacroKey` (+ `recordRepeatKey` for change-extending chars like the
  `f`/`t`/jump target) and never via `recordRepeatableKey`.
- [x] Register prefix (`"`) migrated, in the shared `prefixHandler`
  (`prefix_handlers.ts`): an executor-pending continuation that writes
  `HandlerState.register` (the executor's env state). Bridged to legacy on yield
  (see the bridge section above).
- [~] Char-input motions (find `f`/`t`/`F`/`T`, find-repeat `;`/`,`, marks
  `` ` ``/`'`) were migrated in the earlier `NormalModeDeps` version but were
  **dropped in the pure-grammar redo**; they currently fall back to legacy. To
  re-port.
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
  (`2d3w`); registers thread through; `change` enters insert via
  `VimGrammarActions.enterInsert`; dot-repeat records the whole chord (with the
  framework count/register seeded via `normalPendingChordForRepeat`), and an
  invalid operand cancels cleanly (`KeyExecutor.wasCancelled`). Pending-depth is
  computed from the executor's `operatorDepth`. Convert operators
  (`gu`/`gU`/`g~`) remain on the legacy path (the top-level `g`-chord is not
  claimed by the framework) and work via the count/register bridge.
- [ ] Search operands not migrated: `d/`, `gn`/`cgn`/`dgn` (need the search
  subsystem — last pattern, search input). Currently failing (`d`/`c` claim the
  operator, the search operand is not yet framework-handled).
- [ ] Count + recursive remap: a buffered framework count is a *pending*
  continuation, so a remapped key typed after a count (`y`→`2x`, `x`→`"_x`)
  bypasses the remap handler (which only runs at the executor root). The count
  needs to either re-offer the post-count key to the root handlers (preserving
  the count) or resolve to idle as the pre-redo `normalCountPrefix` did.
- [ ] Simple action table (`i`/`a`/`o`/`x`/`r`/`~`/`p`/`J`/...).
- [ ] Finite keymap (`g`/`z`/`[`/`]`/`ctrl-w`).
- [ ] Remaining char-input waiters (digraph/surround/mark/search/command).

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
(now removed). The redo currently covers only the count/register prefix, single
cursor motions (`movementHandler`), and a first delete slice (`dd` plus
`d{single-motion}`). Find (`f`/`t`/`;`/`,`), marks (`` ` ``/`'`), `G`/`gg`, and
count-dependent motions (e.g. `%` as go-to-percentage) are **not** in the pure
grammar yet and fall back to the legacy dispatcher.

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
