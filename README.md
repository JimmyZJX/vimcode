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
  - `src/vim/object.ts` — first text-object support, corresponding to Zed `object::Object`.
  - `src/vim/surrounds.ts` — first Vim surround operators, corresponding to Zed `surrounds` module.
  - `src/vim/visual.ts` — first charwise visual-mode support, corresponding to Zed `visual` module.
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
- Migrated Zed's full `crates/vim/test_data/*.json` fixture inventory into `src/vim/test_data`:
  - Existing passing local fixtures remain enabled.
  - Every newly copied Zed fixture is headed by `// DISABLED: imported from Zed fixture backlog; not triaged for current implementation yet.`
  - The fixture directory is now the compatibility backlog: remove or refine the disabled header as each feature is triaged and implemented.
  - Enabled passing Zed normal/motion fixtures currently include `test_h`, `test_l`, `test_j`, `test_k`, `test_w`, `test_o`, `test_zero`, `test_gg`, `test_dd`, `test_delete_w`, `test_delete_next_word_end`, `test_change_w`, `test_change_e`, `test_end_of_word`, `test_x`, `test_enter`, `test_backspace`, `test_insert_end_of_line`, `test_insert_first_non_whitespace`, `test_insert_line_above`, and linewise yank/paste fixtures.
  - Enabled first text-object/search/visual/surround fixtures include `changes_inner_word_text_object`, `searches_forward_and_repeats_the_match`, visual word delete fixtures, `test_visual_yank`, `test_visual_change`, `test_visual_word_object`, `test_paste_visual`, visual-line fixtures, the first visual-block movement/paste/insert fixtures, focused surround add/delete/change fixtures, and escaped quote object fixtures.
- Added an initial Neovim-backed Jest harness with Zed-style JSON-line fixtures:
  - `src/vim/test/marked_text.ts` parses/encodes Zed-style `ˇ` cursor-marked text plus the charwise, linewise, and rectangular visual marker shapes used by the enabled fixtures.
  - `src/vim/test/neovim_connection.ts` runs short-lived `nvim --headless` comparisons when recording or when a fixture is missing.
  - `src/vim/test/neovim_fixtures.ts` reads/writes `src/vim/test_data/*.json` fixtures using `Put` / `Key` / `ReadRegister` / `Get` entries inspired by Zed's `NeovimData`.
  - `src/vim/test/neovim_backed_test_context.ts` compares local editor state with Neovim/fixtures.
  - `src/vim/neovim.test.ts` discovers every fixture in `src/vim/test_data`; enabled files become Jest tests and files headed by `// DISABLED: <reason>` become skipped tests.
- Current validation:
  - `npm run build -- --noEmit` passes.
  - `npm test -- --runInBand` passes with 84 enabled tests.

Implemented first-slice behavior:

- normal/insert mode transitions
- basic key dispatch through `Vim.onKey`
- counts
- pending operators
- first text-object grammar: operator + `i`/`a` + `w`/`W` and simple quote/bracket text objects
- visual mode slice: charwise `v`, visual-line `V`, and visual-block `ctrl-v` motions plus visual `d`/`x`, `y`, `c`/`s`, `iw`/`iW`, `p`/`P`, block insert, and other-end block movement for the enabled Zed fixtures
- motions: `h`, `j`, `k`, `l`, `w`, `W`, `e`, `E`, `b`, `B`, `0`, `^`, `$`, `gg`, `G`
- operators: `d`, `c`, `y`
- line operators: `dd`, `cc`, `yy`
- motion operators: `dw`, `de`, `cw`, `ce`, `yw`
- insert commands: `i`, `a`, `I`, `A`, `o`, `O`
- `x`
- very basic normal and visual `p` / `P`
- unnamed register and lowercase named-register prefixes for the current yank/delete/change/paste subset
- simple `/...<enter>` search and `n` repeat for the current forward-search fixture
- first surround operators: `ys`, `yss`, `ds`, `cs`, and visual `S` for word/motion/quote/bracket ranges
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

## Source provenance and layout policy

Keep the local `src/vim` structure aligned with Zed's `crates/vim/src` structure as much as practical. When adding or moving behavior, first ask "where does Zed put this?" and prefer the corresponding local module name.

Current alignment:

| Local path | Zed reference | Notes |
|---|---|---|
| `src/vim/vim.ts` | `vim.rs`, `vim::Vim` | High-level mode/state coordinator only. Avoid moving normal/visual/motion/object details back into this file. |
| `src/vim/state.ts` | `state.rs` | Modes, operators, selections, and shared state vocabulary. |
| `src/vim/motion.ts` | `motion.rs` | `Motion`, key-to-motion mapping, point movement, and motion ranges. Motions should be registered/mapped here once and shared by modes. |
| `src/vim/normal.ts` | `normal.rs` | Normal-mode dispatch and pending operator grammar. |
| `src/vim/normal/*` | `normal/*` | Operator/action implementations such as change/delete/yank/paste. |
| `src/vim/visual.ts` | `visual.rs` | Visual-mode state and visual interpretation of motions/actions. Do not duplicate motion key maps here. |
| `src/vim/object.ts` | `object.rs` | Text objects. |
| `src/vim/insert.ts` | `insert.rs` plus insert-related normal commands | Insert-mode behavior and insert command helpers. |
| `src/vim/registers.ts` | `state::Register` / `VimGlobals.registers` | Local register model until state grows closer to Zed. |
| `src/vim/test/*` | `test/*` | Neovim-backed harness and fixture machinery. |
| `src/vim/test_data/*` | `test_data/*` | Fixture-driven compatibility backlog. |

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
   - `surrounds.ts` for surround operations.
   - `replace.ts`, `command.ts`, `search.ts`/`normal/search.ts`, `normal/repeat.ts`, `normal/mark.ts`, etc. as those features are migrated.
   - additional `normal/*` modules as normal-mode behavior expands.
2. Replace the remaining temporary hard-coded key grammar with a declarative keymap inspired by `assets/keymaps/vim.json`; keep the key-to-motion mapping centralized in `motion.ts`.
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

Our first migration step is intentionally smaller: `src/vim/neovim.test.ts` discovers every JSON-line fixture in `src/vim/test_data/*.json`. Enabled files replay the recorded Neovim result; files whose first header is `// DISABLED: <reason>` become skipped Jest tests. Set `VIMCODE_RECORD_NEOVIM=1` while running the Neovim-backed tests to regenerate enabled fixtures from short-lived `nvim --headless` processes. The current helper supports single-cursor `ˇ` marked text, simple forward charwise visual markers (`«...ˇ...»`), and explicit `ReadRegister` fixture entries. This is enough to catch basic normal/insert/operator/register/visual drift before adding more features. Later steps should add backward visual selections, visual line/block markers, and multi-selection support.

Zed fixture migration policy

Zed has hundreds of fixture files under `crates/vim/test_data/*.json`. Treat them as a compatibility backlog, not as irrelevant data. The long-term goal is to migrate them all into `src/vim/test_data/`, because the fixture directory should be the source of truth for compatibility work.

Do not bulk-enable imported fixtures. When importing a Zed fixture whose feature is not known to pass, prepend a fixture-file header:

```json
// DISABLED: <reason>
{ "Put": { "state": "ˇexample" } }
```

The reason should be specific enough to guide implementation. Good examples:

```text
// DISABLED: backward visual selections / visual-line / visual-block marker support is not implemented.
// DISABLED: text-object grammar and object::Object translation have not been added.
// DISABLED: command-line mode is not implemented.
// DISABLED: dot-repeat and macro replay are not implemented.
// DISABLED: Zed-specific workspace command; needs VSCode command mapping decision.
```

Suggested import workflow:

1. Copy a batch of Zed fixture files into `src/vim/test_data/`.
2. Add `// DISABLED: <reason>` to every imported fixture by default, unless it is already known to pass.
3. Prefer coarse but truthful categories when importing many files; refine the reason when working on a specific feature.
4. To enable a fixture, remove the disabled header, run/regenerate it with live Neovim if needed, and make the local implementation pass.
5. Keep enabled fixture names stable. Like Zed, the fixture filename is the test id.

Useful first batches to import:

- Basic normal/motion fixtures, some of which should be enabled quickly: `test_h`, `test_j`, `test_k`, `test_l`, `test_w`, `test_zero`, `test_gg`, `test_dd`, `test_delete_w`, `test_change_w`, `test_insert_*`, `test_o`.
- Text object fixtures as disabled backlog: word, paragraph, sentence, quote/bracket objects.
- Register fixtures as disabled/enabled according to current support: named registers can be enabled selectively; numbered, black-hole, system, append, and special registers should stay disabled until implemented.
- Visual fixtures can now be enabled for simple forward charwise selections; keep backward, visual-line, and visual-block cases disabled until the marked-text parser and selection model support them.
- Search, command, repeat, marks, folds, wrapped-lines, and Helix fixtures as disabled category backlogs.

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
   - Discover and replay `src/vim/test_data/*.json` by default so CI does not need live Neovim.
   - Regenerate enabled fixtures with `VIMCODE_RECORD_NEOVIM=1 npx jest src/vim/neovim.test.ts --runInBand`.
   - Initialize Neovim and the fake editor with the same text/selections where possible.
   - Send the same keystrokes.
   - Compare buffer text, mode, cursor/selections, and registers when applicable.
   - It is fine to migrate tests before implementing the feature. Put `// DISABLED: <reason>` as a header in the fixture file. The reason should say what is missing or intentionally divergent, not just "not implemented".
4. VSCode adapter integration tests/manual test scripts.
   - Validate patched VSCode key interception.
   - Validate undo/redo grouping.
   - Validate soft wrap, folds, search UI, and cursor rendering.
   - Validate interoperability with normal VSCode commands and extensions.

## VSCode patch integration notes

The intended production integration is a VSCode patch plus adapter, not a normal extension. The current code-oss checkout inspected for this section is `/home/jimzhao/vscode-extensions/vscode`.

Relevant VSCode seams

- Per-editor contribution registration: `src/vs/editor/browser/editorExtensions.ts` exposes `registerEditorContribution` and `EditorContributionInstantiation`. A modal editing contribution should probably live under `src/vs/editor/contrib/vim/browser/` and be registered eagerly or before first interaction.
- Main editor widget: `src/vs/editor/browser/widget/codeEditor/codeEditorWidget.ts` exposes the APIs the adapter needs: `getModel`, `getSelections`, `setSelections`, `executeEdits`, `pushUndoStop`, `trigger`, `onKeyDown`, `onWillPaste`, and editor-scoped `contextKeyService`.
- Key dispatch: `src/vs/workbench/services/keybinding/browser/keybindingService.ts` listens for window `keydown` and calls `AbstractKeybindingService._dispatch`. Editor-level `onKeyDown` is emitted from `CodeEditorWidget` via `ViewUserInputEvents`. A deep patch can either intercept at the editor contribution level and stop propagation/default for handled keys, or add a pre-keybinding modal hook in the workbench keybinding service that asks the focused editor contribution whether it handled the key.
- Text input path: `CodeEditorWidget._createView` routes typed text and paste either directly to `_type`/`_paste` for simple widgets or through command service handlers for normal editors. The Vim layer should pass insert-mode ordinary typing through VSCode's native path where possible, and intercept only normal/visual/operator-pending keys.
- Undo/edit API: `CodeEditorWidget.pushUndoStop()` pushes `model.pushStackElement()`. `executeEdits(source, edits, endCursorState)` applies edits and sets resulting selections. Vim commands that mutate text should generally create an undo boundary around the complete Vim command, not around every internal primitive.
- Clipboard: `IClipboardService` lives at `src/vs/platform/clipboard/common/clipboardService.ts` with `readText` / `writeText`. Vim registers should use the system clipboard by default where desired, but still keep internal register metadata such as characterwise vs linewise because the plain clipboard service only stores text.
- Context keys: `src/vs/editor/common/editorContextKeys.ts` defines editor context keys. `CodeEditorWidget` creates an editor-scoped context key service. Vim should bind keys such as `vim.mode`, `vim.pending`, `vim.operator`, and possibly boolean convenience keys like `vim.normalMode` so normal VSCode keybindings/menus can react.
- Cursor style / line numbers: editor options include `cursorStyle` and `lineNumbers` in `src/vs/editor/common/config/editorOptions.ts`. The adapter can use `editor.updateOptions(...)` for mode-specific cursor style and eventually relative line-number behavior, but it should preserve/restore user options carefully.

Tracked patch prototype

VSCode-specific contribution files live in `vscode-contrib/` in this repo so they can be committed and reviewed without participating in the `vimcode` package build. Sync them into a VSCode checkout with:

```sh
scripts/sync-vscode-contrib.sh /path/to/vscode
```

The script copies production core files from `src/vim` into the VSCode checkout, excluding tests and fixtures, copies `vscode-contrib/browser` into the VSCode contribution directory, adds Microsoft copyright headers to copied core files when needed, and patches `src/vs/editor/editor.all.ts` to import the Vim contribution.

Target patch shape

```text
src/vs/editor/contrib/vim/
  browser/
    vim.contribution.ts       # registers editor contribution
    vimController.ts          # per-editor controller, mode/context-key sync, key interception
    vscodeVimEditor.ts        # implements VimEditorCapabilities on top of ICodeEditor
    vscodeClipboard.ts        # bridges registers/system clipboard through IClipboardService
  common/
    ... copied/adapted vimcode core modules ...
```

The production adapter should own all VSCode-specific behavior:

- translate between VSCode `Position`/`Selection` and vimcode `Position`/`VimSelection`;
- apply edits with `executeEdits('vim', edits, resultingSelections)`;
- call `pushUndoStop()` before/after a complete Vim edit command;
- read/write system clipboard via `IClipboardService` for the default clipboard-backed register policy;
- update editor-scoped context keys whenever the mode or pending state changes;
- update cursor style on mode changes and restore the user's prior cursor style when disabled/disposed;
- avoid intercepting IME composition and avoid stealing keys when focus is in editor widgets such as find/suggest/rename unless explicitly desired.

Key interception recommendation

Start with an editor contribution that listens to `editor.onKeyDown`. When the modal state says the key is handleable, call into the Vim controller, then `preventDefault()` and `stopPropagation()` on the keyboard event. This is the smallest patch surface and should prevent the workbench keybinding service from seeing handled keys if the editor event fires during target/bubble propagation.

If that is not early enough for all cases, add a slightly deeper pre-dispatch hook in `WorkbenchKeybindingService._registerKeyListeners` / `AbstractKeybindingService._dispatch`: resolve the focused `ICodeEditor` from `ICodeEditorService`, get its Vim contribution, and ask it to handle the `IKeyboardEvent` before normal keybinding resolution. This is more invasive but gives deterministic priority over global keybindings.

Undo/checkpoint policy

- Non-editing motions should not create undo stops.
- A complete editing Vim command (`x`, `dw`, `dd`, `cw`, `p`, etc.) should usually be wrapped as:
  - `editor.pushUndoStop()` before the command;
  - one or more `executeEdits('vim', ...)` calls if needed;
  - `editor.pushUndoStop()` after the command.
- Insert mode should mostly use VSCode's native typing/undo grouping. Escaping insert mode should not necessarily create an extra edit boundary unless testing shows it is needed for Vim-compatible repeat/undo semantics.

Open questions

- Should key interception live only in an editor contribution, or should we add the deeper keybinding-service pre-dispatch hook immediately?
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

## For Manual testing

Run these commands in different terminals

```sh
npm run watch
npm run watch-web
./scripts/code-server.sh
```

and run

```sh
./scripts/sync-vscode-contrib.sh /path/to/vscode
```
