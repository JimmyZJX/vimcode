# Typed key-handler refactor

Status: proposed; scaffolding in progress.

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

Multiple pending handlers are a built-in result shape rather than a wrapper handler. The central executor/combinator combines branch results while preserving each branch's own `HandlerEnv`.

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
- `motion_handler.ts` is the first typed non-void handler scaffold: it returns semantic `Motion` values instead of editor actions.
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
