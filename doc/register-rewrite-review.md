# Register and clipboard rewrite review

This document tracks production-readiness findings for the register/clipboard execution rewrite and ReplaceWithRegister. It is intentionally separate from the implementation design in `key-handler-refactor.md`.

## Intended invariants

- A command declares the register it will read only after its full grammar has resolved.
- Clipboard-backed contents are refreshed immediately before the semantic effect runs.
- One root action (physical key, macro/dot replay, remap, or Ex command) sees one coherent clipboard snapshot.
- Nested keys run in order and share the root execution context.
- Register writes update the transaction cache and are flushed once at the root boundary.
- Direct core use without a host clipboard remains synchronous.

## Production blockers addressed in the current WIP

The cases below now have regression coverage and substantial fixes: root-scoped clipboard facades/contexts, immutable `when` propagation (including timeout), pending-effect generation invalidation, re-entrant `:normal` draining, exception-safe replay cleanup, ordered action sequences/conflict suffixes, propagated queue failures/reset, change-list postprocessing, and basic remap/external-remap undo grouping.

The final composition blockers are also addressed: `i_CTRL-O` waits for async remap leaves and restores the correct insertion boundary; mode-changing macro/dot replay runs at the correct point within remap sequences; and remap/external/timeout composite undo transactions remain open through a following Insert session.

| ID | Severity | Finding | Reproduction / consequence | Main code areas |
|---|---|---|---|---|
| REG-1 | High | Async remap completion can outrun owner postprocessing. | A mapping such as `z -> p.` can run clipboard-backed `p` after change-list bookkeeping and replay capture. Dot/macro requests may remain pending until the next physical key. | `Vim.routeKeyThroughExecutor`, `KeyExecutor.enqueueRedispatchedKeys` |
| REG-2 | High | Async redispatch can lose the originating `when` evaluator. | A conditional mapping emitted after clipboard IO may evaluate against the restored default context and activate an unrelated mapping. | `Vim.redispatchThroughExecutionContext`, execution-context propagation |
| REG-3 | High | Pending-effect IO does not invalidate already parsed following keys. | Quickly typing `d/<C-v><Enter>` can parse Enter before clipboard text reaches the pending search query. | `KeyExecutor` generation, `searchOperandWaiter` |
| REG-4 | High | Mapped `:normal` can re-enter while leaf effects are queued. | Ranged `:normal` or a mapped Ex command can resolve later motions/operators against stale cursor state or run all edits on the wrong row. | `Vim.runNormalKeysForCommand`, mapped Ex execution |
| REG-5 | High | Replay cleanup is not exception-safe for synchronous throws. | A throwing replay callback can leave `RepeatState`/`MacroState` in replay mode and leave a macro undo transaction open. | `runSequentially`, `finishReplay`, `Vim.replayMacro` |
| REG-6 | High | Conflict suffixes and later sequence actions can overtake an accepted async action. | An accepted clipboard-backed remap can run suffix keys or mapped commands before its edit completes. | `KeyExecutor.executeAction`, action-sequence completion barriers |
| REG-7 | High | Clipboard read failures have inconsistent propagation. | Some direct plans reject, while queued remap/search effects are logged and swallowed; mapping suffixes may be dropped while the root plan reports success. | `KeyExecutor.drainEffects`, controller queue error handling |
| REG-8 | High | Composed replay/remap undo grouping is incomplete. | `vim.remap { after: ["x", "x"] }`, macro replay, and `:global ... normal` can create multiple undo units or leave one open. | external remap execution, macro transaction, Ex normal loops |

## ReplaceWithRegister compatibility gaps

RWR-1, RWR-2, and RWR-4 are addressed in the current WIP. RWR-3 and RWR-5 remain follow-up work.

| ID | Severity | Finding | Expected behavior |
|---|---|---|---|
| RWR-1 | High | Multiline surround-object geometry can remove indentation. | Upstream `yi}gri}` should be a no-op apart from cursor movement. Target normalization must not unconditionally widen to column zero. |
| RWR-2 | Medium | Missing and present-but-empty registers are conflated. | A missing register reports failure; a present empty clipboard register is valid replacement content and deletes the target. |
| RWR-3 | Medium | External trailing-newline text is classified/normalized differently from VSCodeVim. | Preserve the raw normalized clipboard newline for characterwise replacement where VSCodeVim does. |
| RWR-4 | Medium | Uppercase multicursor register append loses distributed parts. | Appending to a named register should preserve one part per selection. |
| RWR-5 | Medium | Visual `gr` needs explicit visual undo-transaction coverage. | Undo should restore both text and the expected change-start cursor/selection. |

## Behavior decisions to confirm

- `vim.replaceWithRegister` defaults to `false`, matching VSCodeVim.
- When disabled, `grr`/`grn`/`gra` are LSP references/rename/code-action bindings.
- When enabled, ReplaceWithRegister owns `gr` in normal, Visual, and Visual Line modes; Visual Block remains unsupported like VSCodeVim.
- Explicit `"` remains the local unnamed register even when `useSystemClipboard` is enabled; only an unspecified register defaults to the system clipboard in VSCodeVim.

## Register-model review findings

REG-M1 through REG-M5 are addressed in the current WIP: execution state is scoped per Vim facade while values remain shared, explicit/named deletes rotate history, visual put records replaced text while `P` preserves its source, cancelled/no-op operations preserve registers, and uppercase append preserves geometry and multicursor parts. REG-M6 through REG-M10 remain follow-up work.

| ID | Severity | Finding | Expected behavior |
|---|---|---|---|
| REG-M1 | Critical | `Registers` stores the active clipboard transaction globally while controllers have independent queues. Concurrent editors/plans can overwrite each other's active transaction and cached contents. | Make the transaction execution-scoped or globally serialize all roots sharing `VimGlobalState`. |
| REG-M2 | High | Explicit named/unnamed line deletes do not rotate registers `1`–`9`. | All writable delete targets except `_` still update delete history; `""dd` updates both `0` and `1`. |
| REG-M3 | High | Visual put does not consistently record replaced text using delete-register semantics. | Characterwise, linewise, and blockwise replaced selections update the appropriate delete registers; Visual `P` preserves the unnamed source where Vim requires it. |
| REG-M4 | High | Failed/no-op yanks and deletes can write empty content and clear registers/system clipboard. | Cancelled or zero-width operations preserve all registers. |
| REG-M5 | Medium | Uppercase append drops multicursor `parts`, mishandles mixed linewise/characterwise kinds, and can omit line separators. | Append per selection and preserve the dominant linewise geometry. |
| REG-M6 | Medium | Synthetic newlines joining multicursor parts can misclassify independent small deletes as linewise/multiline. | Register classification is derived from each part's real kind, not aggregate separators. |
| REG-M7 | Medium | Sparse numbered rotation leaves stale destination slots. | Rotating an absent source clears the destination register. |
| REG-M8 | Medium | The search register `/` is writable through ordinary yank/delete operators. | `/` is updated only by search state. |
| REG-M9 | Medium | Missing and present-empty registers share one `emptyRegister` value. | Presence is explicit so ReplaceWithRegister can error on missing but accept empty content. |
| REG-M10 | Medium | Nested transactions restore freshness flags but not the previous clipboard snapshot. | Leaving an inner transaction restores both transaction identity and its cached snapshot. |

## Regression matrix

The dedicated clipboard tests should cover all of these with controlled async delays, not immediately resolved promises:

- direct normal/visual/bracket paste;
- insert `ctrl-r`, standalone search paste, and operator-search paste;
- ReplaceWithRegister normal, visual, visual-line, dot replay, counts, named/system registers, and multicursor parts;
- macro and dot replay with and without clipboard reads, nested replay, exceptions, and undo;
- recursive/nonrecursive remaps with keys plus commands, conflict timeout suffixes, conditional `when`, temporary normal mode, and visual mode transitions;
- `:put`, mapped Ex string/object commands, ranged `:normal`, and `:global ... normal`;
- external `vim.remap` reads and writes;
- clipboard read/write rejection and subsequent queue recovery;
- CRLF/trailing-newline round trips and explicit unnamed-register behavior.

## Current validation baseline

- `npx tsc --noEmit` passes.
- Full Jest passes except the long-standing `test_remap_recursion` fixture.
- Existing execution-context tests cover direct, macro, dot, remap, visual remap, insert/search, `:put`, mapped Ex, visual ReplaceWithRegister, and explicit unnamed writes, but several tests use immediately resolved clipboard promises and therefore do not exercise all ordering hazards above.
