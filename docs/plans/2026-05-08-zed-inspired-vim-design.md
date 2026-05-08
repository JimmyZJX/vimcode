# Zed-inspired Vim implementation for VSCode

## Summary

The goal is to build a reliable, featureful Vim/Helix implementation for VSCode, using Zed's Vim implementation as a reference for architecture, behavior, and tests. The implementation is not constrained to preserve the current `vimcode` design or APIs. The current project can be replaced incrementally as long as we keep a testable editor capability interface and a path to integration with a patched VSCode build.

This should be treated as a Zed-inspired implementation for VSCode rather than a literal port of Zed's `crates/vim`. Zed's code is tightly integrated with GPUI, Zed's editor model, display map, workspace actions, settings, and search UI. We will translate concepts and behavior onto VSCode internals through an adapter, recording provenance as we go so that future Zed revisions can be inspected and selectively migrated.

## Current reference points

- `vimcode` branch: `zed`
- Zed checkout: `/home/jimzhao/vscode-extensions/zed`
- Zed reference commit last inspected: `e727080af232cec481bafb2d080585091c3f5db7`
- Zed reference commit date: `2026-05-08 10:09:42 +0200`
- Zed reference commit subject: `Update Mistral provider docs following #55443 (#56133)`
- Primary Zed Vim source root: `/home/jimzhao/vscode-extensions/zed/crates/vim/src`
- Primary Zed Vim keymap: `/home/jimzhao/vscode-extensions/zed/assets/keymaps/vim.json`

Jimmy has a basic experiment in a patched VSCode build that is not included in this repository yet. Once available, we should document how that patch intercepts keys, how it calls into this package, and which VSCode internal services are available to the adapter.

## Non-goals

- Do not preserve the current `vimcode` internals for their own sake.
- Do not attempt to compile Zed's current Vim crate directly to WASM as the first implementation route.
- Do not build a large fake Zed editor layer inside VSCode.
- Do not rely on the public VSCode extension API as the only integration surface. The intended integration is a VSCode patch plus adapter.
- Do not copy Zed source blindly. When behavior or structure is translated from Zed, record the original Zed location and the Zed commit used as reference.

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

The core should be testable without a real VSCode instance. It should talk to an editor capability interface, backed in tests by a fake editor and in production by a VSCode adapter.

## Editor capability interface

The editor interface is a core design boundary. It should be richer than the current `Editor` interface, but still abstract enough to test without VSCode.

Initial capability groups:

```ts
interface VimEditorCapabilities {
  readonly document: DocumentCapability;
  readonly selections: SelectionCapability;
  readonly edits: EditTransactionCapability;
  readonly view: ViewMovementCapability;
  readonly clipboard: ClipboardCapability;
  readonly search: SearchCapability;
  readonly commands: EditorCommandCapability;
}
```

Important requirements:

- The core should operate over all selections, not just `selections[0]`.
- The interface must represent Vim selection kinds explicitly: characterwise, linewise, and blockwise.
- Display-line movement and folds-aware movement should be adapter capabilities, not ad-hoc approximations in the core.
- Edit operations should be transactional so VSCode undo/redo works naturally.
- Search should initially delegate to VSCode's search UI/model where possible.
- The fake editor should implement enough of this interface to run deterministic unit tests and Zed-derived behavior tests.

A likely selection model:

```ts
type VimSelection =
  | { type: "charwise"; anchor: Position; head: Position; goalColumn?: number }
  | { type: "linewise"; anchorLine: number; headLine: number; goalColumn?: number }
  | { type: "blockwise"; anchor: Position; head: Position; goalColumn?: number };
```

The VSCode adapter can lower `blockwise` selections into VSCode's concrete multi-selection representation for rendering and editing.

## Zed source provenance policy

Every translated module should include a short provenance block near the top or in a neighboring source-ledger entry. The goal is to make future Zed upgrades tractable.

Recommended source note format:

```ts
// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/motion.rs
// - translated concepts: Motion enum shape, inclusive/exclusive/linewise motion kinds
// - intentional differences: VSCode adapter owns display-line and fold mapping
```

For larger features, also update a central source ledger. Suggested file once implementation starts:

```text
docs/zed-source-ledger.md
```

The ledger should list:

- Zed source path and commit.
- Local destination path.
- Whether the code is copied, translated, rewritten, or only behaviorally referenced.
- Important deviations.
- Zed tests or Neovim-backed cases that cover the behavior.

This helps answer: "What changed upstream in Zed, and does it matter for us?"

## Initial Zed source map

| Zed source | Role in Zed | Planned use in this project |
|---|---|---|
| `crates/vim/src/vim.rs` | Main Vim state, mode switching, action registration, editor settings sync, count/operator plumbing | Translate architecture and state concepts. Do not copy GPUI/editor integration. VSCode patch and adapter replace action registration and settings sync. |
| `crates/vim/src/state.rs` | Global Vim state, registers, marks, search state, replay/macro state, UI views for registers/marks | Translate core state concepts selectively. UI views should be VSCode-specific or deferred. |
| `assets/keymaps/vim.json` | Declarative Vim/Helix keymap with contexts like `vim_mode` and `vim_operator` | Use as primary keymap reference. Translate into local key grammar/data model. VSCode patch may use internal key contexts directly. |
| `crates/vim/src/motion.rs` | Motion enum, motion kinds, motion expansion, display-aware movement, search motions, tests | Translate semantic motion model and edge cases. Adapter owns VSCode-specific model/view/fold movement. |
| `crates/vim/src/object.rs` | Text object model and expansion | Translate object concepts and tests. Tree-sitter/language-aware objects can be staged later. |
| `crates/vim/src/normal.rs` and `crates/vim/src/normal/*` | Normal-mode actions: change/delete/yank/paste/search/repeat/etc. | Translate operator behavior feature-by-feature. Avoid copying Zed editor transactions directly. |
| `crates/vim/src/visual.rs` | Visual mode operations, including visual line/block behavior | Translate selection semantics. VSCode adapter handles concrete selection rendering. |
| `crates/vim/src/insert.rs` and `crates/vim/src/replace.rs` | Insert/replace mode behavior and special input handling | Translate mode state and escape/temporary normal behavior. Text input should mostly pass through VSCode's native typing path. |
| `crates/vim/src/surrounds.rs` | Surround add/delete/change, surround pair definitions, tests | Translate early. Surround is in scope and should be designed with multi-cursor and visual block support. |
| `crates/vim/src/normal/search.rs` | Search UI integration, search-as-motion, `n`/`N`, visual/search interactions | Translate behavior, but implement through VSCode find/search services. Basic search UI integration is in scope early. |
| `crates/vim/src/helix.rs` and `crates/vim/src/helix/*` | Helix mode key behavior and selections | Translate as alternate dialect over the same core primitives. Do not create a second independent engine. |
| `crates/vim/src/test/*` | Zed test harness, including Neovim-backed comparison | Borrow the testing strategy and many test cases. Reimplement harness against local editor capability interface. |
| `crates/vim/test_data/*.json` | Recorded Neovim-backed test data | Use as reference fixtures where applicable after understanding format and compatibility. |

## Intentional divergences from Zed

These differences should be explicit when translating code:

1. VSCode integration replaces GPUI integration.
   - Zed's `Window`, `Context<Vim>`, `Entity`, `Action`, `Subscription`, and `Render` patterns should not be mirrored directly.
   - VSCode patch hooks, services, and adapter methods replace them.

2. VSCode's editor/view model replaces Zed's display map.
   - Zed uses `DisplaySnapshot`, `DisplayPoint`, `Anchor`, `SelectionGoal`, and `MultiBufferRow`.
   - The local adapter should expose equivalent capabilities where needed, backed by VSCode internals.

3. Search uses VSCode UI/model.
   - Zed integrates with `BufferSearchBar`.
   - This implementation should initially integrate with VSCode's find controller/search model.

4. Insert-mode typing should stay native where possible.
   - In insert mode, ordinary text input should pass through VSCode's normal text input path.
   - The Vim layer should handle mode transitions, special keys, literal/digraph behavior when implemented, and recording/replay boundaries.

5. The key system can be simpler than extension-based VSCodeVim.
   - Because we patch VSCode, we can intercept key dispatch directly and do not need to emulate Vim solely through public keybindings.
   - We may still maintain declarative keymaps inspired by Zed for readability and upgradability.

6. Some Zed workspace-specific commands should be dropped or mapped later.
   - Zed includes bindings for panes, project panel, Git UI, outlines, diagnostics, notebooks, markdown preview, etc.
   - Initially only map editor-local or clearly corresponding VSCode commands.

7. Licensing/provenance must remain visible.
   - Zed's Vim crate is GPL-3.0-or-later. If we copy or closely translate substantial implementation code, the licensing implications should be understood. The source ledger should distinguish copied code from behavioral reference.

## Features in scope from the beginning

The initial design should not paint us into a corner on these features:

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

These may still be implemented step-by-step, but their state model and adapter requirements should be part of the initial architecture.

## Step-by-step implementation plan

### Phase 0: VSCode patch intake and adapter shape

Once Jimmy's VSCode patch experiment is available, document:

- where key dispatch is intercepted,
- how normal VSCode typing is preserved in insert mode,
- which editor/model/view services are accessible,
- how selections and edits are applied,
- how context keys/cursor rendering can be updated,
- how search/find services can be reached.

Deliverables:

- `docs/vscode-patch-integration.md`
- first draft of `VimEditorCapabilities`
- minimal VSCode adapter skeleton, even if not wired here yet

### Phase 1: Core state and fake editor

Build a new core around semantic primitives:

- `Mode` and dialect (`vim` vs `helix`)
- `Operator`
- `Motion`
- `TextObject`
- `VimSelection`
- counts and pending state
- registers model
- key grammar outputting semantic commands

Deliverables:

- fake editor implementing the capability interface
- unit tests for state transitions
- simple motions and insert/normal transitions

### Phase 2: Basic Vim vertical slice

Implement enough to validate the architecture:

- `h`, `j`, `k`, `l`
- `w`, `e`, `b`, `0`, `^`, `$`, `gg`, `G`
- counts
- `i`, `a`, `I`, `A`, `o`, `O`, escape
- `d`, `c`, `y`
- `dd`, `cc`, `yy`
- `dw`, `cw`, `yw`
- `p`, `P` basic paste

Deliverables:

- tests against fake editor
- initial Neovim comparison harness or fixture workflow
- first source-ledger entries for translated Zed concepts

### Phase 3: Multi-cursor and visual modes

Implement multi-cursor behavior as a first-class invariant:

- all core operations process a selection set
- deterministic ordering and overlap resolution
- visual charwise and linewise modes
- visual block representation and lowering
- block insert/append/delete/yank/paste basics

Deliverables:

- fake editor tests for multi-cursor edits
- visual block tests translated from Zed where possible
- VSCode adapter validation with real selections

### Phase 4: View-aware movement

Add adapter-backed movement:

- display-line up/down through soft wrap
- preferred column/goal column preservation
- folds-aware movement
- visible-line vs model-line distinctions

Deliverables:

- capability tests with fake view layout
- VSCode integration tests/manual cases using soft wrap and folded regions
- provenance notes for Zed `motion.rs` concepts that were adapted

### Phase 5: Search and surround

Implement early user-facing power features:

- `/`, `?`, `n`, `N`
- `*`, `#` if feasible
- search UI integration with VSCode find model
- search as motion for operators where practical
- `ys`, `cs`, `ds`
- visual surround, including visual block cases

Deliverables:

- fake editor tests for search-as-motion where possible
- VSCode integration tests/manual cases for find UI behavior
- surround tests translated from Zed `surrounds.rs`

### Phase 6: Helix mode

Implement Helix as an alternate keymap/dialect over the same core:

- Helix normal/select mode state
- Helix selection-first operations
- Helix motions and surround operations where they share primitives
- mode indicator/state integration

Deliverables:

- Helix keymap subset based on Zed references
- tests for shared primitives behaving differently under Helix dialect

### Phase 7: Long-tail fidelity

Add compatibility depth:

- dot repeat
- macro recording/replay
- mark/jumplist/changelist
- advanced registers
- advanced text objects
- command-line mode/substitute
- digraph/literal insertion
- language/tree-sitter-aware objects
- workspace/editor command mappings

## Testing strategy

Testing should stay centered on the editor capability interface.

Test layers:

1. Core unit tests with fake editor.
   - Fast, deterministic, no VSCode process.
   - Covers key grammar, state transitions, motion expansion, operators, registers, and selections.

2. Zed-derived behavior tests.
   - Translate relevant Zed tests from `crates/vim/src/*` into local tests.
   - Each translated test should record the Zed source path and commit.
   - Prefer behavior-level translation over implementation-level translation.

3. Neovim-backed comparison tests.
   - Borrow the idea from Zed's `crates/vim/src/test/neovim_backed_test_context.rs`.
   - For each test, initialize Neovim and the fake editor with the same text/selections where possible.
   - Send the same keystrokes.
   - Compare buffer text, mode, cursor/selections, and registers when applicable.
   - Store fixtures/recordings if live Neovim is unavailable in CI.

4. VSCode adapter integration tests/manual test scripts.
   - Validate patched VSCode key interception.
   - Validate undo/redo grouping.
   - Validate soft wrap, folds, search UI, and cursor rendering.
   - Validate interoperability with normal VSCode commands and extensions.

The Neovim comparison harness should be introduced early enough to prevent semantic drift, but it does not need to cover every VSCode-specific feature. Some features, such as VSCode find UI integration or soft-wrap display-line movement, need adapter-specific tests rather than pure Neovim comparison.

## Open questions

- What exact VSCode commit/branch will the patch target?
- Which VSCode internal editor services will the adapter be allowed to import?
- Should the local implementation be GPL-compatible if substantial Zed code is translated, or should Zed remain a behavioral reference only?
- How much Helix parity is required for the first usable version?
- Should visual block use VSCode's native column-selection model directly, or maintain an independent Vim block selection and lower it only at rendering/edit time?
- Should search UI integration use VSCode's existing find widget exactly, or a Vim-specific command-line overlay that delegates search results to VSCode internals?

## Immediate next steps

1. Add a source-ledger document before translating substantial Zed behavior.
2. Design the first version of `VimEditorCapabilities`.
3. Ingest Jimmy's VSCode patch experiment once available and document the integration surface.
4. Build the basic Vim vertical slice with fake-editor tests.
5. Start translating selected Zed/Neovim-backed tests for the vertical slice.
