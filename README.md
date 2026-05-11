# Zed-inspired Vim for VSCode

This README is the canonical project tracker for the `zed` branch. Future agents should read this file before changing `src/vim`.

The old `vimcode` implementation is intentionally being replaced. Do not preserve old chord-menu code or old tests for their own sake. The goal is a reliable, featureful Vim/Helix implementation for VSCode, injected through a VSCode patch plus adapter, using Zed's Vim implementation as the primary architectural and behavioral reference.

## Current status

Done in this branch:

- Replaced the old `src/vim` chord-menu implementation with a small semantic core.
- Organized new source files to mirror Zed naming:
  - `src/vim/vim.ts` — main Vim state/mode coordinator, corresponding conceptually to Zed `vim::Vim`.
  - `src/vim/state.ts` — modes/operators/selections/state vocabulary, corresponding to Zed `state` module.
  - `src/vim/motion.ts` — `Motion` and basic motion behavior, corresponding to Zed `motion` module.
  - `src/vim/normal.ts` — normal-mode key dispatch, corresponding to Zed `normal` module plus `assets/keymaps/vim.json`.
  - `src/vim/normal/{change,delete,yank,paste}.ts` — first operator implementations, corresponding to Zed `normal/*` modules.
  - `src/vim/insert.ts` — insert-mode text application and normal/insert cursor transitions, corresponding to Zed `insert` plus insert-related normal commands.
  - `src/vim/editor.ts` — local editor capability interface plus in-memory test adapter.
  - `src/vim/vim.test.ts` — first smoke tests through the capability interface.
- Added provenance comments in source files that refer to Zed module/type/function names rather than brittle line numbers.
- Updated `jest.config.js` so normal `npm test` works without `ts-jest-resolver`.
- Added a first register slice:
  - `src/vim/registers.ts` stores the unnamed register and lowercase named registers.
  - Normal-mode `"{register}` prefixes are supported for yank/delete/change/paste in the current subset.
  - Yank/delete/change update the selected register and the unnamed register; paste can read a selected named register.
  - Neovim fixtures can now include `ReadRegister` entries for register comparison.
- Added an initial Neovim-backed Jest harness with Zed-style JSON-line fixtures:
  - `src/vim/test/marked_text.ts` parses/encodes Zed-style `ˇ` cursor-marked text.
  - `src/vim/test/neovim_connection.ts` runs short-lived `nvim --headless` comparisons when recording or when a fixture is missing.
  - `src/vim/test/neovim_fixtures.ts` reads/writes `src/vim/test_data/*.json` fixtures using `Put` / `Key` / `Get` entries inspired by Zed's `NeovimData`.
  - `src/vim/test/neovim_backed_test_context.ts` compares local editor state with Neovim/fixtures.
  - `src/vim/neovim.test.ts` covers a small supported subset against recorded Neovim fixtures.
- Current validation:
  - `npm run build -- --noEmit` passes.
  - `npm test -- --runInBand` passes.

Implemented first-slice behavior:

- normal/insert mode transitions
- basic key dispatch through `Vim.onKey`
- counts
- pending operators
- motions: `h`, `j`, `k`, `l`, `w`, `W`, `e`, `E`, `b`, `B`, `0`, `^`, `$`, `gg`, `G`
- operators: `d`, `c`, `y`
- line operators: `dd`, `cc`, `yy`
- motion operators: `dw`, `cw`, `yw`
- insert commands: `i`, `a`, `I`, `A`, `o`, `O`
- `x`
- very basic `p` / `P`
- unnamed register and lowercase named-register prefixes for the current yank/delete/change/paste subset
- in-memory editor transactions, selections, clipboard, and cursor style for tests

## Reference points

- `vimcode` branch: `zed`
- Zed checkout: `/home/jimzhao/vscode-extensions/zed`
- Zed reference commit last inspected: `e727080af232cec481bafb2d080585091c3f5db7`
- Zed reference commit date: `2026-05-08 10:09:42 +0200`
- Zed reference commit subject: `Update Mistral provider docs following #55443 (#56133)`
- Primary Zed Vim source root: `/home/jimzhao/vscode-extensions/zed/crates/vim/src`
- Primary Zed Vim keymap: `/home/jimzhao/vscode-extensions/zed/assets/keymaps/vim.json`

Jimmy has a basic experiment in a patched VSCode build that is not included in this repository yet. Once available, document how that patch intercepts keys, how it calls into this package, and which VSCode internal services are available to the adapter.

## Project direction

Treat this as a Zed-inspired implementation for VSCode, not a literal port of Zed's `crates/vim`.

Zed's code is tightly integrated with GPUI, Zed's editor model, display map, workspace actions, settings, and search UI. We translate concepts and behavior onto VSCode internals through an adapter, recording provenance as we go so future Zed revisions can be inspected and selectively migrated.

Do not attempt to compile Zed's current Vim crate directly to WASM as the first route. Do not build a large fake Zed editor layer inside VSCode. Do not rely on the public VSCode extension API as the only integration surface; the intended integration is a VSCode patch plus adapter.

## Integration model

The intended stack is:

```text
VSCode patch integration
  - keyboard dispatch
  - context keys / mode state
  - cursor rendering hooks
  - find/search integration hooks
  - editor command integration

VSCode editor adapter
  - document/model reads
  - selections and primary selection
  - block selections
  - display-line movement through soft wrap
  - folds-aware movement
  - edit transactions and undo grouping
  - clipboard access
  - search UI integration

Vim core
  - modes and dialects
  - counts
  - registers
  - operators
  - motions
  - text objects
  - surround
  - dot repeat and macro state
  - command planning/execution

Key grammar
  - Vim keymap
  - Helix keymap
  - pending operator/input states
  - key sequence dispatch
```

The core should stay testable without a real VSCode instance. It should talk to an editor capability interface, backed in tests by an in-memory/fake editor and in production by a VSCode adapter.

## Source provenance policy

When translating behavior from Zed, add source comments near the local type/function. Prefer stable API/module references over line numbers.

Good examples:

```ts
// Zed: `state::Mode`. We keep the same conceptual modes but add an explicit
// `dialect` field so Vim and Helix can share core primitives.
```

```ts
// Zed: `motion::next_word_start`, reached from `motion::Motion::move_point`.
// This is a simplified model-buffer implementation; Zed's version works over
// `DisplaySnapshot`.
```

Avoid comments that only cite line numbers such as `crates/vim/src/motion.rs:1684`; those become stale quickly. Include the Zed reference commit in file-level comments or in this tracker.

If a local function is not a translation, say so explicitly. Examples include `VimEditorCapabilities` and `InMemoryVimEditor`, which are local adapter/test boundaries inspired by Zed's test harness but not ports.

## Initial Zed source map

| Zed source                                                                                                     | Role in Zed                                                                                        | Planned local use                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/vim/src/vim.rs`, `vim::Vim`                                                                            | Main Vim state, mode switching, action registration, editor settings sync, count/operator plumbing | Translate architecture and state concepts. Do not copy GPUI/editor integration. VSCode patch and adapter replace action registration and settings sync. |
| `crates/vim/src/state.rs`, `state::Mode`, `state::Operator`, `state::VimGlobals`                               | Global Vim state, modes, operators, registers, marks, search/replay/macro state                    | Translate core state concepts selectively. UI views should be VSCode-specific or deferred.                                                              |
| `assets/keymaps/vim.json`                                                                                      | Declarative Vim/Helix keymap with contexts like `vim_mode` and `vim_operator`                      | Use as primary keymap reference. Eventually translate into local declarative key grammar/data model.                                                    |
| `crates/vim/src/motion.rs`, `motion::Motion`, `motion::Motion::move_point`, `motion::Motion::expand_selection` | Motion enum, motion kinds, motion expansion, display-aware movement, search motions, tests         | Translate semantic motion model and edge cases. Adapter owns VSCode-specific model/view/fold movement.                                                  |
| `crates/vim/src/object.rs`, `object::Object`                                                                   | Text object model and expansion                                                                    | Translate object concepts and tests. Tree-sitter/language-aware objects can be staged later.                                                            |
| `crates/vim/src/normal.rs` and `crates/vim/src/normal/*`                                                       | Normal-mode actions: change/delete/yank/paste/search/repeat/etc.                                   | Translate operator behavior feature-by-feature. Avoid copying Zed editor transactions directly.                                                         |
| `crates/vim/src/visual.rs`                                                                                     | Visual mode operations, including visual line/block behavior                                       | Translate selection semantics. VSCode adapter handles concrete selection rendering.                                                                     |
| `crates/vim/src/insert.rs` and `crates/vim/src/replace.rs`                                                     | Insert/replace mode behavior and special input handling                                            | Translate mode state and escape/temporary normal behavior. Text input should mostly pass through VSCode's native typing path.                           |
| `crates/vim/src/surrounds.rs`                                                                                  | Surround add/delete/change, surround pair definitions, tests                                       | Translate early. Surround is in scope and should be designed with multi-cursor and visual block support.                                                |
| `crates/vim/src/normal/search.rs`                                                                              | Search UI integration, search-as-motion, `n`/`N`, visual/search interactions                       | Translate behavior, but implement through VSCode find/search services. Basic search UI integration is in scope early.                                   |
| `crates/vim/src/helix.rs` and `crates/vim/src/helix/*`                                                         | Helix mode key behavior and selections                                                             | Translate as alternate dialect over the same core primitives. Do not create a second independent engine.                                                |
| `crates/vim/src/test/*`                                                                                        | Zed test harness, including Neovim-backed comparison                                               | Borrow the testing strategy and many test cases. Reimplement harness against local editor capability interface.                                         |
| `crates/vim/test_data/*.json`                                                                                  | Recorded Neovim-backed test data                                                                   | Use as reference fixtures where applicable after understanding format and compatibility.                                                                |

## Intentional divergences from Zed

- VSCode integration replaces GPUI integration. Zed's `Window`, `Context<Vim>`, `Entity`, `Action`, `Subscription`, and `Render` patterns should not be mirrored directly.
- VSCode's editor/view model replaces Zed's display map. Zed uses `DisplaySnapshot`, `DisplayPoint`, `Anchor`, `SelectionGoal`, and `MultiBufferRow`; the local adapter should expose equivalent capabilities where needed, backed by VSCode internals.
- Search should use VSCode UI/model. Zed integrates with `BufferSearchBar`; this implementation should initially integrate with VSCode's find controller/search model.
- Insert-mode typing should stay native where possible. In insert mode, ordinary text input should pass through VSCode's normal text input path.
- The key system can be simpler than extension-based VSCodeVim because we patch VSCode and can intercept key dispatch directly.
- Some Zed workspace-specific commands should be dropped or mapped later. Zed includes pane/project/Git/outline/notebook-specific bindings; initially only map editor-local or clearly corresponding VSCode commands.
- Licensing/provenance must remain visible. Zed's Vim crate is GPL-3.0-or-later. If we copy or closely translate substantial implementation code, the licensing implications should be understood.

## Features in scope from the beginning

The architecture should not paint us into a corner on these features:

- Vim mode
- Helix mode
- normal/insert/replace/visual/visual-line/visual-block modes
- multi-cursor correctness
- display-line motions with soft wrap
- folds-aware movement
- basic search UI integration
- surround add/delete/change
- counts, registers, operators, and text objects
- dot repeat and macro support eventually

These may still be implemented step by step, but their state model and adapter requirements should be part of the design.

## Next implementation steps

Near-term:

1. Continue splitting Zed-like modules as behavior grows:
   - `visual.ts` for visual/visual-line/visual-block behavior.
   - `object.ts` for text objects.
   - `surrounds.ts` for surround operations.
   - additional `normal/*` modules as normal-mode behavior expands.
2. Replace the temporary hard-coded `motionForKey` / operator key mapping with a declarative keymap inspired by `assets/keymaps/vim.json`.
3. Expand the editor capability interface into grouped capabilities:
   - document/model reads
   - selections
   - edit transactions
   - view/display movement
   - clipboard
   - search
   - editor commands
4. Expand register fidelity beyond the first lowercase-named-register slice: system clipboard, black-hole, append, numbered, small-delete, and read-only registers.
5. Add provenance comments to every newly translated type/function using Zed module/function names.
6. Add tests for multi-selection behavior before implementing more operators, so new code does not regress into single-selection assumptions.

Medium-term:

1. Implement text objects: `iw`, `aw`, quote/bracket objects, then object operators like `ciw`.
2. Implement visual mode and visual-line mode.
3. Implement visual-block representation and lowering to multi-selections.
4. Implement surround: `ys`, `cs`, `ds`, plus visual surround.
5. Implement basic search: `/`, `?`, `n`, `N`, then search-as-motion.
6. Add Neovim-backed comparison harness or recorded fixture workflow based on Zed's test approach.
7. Ingest Jimmy's VSCode patch experiment and document the production adapter boundary.

Longer-term:

1. Implement Helix as an alternate keymap/dialect over the same core primitives.
2. Implement dot repeat and macro recording/replay.
3. Implement marks, jumplist, changelist.
4. Implement advanced registers.
5. Implement display-line motions with soft wrap through the VSCode adapter.
6. Implement folds-aware movement through the VSCode adapter.
7. Implement language/tree-sitter-aware objects where VSCode internals make that feasible.

## Testing strategy

Testing should stay centered on the editor capability interface.

Zed's approach

Zed's `test::neovim_backed_test_context::NeovimBackedTestContext` keeps a Zed editor and a Neovim instance in sync. Tests call helpers such as `set_shared_state`, `simulate_shared_keystrokes`, `simulate`, `shared_state`, and `shared_clipboard`. The backing `test::neovim_connection::NeovimConnection` can either talk to live embedded Neovim or replay recorded JSON test data. State is represented as marked text, with `ˇ` for the cursor and visual markers for selections.

Our first migration step is intentionally smaller: Jest replays JSON-line fixtures from `src/vim/test_data/*.json` by default. Set `VIMCODE_RECORD_NEOVIM=1` while running the Neovim-backed tests to regenerate fixtures from short-lived `nvim --headless` processes. The current helper supports single-cursor `ˇ` marked text and explicit `ReadRegister` fixture entries. This is enough to catch basic normal/insert/operator/register drift before adding more features. Later steps should add visual markers and multi-selection support.

Test layers:

1. Core unit tests with in-memory editor.
   - Fast, deterministic, no VSCode process.
   - Covers key grammar, state transitions, motion expansion, operators, registers, and selections.
2. Zed-derived behavior tests.
   - Translate relevant Zed tests from `crates/vim/src/*` into local tests.
   - Each translated test should record the Zed source path and module/function references.
   - Prefer behavior-level translation over implementation-level translation.
3. Neovim-backed comparison tests.
   - Borrow the idea from Zed's `test::neovim_backed_test_context::NeovimBackedTestContext`.
   - Replay `src/vim/test_data/*.json` by default so CI does not need live Neovim.
   - Regenerate fixtures with `VIMCODE_RECORD_NEOVIM=1 npx jest src/vim/neovim.test.ts --runInBand`.
   - Initialize Neovim and the fake editor with the same text/selections where possible.
   - Send the same keystrokes.
   - Compare buffer text, mode, cursor/selections, and registers when applicable.
   - It is fine to migrate tests before implementing the feature. Use `it.skip` and put `// DISABLED: <reason>` immediately above the skipped test or skipped block. The reason should say what is missing or intentionally divergent, not just "not implemented".
4. VSCode adapter integration tests/manual test scripts.
   - Validate patched VSCode key interception.
   - Validate undo/redo grouping.
   - Validate soft wrap, folds, search UI, and cursor rendering.
   - Validate interoperability with normal VSCode commands and extensions.

## Open questions

- What exact VSCode commit/branch will the patch target?
- Which VSCode internal editor services will the adapter be allowed to import?
- Should the local implementation be GPL-compatible if substantial Zed code is translated, or should Zed remain a behavioral reference only?
- How much Helix parity is required for the first usable version?
- Should visual block use VSCode's native column-selection model directly, or maintain an independent Vim block selection and lower it only at rendering/edit time?
- Should search UI integration use VSCode's existing find widget exactly, or a Vim-specific command-line overlay that delegates search results to VSCode internals?

## Validation commands

Run these after source changes:

```sh
npm run build -- --noEmit
npm test -- --runInBand
```

The npm commands may print existing `.npmrc` proxy warnings; those warnings are not currently test failures.
