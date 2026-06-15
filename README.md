# Zed-inspired Vim for VSCode

This README is the canonical project tracker for the `zed` branch. Future agents should read this file before changing `src/vim`.

The old `vimcode` implementation is intentionally being replaced. Do not preserve old chord-menu code or old tests for their own sake. The goal is a reliable, featureful Vim/Helix implementation for VSCode, injected through a VSCode patch plus adapter, using Zed's Vim implementation as the primary architectural and behavioral reference.

A project goal is to eventually replace VSCodeVim for existing users. That means `vimcode` should be compatible with common VSCodeVim user configuration, commands, and plugin-style integrations where doing so does not compromise the simpler patched-VSCode architecture. Zed remains the primary source for Vim core structure and semantics; VSCodeVim is the compatibility reference for VSCode-specific user-facing behavior.

## Current status

Done in this branch:

- Replaced the old `src/vim` chord-menu implementation with a small semantic core.
- Organized new source files to mirror Zed naming:
  - `src/vim/vim.ts` — main Vim state/mode coordinator, corresponding conceptually to Zed `vim::Vim`.
  - `src/vim/state.ts` — modes/operators/selections/state vocabulary, corresponding to Zed `state` module.
  - `src/vim/motion.ts` — `Motion` and basic motion behavior, corresponding to Zed `motion` module.
  - `src/vim/normal.ts` — normal-mode key dispatch, corresponding to Zed `normal` module plus `assets/keymaps/vim.json`.
  - `src/vim/normal/{change,delete,yank,paste,search}.ts` — first operator/search implementations, corresponding to Zed `normal/*` modules.
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
  - Enabled passing Zed normal/motion fixtures currently include `test_h`, `test_l`, `test_j`, `test_k`, `test_w`, `test_o`, `test_zero`, `test_gg`, `test_dd`, `test_delete_w`, `test_delete_next_word_end`, `test_delete_b`, `test_change_w`, `test_change_e`, `test_change_b`, `test_change_j`, `test_change_k`, `test_end_of_word`, `test_x`, `test_enter`, `test_backspace`, `test_backspace_non_ascii_bol`, `test_next_line_start`, `test_plus_minus`, `test_end_of_line_downward`, `test_delete_left`, `test_delete_to_end_of_line`, `test_insert_end_of_line`, `test_insert_first_non_whitespace`, `test_insert_line_above`, `test_h_through_unicode`, `test_find_multibyte`, and linewise yank/paste fixtures.
  - Enabled first text-object/search/find/visual/surround fixtures include `changes_inner_word_text_object`, `searches_forward_and_repeats_the_match`, `test_backwards_n`, `test_d_search`, `test_gn`, `test_cgn_repeat`, `test_dgn_repeat`, `test_search_skipping`, `test_f_and_t`, `test_capital_f_and_capital_t`, `test_comma_semicolon`, `test_delete_to_adjacent_character`, paragraph/sentence motion fixtures such as `test_start_end_of_paragraph`, `test_delete_paragraph_motion`, `test_sentence_forwards`, and `test_sentence_backwards`, `test_enter_visual_mode`, `test_gv`, `test_v2ap`, `test_word_object_with_count`, `test_delete_paragraph_object`, `test_change_paragraph_object`, `test_visual_paragraph_object`, visual word delete fixtures, `test_visual_yank`, `test_visual_change`, `test_visual_word_object`, `test_paste_visual`, `test_shift_y`, `test_visual_shift_d`, `test_visual_mode_insert_before_after`, `test_visual_star_hash`, `test_visual_match_eol`, visual-line fixtures, insert-mode literal `ctrl-v` fixtures, the first visual-block movement/paste/insert/search/wrapping/mode-geometry fixtures, focused surround add/delete/change fixtures, escaped quote object fixtures, and repeated-change fixtures such as `test_repeated_ce`, `test_repeated_cl`, `test_repeated_cj`, and `test_repeated_word`, plus the forced-motion fixtures (`test_forced_motion_delete_to_{start,middle,end}_of_line`, `test_forced_motion_yank`) covering Vim `o_v`/`o_V` forced motions, `gM`, and the `exclusive-linewise` special cases, the `g?` rot13 fixtures (`test_change_rot13_motion`, `test_change_rot13_object`), and the post-operator-redesign batch (`test_around_containing_word_indent`, `test_inclusive_to_exclusive_delete`, `test_minibrackets_trailing_space`, `test_paste`), plus the object/operator-fidelity batch: linewise paragraph objects (`test_change_paragraph`, `test_yank_paragraph_with_paste`, `test_delete_paragraph_whitespace`, `test_delete_paragraph_object_with_soft_wrap`), word objects on blank lines and `aw`-from-whitespace (`test_delete_word_object`, `test_change_word_object`), operator aborts on failed motions (`test_repeated_cb`, `test_change_backspace`, `test_cgn_nomatch`), visual object extension/expansion with multiline brackets (`test_visual_object`, `test_visual_object_expands`), and the full surround-object edge cases (`test_change_surrounding_character_objects`, `test_delete_surrounding_character_objects`), plus the harness-feature batch: visual selections restored from `Put` states (`test_convert_to_lower_case`, `test_convert_to_upper_case`, `test_convert_to_rot13`, `test_change_case`), fixture-declared remaps mirroring Zed's test-side `bind_keys` setup (`test_jk`, `test_remap_adjacent_dog_cat`, `test_remap_nested_pineapple`, `test_remap_recursion`; see `src/vim/test/fixture_configurations.ts`), and `test_jk_max_count` / `test_replace_gdefault` (`:set gdefault` with toggle-parity `g` flags), insert-mode `ctrl-o` temporary normal mode (`test_temporary_mode`), and the visual-fidelity batch (`test_visual_delete`, `test_v_search` with direction-honoring empty `?<CR>` repeats, `test_repeat_visual` with clamped charwise repeat shapes, visual-block insert repeat, and `v_R` change-lines), and the small-correctness batch (`test_blackhole_register`, `test_comma_w` via a fixture-declared `,w` remap, `test_delete_unmatched_brace` with shared-scope bracket chords and both `exclusive-linewise` rules, `test_r` with Neovim-faithful `r<CR>` splitting), and the ex-command composition batch (`test_normal_command`, `test_command_g_normal`, `test_command_matching_lines`, `test_command_visual_replace`): visual `:` prefills `'<,'>` with mark addresses in ranges, `:normal` replays keys per range row with batched single-undo `I`/`A` fast paths, `:g`/`:v` compose with `:normal`, and undo restores the change-start cursor clamped to the restored text.
- Added an initial Neovim-backed Jest harness with Zed-style JSON-line fixtures:
  - `src/vim/test/marked_text.ts` parses/encodes Zed-style `ˇ` cursor-marked text plus the charwise, linewise, and rectangular visual marker shapes used by the enabled fixtures.
  - `src/vim/test/neovim_connection.ts` runs short-lived `nvim --headless` comparisons when recording or when a fixture is missing.
  - `src/vim/test/neovim_fixtures.ts` reads/writes `src/vim/test_data/*.json` fixtures using `Put` / `Key` / `ReadRegister` / `Get` entries inspired by Zed's `NeovimData`.
  - `src/vim/test/neovim_backed_test_context.ts` compares local editor state with Neovim/fixtures.
  - `src/vim/neovim.test.ts` discovers every fixture in `src/vim/test_data`; enabled files become Jest tests and files headed by `// DISABLED: <reason>` become skipped tests.
- Added `src/vim/selection_geometry.ts` as the single owner of the boundary<->character-cell
  conversion (raise/lower/canonicalize/render cursor) with round-trip property tests, a
  canonical write-back invariant in `Vim.syncFromEditorState`, always-explicit render-cursor
  cells from the adapter, and a rewritten cell-flooring mouse hit-testing patch. See
  "Mouse and selection-sync invariants" below.
- Per-key dispatch is O(viewport), not O(document): `Vim.dispatchKey` tracks buffer
  changes through the `documentVersion()` capability (VSCode:
  `ITextModel.getAlternativeVersionId`, O(1); in-memory: a content-change counter)
  instead of snapshotting and comparing the whole document text around every key,
  which made every keypress O(file size) on large files.
- Viewport/window-line/undo-fidelity batch (19 newly enabled fixtures, 500 -> 519):
  - Visual-block increment (`g ctrl-a`/`g ctrl-x`): `incrementNumbers` lowers blockwise
    selections to per-row spans (`test_increment_steps`, `test_increment_visual_partial_number`).
  - The in-memory editor gained a test-only viewport model (`SetOption` `lines=N` /
    `scrolloff=N` feed `configureViewportForTest`): topline tracking with reveal-on-motion,
    Vim `ctrl-d`/`ctrl-u` half-page scrolls, `ctrl-f`/`ctrl-b` `onepage()` cursor placement,
    `ctrl-e`/`ctrl-y` margin pushes, and scrolloff centering when `2*scrolloff >= height`
    (`test_ctrl_d_u`, `test_ctrl_f_b`, `test_ctrl_y_e`, `test_scroll_beyond_last_line`,
    `test_visual_block_insert_after_ctrl_d_scroll`).
  - `H`/`M`/`L` are implemented as linewise motions over a new `visibleRowRange()`
    capability (VSCode: completely-visible view range; in-memory: viewport model or the
    whole document) (`test_window_top`, `test_window_middle`, `test_window_bottom`).
  - Sentence objects are a faithful port of Zed `object::sentence` with one intentional
    difference: `as` expands whitespace with `stop_at_newline = true` to match the Neovim
    recordings Zed had exempted (`test_change_sentence_object`, `test_delete_sentence_object`).
    `test_visual_sentence_object` was recorded fresh against local `nvim --headless`
    (Zed's copy of that fixture is empty).
  - Linewise visual states track the raw anchor column; paragraph objects in visual mode
    put the cursor at column zero of the object's last line (the anchor only moves when
    the object starts above it), and the marked-text encoder mirrors Zed's raw
    anchor/cursor-cell encoding for VisualLine states
    (`test_visual_paragraph_object_with_soft_wrap`, `test_indent_gv`).
  - Undo fidelity: `ctrl-r` redo lands at the start of the redone change; visual convert
    (`~`/`u`/`U`/`g?`) and visual increment record the selection start as the undo cursor;
    replace-mode backspace restores overwritten text (port of Zed `replace::multi_replace`
    / `undo_replace`); the harness emulates native insert-mode arrow keys including the
    undo split they cause (`test_undo`, `test_replace_mode_undo`, `test_undo_repeated_insert`,
    `test_paste` step with `u` + `P`).
  - `test_ctrl_w_override` runs via a fixture-declared `map <c-w> D` remap.
- Vim cursor language (`VimController.syncCursorAppearance` owns all cursor styling;
  core `setCursorStyle` calls are advisory and overridden at status sync):
  - normal: block, native blinking; insert: bar, native blinking;
  - visual modes: solid (non-blinking) block via `cursorBlinking: 'solid'`;
  - normal waiting for more keys (`status.pending`: pending operators, `f`/`r`/mark/
    register chords, `g`/`z` prefixes, remaps, counts): solid lower-portion block (gvim
    `o:hor50`), rendered natively by `vscode-contrib/patches/vim-half-block-cursor.patch`:
    a real `TextEditorCursorStyle.HalfBlock` whose full-cell block (background plus
    inverted grapheme) is clipped with `clip-path` — no VSCodeVim-style CSS decoration
    hack. The visible height shrinks geometrically with the pending-stack depth —
    `(2/3)^n` of the cell at depth `n` (`VimStatus.pendingDepth`: each operator-stack
    entry, typed count, selected register, key-chord, or pending remap is one level, so
    `2` and `21` render alike and `2d` folds the count into the operator), floored at
    1/8 — via the `--vimcode-pending-cursor-inset` custom property the controller sets
    on the editor container (CSS default: 50%);
  - replace: underline, native blinking (gvim `r:hor20`, matches VSCodeVim);
  - the controller listens to the editor's `onDidChangeConfiguration` and re-applies
    when the workbench's configuration pushes clobber cursor options (first open,
    settings changes); originals are restored on disable/dispose.
- Replace mode owns plain text keys (`Vim.ownsKey`): insert mode delegates typing to
  the host, but native typing inserts instead of overwriting, so `R` must claim
  printable keys and backspace (which restores overwritten text). IME composition
  still falls through natively.
- Current validation:
  - `npm run build -- --noEmit` passes.
  - `npm test -- --runInBand` passes with 522 enabled tests (28 skipped).
  - The disabled-fixture backlog is fully triaged **and intentionally parked**: every
    `// DISABLED:` header states the concrete blocker, and the remaining 28 fixtures
    were reviewed and deliberately left disabled because they cover behavior that the
    real VSCode host already provides natively (and is not worth duplicating in the
    model-buffer harness), harness-shape gaps, or intentional divergences. See
    "Disabled fixtures are a terminal, documented state" under Testing strategy for
    the bucket-by-bucket rationale. Do not re-attempt these without a new decision.

Implemented first-slice behavior:

- normal/insert mode transitions, including insert-mode `ctrl-y` / `ctrl-e` copying from adjacent lines and `ctrl-v` literal character input
- basic key dispatch through `Vim.onKey`
- counts
- pending operators
- first text-object grammar: operator + `i`/`a` + `w`/`W`, simple quote/bracket objects, and first paragraph/sentence objects
- visual mode slice: charwise `v`, visual-line `V`, and visual-block `ctrl-v` motions plus visual `d`/`x`, `y`, `c`/`s`, `iw`/`iW`, `p`/`P`, block `I`/`A` insert, optional VSCodeVim-compatible visual/visual-line multiline `I`/`A`, and other-end block movement for the enabled Zed fixtures
- motions: `h`, `j`, `k`, `l`, `space`, `w`, `W`, `e`, `E`, `b`, `B`, `ge`, `gE`, `0`, `^`, `$`, `+`, `-`, `enter`, `gg`, `G`, `g_`, `f`, `F`, `t`, `T`, `;`, `,`, `%`, counted `%`, `]}`, `])`, `[{`, `[(`, `}`, `{`, `)`, `(`, and local mark jumps
- operators: `d`, `c`, `y`, including expanded basic `d`/`c` coverage for `0`, `h`, `l`, `$`, vertical linewise motions, `gg`, `G`, and `cc`
- line operators: `dd`, `cc`, `yy`
- motion operators: `dw`, `de`, `cw`, `ce`, `yw`
- insert commands: `i`, `a`, `I`, `A`, `o`, `O`
- `x` and `X`
- `D` delete-to-end-of-line and `C` change-to-end-of-line
- very basic normal and visual `p` / `P`
- unnamed register and lowercase named-register prefixes for the current yank/delete/change/paste subset
- `/...<enter>` and `?...<enter>` regex search with smart-case matching, `n`/`N` repeat, `*`/`#` word search, and search-as-operator ranges through a VSCode-native search capability boundary; pending search input uses a small single-line editor for cursor navigation, deletion, and clipboard paste while VSCode find decorations are updated without revealing the native Find widget, seeded with the last query while empty, and cleared after the Vim search commits
- first surround operators: `ys`, `yss`, `ds`, `cs`, and visual `S` for word/motion/quote/bracket ranges
- first replace/dot-repeat/command slice: `r`, `R`, `.` for simple replace/delete/insert actions, count override for repeated operator motions, `ctrl-a`/`ctrl-x` increment/decrement for decimal/hex/binary numbers, and `:` commands for goto, line offsets, search, join, ranges, matching-line delete, sort, substitute, and a small `:normal I...` subset
- first macro slice: `q{register}` recording, `@{register}` / `@@` replay, counted replay, and `Q` replay-last for focused fixtures
- first VSCode-hosted command slice: normal-mode `u`/`ctrl-r`, `ctrl-o`/`ctrl-i`, `gj`/`gk`, folded-line `j`/`k`, `ctrl-y`/`ctrl-e`, and `ctrl-u`/`ctrl-d`/`ctrl-b`/`ctrl-f` delegate to host editor/workbench capabilities
- numbered/special register slice: register `0` and `1`-`9` storage/rotation for linewise deletes, small-delete `-`, black-hole `_`, search `/`, uppercase append registers, counted `p`/`P`, and linewise paste repeat basics
- in-memory editor transactions, selections, clipboard, and cursor style for tests

## Reference points

- `vimcode` branch: `zed`
- Zed checkout: `/home/jimzhao/vscode-extensions/zed`
- Zed reference commit last inspected: `e727080af232cec481bafb2d080585091c3f5db7`
- Zed reference commit date: `2026-05-08 10:09:42 +0200`
- Zed reference commit subject: `Update Mistral provider docs following #55443 (#56133)`
- Primary Zed Vim source root: `/home/jimzhao/vscode-extensions/zed/crates/vim/src`
- Primary Zed Vim keymap: `/home/jimzhao/vscode-extensions/zed/assets/keymaps/vim.json`
- Zed `crates/vim` license: `GPL-3.0-or-later`; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and [`licenses/GPL-3.0-or-later.txt`](licenses/GPL-3.0-or-later.txt)

Jimmy has a basic experiment in a patched VSCode build that is not included in this repository yet. Once available, document how that patch intercepts keys, how it calls into this package, and which VSCode internal services are available to the adapter.

## Project direction

Treat this as a Zed-inspired implementation for VSCode, not a literal port of Zed's `crates/vim`.

Zed's code is tightly integrated with GPUI, Zed's editor model, display map, workspace actions, settings, and search UI. We translate concepts and behavior onto VSCode internals through an adapter, recording provenance as we go so future Zed revisions can be inspected and selectively migrated.

Do not attempt to compile Zed's current Vim crate directly to WASM as the first route. Do not build a large fake Zed editor layer inside VSCode. Do not rely on the public VSCode extension API as the only integration surface; the intended integration is a VSCode patch plus adapter.

## VSCodeVim compatibility plan

Replacing VSCodeVim is a product compatibility goal, not just an implementation milestone. Users should be able to bring common VSCodeVim settings and workflows to `vimcode` with minimal changes. Compatibility should be explicit and tested rather than accidental.

Compatibility references:

- Local VSCodeVim checkout: `/home/jimzhao/vscode-extensions/Vim`
- VSCodeVim settings: `package.json` `contributes.configuration.properties`
- VSCodeVim keybindings: `package.json` `contributes.keybindings`
- VSCodeVim command/action registry: `src/actions/**`, `src/cmd_line/**`, `src/textobject/**`
- VSCodeVim plugin integrations: `src/actions/plugins/**`
- VSCodeVim decoration infrastructure: `src/configuration/decoration.ts`, `src/util/decorationUtils.ts`

Near-term compatibility layers to design:

1. **Configuration ingestion.** Add a typed compatibility config model that reads the high-value VSCodeVim setting names first, especially `vim.leader`, `vim.handleKeys`, `vim.useCtrlKeys`, `vim.useSystemClipboard`, `vim.easymotion*`, `vim.sneak*`, `vim.surround`, `vim.highlightedyank.*`, and mode-specific keybinding arrays. Config ingestion should support internal layered settings using the `option__layer_name` convention: array-valued layers are concatenated in sorted key order before the base `option`, and object-valued layers are merged in sorted key order before the base `option`. Unsupported settings should be ignored with a known-unsupported list rather than silently misinterpreted.
2. **Mode-specific remapping.** Add a data-driven remap layer before built-in key dispatch. It should support `before`, `after`, `commands`, `silent`, recursive/non-recursive variants, and separate insert/normal/visual/operator-pending tables. Start with exact key-sequence replacement; defer full Vimscript expression mappings.
3. **Command compatibility.** Build a command registry that can invoke both Vim-core actions and VSCode commands. This should cover remap `commands`, `:normal`, `:nohl`, `:registers`, `:marks`, `:write`/`:quit`-style commands where feasible, and clear unsupported-command errors where host integration is required.
4. **Decoration capability boundary.** Add adapter capabilities for transient labels, highlighted ranges, hidden covered text, gutter marks, and status messages. This is needed for EasyMotion, highlighted yank, mark gutter icons, substitution preview, and any future UI overlays.
5. **Plugin-style integrations.** Implement compatibility plugins as modules over the core and adapter capabilities, not as one-off key hacks. Priority order: highlighted yank, EasyMotion, Sneak, Commentary, ReplaceWithRegister, CamelCaseMotion/subword motions, indent/argument/entire text objects.
6. **Compatibility fixtures.** Add a VSCodeVim-compat fixture suite alongside the Zed/Neovim fixtures. These should encode VSCodeVim settings plus key sequences and expected editor state, so we can track intentional divergences.

Suggested EasyMotion architecture:

```text
src/vim/easymotion.ts
  - EasyMotionState
  - marker generation
  - target search over VimEditorCapabilities
  - accumulated label input
  - final target resolution

VimEditorCapabilities
  - showNavigationOverlays(overlays)
  - clearNavigationOverlays(key)

vscode-contrib/browser/vscodeVimEditor.ts
  - render overlays with VSCode decorations or internal overlay hooks
  - hide covered text where needed
  - optionally dim non-target ranges
```

Zed does not implement Vim EasyMotion directly, but its Helix jump labels provide a useful architecture reference: collect visible candidates, assign labels, render navigation overlays, push a pending jump operator, consume label input, then clear overlays. VSCodeVim is the behavior reference for Vim EasyMotion commands and settings.

Compatibility policy:

- Prefer Zed for core Vim semantics and module boundaries.
- Prefer VSCodeVim for VSCode-specific user-facing configuration, command names, plugin behavior, and migration expectations.
- Preserve a small, testable core. VSCode-only rendering and command APIs should live behind adapter capabilities.
- Track unsupported VSCodeVim settings/commands explicitly in this README or a future compatibility matrix.

Migration priorities and backlog:

1. **Remap compatibility is a migration blocker.** Existing VSCodeVim users often carry substantial mode-specific remaps, so `vimcode` should be highly compatible here. The current core runs mostly synchronously inside patched VSCode, so we can avoid some of VSCodeVim's async extension-host race conditions, but behavior should still match user expectations for recursive vs non-recursive mappings, ambiguous prefixes, command mappings, and `vim.handleKeys` / `vim.useCtrlKeys` interactions.
   Tracked remap gaps:
   - `vim.useCtrlKeys`: imported configs often map keys such as `<C-h>`, `<C-j>`, `<C-k>`, and `<C-l>`. Ctrl-key interception should be mapping-aware and compatible with `vim.handleKeys`.
   - Remaps with both `after` and `commands`: VSCodeVim executes `after` first, then `commands`; keep this ordering compatible.
   - Recursive mapping edge cases: VSCodeVim has guards for RHS starting with LHS, recursive map depth, and force-stop behavior. Track these even if the patched synchronous architecture can keep the implementation simpler.
   - Command-line mode mappings: VSCodeVim supports `vim.commandLineModeKeyBindings*`; `vimcode` currently handles `:` input as a pending command string rather than a full command-line mode.
   - Key notation parity: expand toward VSCodeVim `Notation.NormalizeKey`, including `<Del>`, `<Insert>`, shifted/control variants, and exact arrow/control notation behavior.
   - `<Plug>` and plugin default mappings: VSCodeVim uses plug mappings for plugins such as Surround and EasyMotion. Model these when plugin compatibility work begins.
   - Ambiguous mappings without timeout: we probably do not want VSCodeVim's timeout machinery, but need a deliberate policy for mappings such as `a -> ...` and `ab -> ...` so users understand and can resolve differences.
2. **Core Vim completeness is high priority.** The disabled Zed fixture backlog is the main source of known core gaps. Prioritize user-visible editing semantics such as repeat/register/macro fidelity, visual selection exactness, text-object edge cases, marks/jumps, undo grouping, unicode/display-column behavior, folds/wrap integration, and VSCode-native movement semantics.
3. **Settings incompatibilities should be tracked, but not prioritized yet.** Keep registering settings we actively read so autocomplete works, and keep a compatibility matrix for ignored or unsupported VSCodeVim settings. Do not spend migration time implementing low-value settings before remaps and core editing behavior are solid.
4. **Plugin-style integrations are important but later.** Keep EasyMotion, Sneak, HighlightedYank, Commentary, ReplaceWithRegister, CamelCaseMotion/subword motions, and extra text objects in the backlog. Implement them as modules over explicit adapter capabilities rather than one-off key hacks.
5. **Command-line compatibility belongs in the backlog.** The current Ex command subset is useful, but VSCodeVim parity for `:normal`, `:nohl`, `:registers`, `:marks`, write/quit-style commands, richer substitute/search flags, and clear unsupported-command reporting remains tracked work.
6. **Digraphs are low priority but probably tractable.** Keep digraph insert/find/replace fixtures in the backlog; they are not migration-critical for current users, but may be a relatively self-contained improvement.
7. **VSCode-native behavior needs integration tests.** Undo/redo, folds, wrapped lines, viewport scrolling, native search UI, multi-cursor lowering, and cursor rendering require patched-VSCode verification in addition to the in-memory/Neovim fixture harness.

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

| Local path             | Zed reference                                   | Notes                                                                                                                                  |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/vim/vim.ts`       | `vim.rs`, `vim::Vim`                            | High-level mode/state coordinator only. Avoid moving normal/visual/motion/object details back into this file.                          |
| `src/vim/state.ts`     | `state.rs`                                      | Modes, operators, selections, and shared state vocabulary.                                                                             |
| `src/vim/motion.ts`    | `motion.rs`                                     | `Motion`, key-to-motion mapping, point movement, and motion ranges. Motions should be registered/mapped here once and shared by modes. |
| `src/vim/normal.ts`    | `normal.rs`                                     | Normal-mode dispatch and pending operator grammar.                                                                                     |
| `src/vim/normal/*`     | `normal/*`                                      | Operator/action implementations such as change/delete/yank/paste/search.                                                               |
| `src/vim/search.ts`    | `search::BufferSearchBar`                       | Adapter-neutral search types and fake model-buffer matching; production search is delegated to VSCode.                                  |
| `src/vim/visual.ts`    | `visual.rs`                                     | Visual-mode state and visual interpretation of motions/actions. Do not duplicate motion key maps here.                                 |
| `src/vim/object.ts`    | `object.rs`                                     | Text objects.                                                                                                                          |
| `src/vim/insert.ts`    | `insert.rs` plus insert-related normal commands | Insert-mode behavior and insert command helpers.                                                                                       |
| `src/vim/registers.ts` | `state::Register` / `VimGlobals.registers`      | Local register model until state grows closer to Zed.                                                                                  |
| `src/vim/selection_geometry.ts` | `visual.rs` selection expansion | Single owner of the boundary<->character-cell conversion between native exclusive selections and inclusive Vim geometry (raise/lower/canonicalize/render cursor). Zed has no such layer because its editor shares Vim's selection model. |
| `src/vim/test/*`       | `test/*`                                        | Neovim-backed harness and fixture machinery.                                                                                           |
| `src/vim/test_data/*`  | `test_data/*`                                   | Fixture-driven compatibility backlog.                                                                                                  |

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
   Progress so far:
   - `VimKeymapContext` now mirrors Zed's key context: `{ mode, operator }` where
     `operator` is `VimOperatorStack.operatorContext()` (Zed `vim_operator`:
     `none`/`delete`/`change`/`yank`/`object`/`other`), replacing five overlapping
     booleans. This fixed a real disambiguation bug: `di'`/`da\`` no longer lose the
     quote key to the `'`/`` ` `` jump bindings.
   - `J`, `ctrl-a`, `ctrl-x` are single shared bindings (with a `cumulative` flag
     distinguishing `g ctrl-a`); the `join`/`incrementStep` `NormalCommand`/
     `VisualCommand` duplicates are gone, and `v`/`V`/`ctrl-v` resolve to one
     `toggleVisual` action in both normal and visual mode.
   - `] }`, `] )`, `[ {`, `[ (`, `] space`, `[ space` are plain finite chords; the
     `pushUnmatched` waiting-operator type and its plumbing are deleted.
   - Waiting-input dispatch is unified: `VimOperatorStack.waitingInput` is the single
     classification of what the stack is waiting for (top-level pending operators and
     normal/visual operator inputs), with its variant order as the one precedence
     list, dispatched once in `Vim.dispatchKey` (`dispatchWaitingInput`) before any
     keymap resolution. Waiting input structurally beats bindings, so binding
     conditions no longer need to encode dispatch order. This fixed real bugs:
     waiting-input keys are now macro-recorded (macros containing `f x`, `/foo`,
     `"a`, `ma` replay correctly), and `f q`/`m q` while recording no longer stop
     the recording.
   - Recording is positionally uniform: macro and repeat recording happen once in
     `dispatchKey` before any keymap resolution; whether a key starts/extends a
     dot-repeat recording is decided by `RepeatState` (start-key filter, in-flight
     recordings) and non-repeatable actions cancel in their dispatch arms. The
     `beforeRepeat` phase is gone (merged into the fallback resolver), and `d'a`
     dot-repeat now works (jump targets are repeat-recorded).
   - Dispatch results are named: `KeyDispatchResult` (`"handled"` | `"native"`)
     replaces the `KeyResult | null | undefined` sentinel soup; `"native"` means
     Vim explicitly declines the key for the host editor's default handling, and
     `undefined` (resolver-internal only) means "not mine, try the next resolver".
   - The operator pipeline redesign ([doc/operator-redesign.md](doc/operator-redesign.md))
     is implemented. `src/vim/operator_target.ts` owns target production
     (`operatorTarget`/`lineOperatorTarget`/`rowOperatorTarget`/
     `textObjectOperatorTarget`, visual lowering in `visual.ts`) and the one
     operator dispatch (`applyOperatorToTarget`); `normal/{delete,change,yank,
     convert,indent}.ts` each expose one `apply*` total over target kinds.
     Convert (`gu`/`gU`/`g~`/`g?`) and indent (`>`/`<`/`=`) are first-class range
     operators resolving counts/motions/objects/jumps/forced motions through the
     central grammar; `ys` captures its range through the keymap too, and only
     true char-consumers remain waiting input. Doubling is one rule
     (`operatorPendingKey` + `lineOperation`, checked ahead of every keymap phase
     so `g??` beats backward search): `dd`/`cc`/`yy`/`guu`/`gugu`/`>>`/`yss`.
     Visual charwise/linewise d/y/c/convert/indent dispatch through the same
     `apply*` modules (blockwise stays bespoke until a blockwise target variant
     exists). Behavior fixed along the way (regression tests in
     `src/vim/operator_target.test.ts`, nvim-verified): `yG`/`y3G` were a silent
     no-op stub, `gu3w`-style counts and `gufX`/`guG`/`gu'a` targets did not
     resolve, `gub` left the cursor in place instead of the range start,
     `ys3w` counts were swallowed, visual-line `c` lost indentation (now matches
     `cc` and nvim-with-autoindent), and `g?` rot13 landed as a binding plus
     vocabulary with zero dispatch changes (`test_change_rot13_*` enabled).
   Remaining for the big step: migrate the single-key switches
   (`resolveMotionModeAction`, `normalCommandForKey`, `visualCommandForKey`,
   `motionForKey` dispatch) into the finite binding table with per-binding context
   predicates over `VimKeymapContext`, using a temporary differential oracle (new
   table vs old phases over the enumerated context space) to keep each batch
   provably behavior-preserving. All ordering prerequisites are done: waiting input
   is structurally first, recording is positionally uniform, and the two remaining
   phases (`motionMode`, `normalFallback`) differ only in binding precedence.
   Known dot-repeat gap to fix alongside: `isRepeatableStartKey` is missing `J`,
   `X`, `D`, `C`, `s`, `S`, so `.` does not repeat those changes yet.
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

Medium-term (all done):

1. ~~Text objects~~ — word/paragraph/sentence/quote/bracket objects and object operators.
2. ~~Visual and visual-line mode~~.
3. ~~Visual-block representation and lowering~~.
4. ~~Surround~~ — `ys`, `cs`, `ds`, visual surround.
5. ~~Basic search~~ — `/`, `?`, `n`, `N`, search-as-motion, `gn`/`cgn`.
6. ~~Neovim-backed comparison harness~~ — fixture replay plus `VIMCODE_RECORD_NEOVIM=1`
   regeneration; the Zed fixture import is complete (see Testing strategy).
7. ~~VSCode patch integration~~ — `vscode-contrib/` plus `vscode-contrib/patches/`.

Longer-term:

1. Implement Helix as an alternate keymap/dialect over the same core primitives
   (the `dialect` field and select-mode state exist; the keymap does not yet).
2. ~~Dot repeat and macro recording/replay~~ — done.
3. ~~Marks and changelist~~ — done. Jumplist is an intentional non-goal for now:
   `ctrl-o`/`ctrl-i` use VSCode's native navigation history (see the disabled-fixture
   rationale under Testing strategy).
4. ~~Advanced registers~~ — named/numbered/black-hole/append/small-delete/system
   clipboard registers are done.
5. ~~Display-line motions with soft wrap through the VSCode adapter~~ — done
   (`moveByViewLines`); the in-memory host intentionally has no display map.
6. Folds-aware movement: fold commands are wired through `executeFoldCommand`; deeper
   fold-aware motion fidelity is host-integration work (fixtures parked).
7. Language/tree-sitter-aware objects and `%` matching: parked; host/language-service
   territory (fixtures parked, see Testing strategy).
8. VSCodeVim-compat config layer expansion and language-capability design as user
   demand dictates.

## Testing strategy

Testing should stay centered on the editor capability interface.

Zed's approach

Zed's `test::neovim_backed_test_context::NeovimBackedTestContext` keeps a Zed editor and a Neovim instance in sync. Tests call helpers such as `set_shared_state`, `simulate_shared_keystrokes`, `simulate`, `shared_state`, and `shared_clipboard`. The backing `test::neovim_connection::NeovimConnection` can either talk to live embedded Neovim or replay recorded JSON test data. State is represented as marked text, with `ˇ` for the cursor and visual markers for selections.

Our first migration step is intentionally smaller: `src/vim/neovim.test.ts` discovers every JSON-line fixture in `src/vim/test_data/*.json`. Enabled files replay the recorded Neovim result; files whose first header is `// DISABLED: <reason>` become skipped Jest tests. Set `VIMCODE_RECORD_NEOVIM=1` while running the Neovim-backed tests to regenerate enabled fixtures from short-lived `nvim --headless` processes. The marked-text helper supports single-cursor `ˇ` text, charwise visual markers (`«...ˇ...»`, including reversed rendering), linewise raw anchor/cursor-cell markers mirroring Zed's encoding, rectangular visual-block markers, and explicit `ReadRegister` fixture entries. Multi-selection fixtures and parsing backward visual selections from `Put` states remain unsupported (see the harness-shape bucket in the disabled-fixture rationale).

Zed fixture migration policy

Zed has hundreds of fixture files under `crates/vim/test_data/*.json`, and the migration is complete: they all live in `src/vim/test_data/`, which is the source of truth for compatibility work (the fixture filename is the Jest test id). The policy below remains for any future fixtures imported from a newer Zed reference commit or recorded fresh from Neovim.

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

The Zed fixture import is complete: every Zed `crates/vim/test_data` fixture lives in
`src/vim/test_data/`, 522 are enabled, and the 28 disabled files below are a terminal
state, not a to-do list.

Disabled fixtures are a terminal, documented state

The remaining 28 disabled fixtures were reviewed bucket-by-bucket and deliberately left
disabled (decision: most cover behavior the patched VSCode host provides natively, and
duplicating it in the model-buffer harness is not worth the work). Do not re-enable or
re-implement these without revisiting the decision:

- Jump list, 5 (`test_jump_list`, `test_ctrl_o_dot`, `test_ctrl_o_position`,
  `test_ctrl_o_visual`, `test_scroll_jumps`): `ctrl-o`/`ctrl-i` map to VSCode's native
  `navigateBack`/`navigateForward` history instead of a model-level Vim jumplist. This
  is an intentional host-navigation choice; a Vim-faithful jumplist would be a product
  decision first, an implementation second.
- Language-aware matching, 7 (`test_matching_comments`,
  `test_matching_preprocessor_directives`, `test_matching_tags`,
  `test_matching_tag_with_quotes`, `test_percent_in_comment`,
  `test_unmatched_forward_markdown`, `test_o_comment`): `%` on comments/preprocessor
  directives/HTML tags/template delimiters and `o` comment continuation need language
  awareness (Zed: tree-sitter). In VSCode this is host/language-service territory;
  the core keeps the text-based bracket slice.
- Soft-wrap display map, 4 (`test_wrapped_lines`, `test_wrapped_motions`,
  `test_wrapped_delete_end_document`, `test_horizontal_scroll`): display-line movement
  under `wrap`/`columns=N` and horizontal scrolling. The real host handles this through
  `moveByViewLines`/the view model; the in-memory host intentionally has no display map.
- `U` undo-line, 3 (`test_undo_last_line*`): needs Zed-style change-list anchors plus
  undo/redo replay against the *host* undo stack; a core-only implementation would not
  work against VSCode's native undo.
- Folds, 2 (`test_folds`, `test_folds_panic`): VSCode-native folding; fold commands go
  through `executeFoldCommand` to the host.
- `gq` rewrap, 1 (`test_gq`): the rewrap operator is not implemented; parked as a
  candidate `RangeOperator` if a wrap-width capability (`textwidth`/editor setting)
  ever becomes worth adding.
- Harness-shape gaps, 5 (`neovim_backed_test_context_works`, `test_neovim`,
  `test_del_marks`, `test_digraph_insert_multicursor`,
  `test_paragraph_object_with_landing_positions_not_at_beginning_of_line`): empty or
  non-Put/Get fixture files (harness self-tests, `:delmarks` state assertions,
  multicursor setup). If one becomes worth having, the `test_visual_sentence_object`
  approach works: reconstruct the cases from Zed's old test source and record fresh
  against local `nvim --headless`.
- Intentional divergence, 1 (`test_substitute_line`): visual `S` belongs to
  vim-surround (VSCodeVim compatibility), not Vim's substitute-lines.

The right validation surface for the host-side buckets (jump list, folds, soft wrap,
language-aware matching, `U`) is VSCode adapter integration testing, not core fixture
replay.

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

The script copies production core files from `src/vim` into the VSCode checkout, excluding tests and fixtures, copies `vscode-contrib/browser` into the VSCode contribution directory, adds Microsoft copyright headers to copied core files when needed, and applies the patches under `vscode-contrib/patches`.

Current patch files:

- `editor-vim-contribution.patch`: imports the Vim editor contribution from `src/vs/editor/editor.all.ts`.
- `workbench-vim-status.patch`: imports the workbench status bar contribution.
- `vim-cursor-rendering.patch`: preserves Vim cursor cells through VSCode selection rendering.
- `vim-half-block-cursor.patch`: adds the native half-block cursor style used for pending operators.
- `vim-mouse-hit-testing.patch`: floors Vim-mode mouse hit testing to character cells and extends charwise drags by whole cells.
- `vim-selection-start-kind-event.patch`: exposes VSCode's existing primary `SelectionStartKind` on cursor-selection events so the adapter can distinguish double-click word selections from ordinary mouse drags without changing `event.source`.

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

Mouse and selection-sync invariants

Cursor alignment bugs (clicks landing one character off, stale block cursors after
mouse interaction with visual mode) repeatedly came from having multiple translation
points between VSCode's boundary-based selections and Vim's character-cell model.
The design now enforces three invariants; new mouse/selection work should preserve
them rather than adding case-specific guards:

1. One mouse rounding point. In Vim block-cursor mode (`.vim-character-mode-enabled`),
   hit testing floors the mouse position to the start of the character cell under the
   pointer (`MouseTargetFactory.createMouseTargetFromHitTestPosition` in
   `vim-mouse-hit-testing.patch`). Every native consumer — plain clicks, drags,
   drag-and-drop drop targets, word/line select seeds, multicursor clicks — shares the
   floored position, so VSCode's own gesture logic stays untouched. The only other
   mouse-specific rule is one direction-aware cell-extension hook in
   `CursorMoveCommands.moveTo` so charwise drags include both the anchor cell and the
   pointed-at cell, mirroring the native word/line range-anchor model. The adapter
   reads `SelectionStartKind` from `vim-selection-start-kind-event.patch` when
   deciding whether a one-character selection should become Vim visual mode: ordinary
   mouse drags stay collapsed to normal mode, while double-click word selections
   (`SelectionStartKind.Word`) enter visual mode even for one-character words.
2. Canonical write-back, but only when it changes meaning. After every external sync,
   `Vim.syncFromEditorState` compares the adopted selections against their canonical
   form. Selections whose canonicalization changes the raised Vim geometry are
   rewritten through `editor.setSelections`; canonical-equivalent shapes (including
   boundary re-encodings such as a full-line selection ending at the next line start,
   and un-extended backward selections, which Neovim also never swaps) are left
   untouched, because calling `setSelections` mid-gesture destroys native cursor
   state such as the word/line range anchor of a double/triple-click drag.
   Conversions go through `src/vim/selection_geometry.ts`, the single owner of the
   boundary<->cell convention, with round-trip property tests. Vim-sourced selection
   events are ignored by the controller, so the write-back cannot loop.
3. One render-cursor writer. The adapter always attaches explicit cursor cells
   (`vim.cursorPositions` source channel) when lowering selections, which also forces a
   view cursor refresh even when the model state is unchanged. The view-side heuristic
   in `vim-cursor-rendering.patch` remains only as fallback for selection changes that
   do not go through `setSelections` (e.g. `executeEdits` cursor states).

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

## Manual verification checklist

After syncing into the VSCode checkout and letting the watch build settle, verify these
areas in a real editor buffer:

- External VSCode selection sync
  - With Vim in normal mode, select text with the mouse: Vim status should switch to visual mode and selection should get Vim visual rendering/cursor behavior.
  - With Vim in visual mode, click to a zero-width cursor or undo/redo to a zero-width selection: Vim status should switch back to normal mode.
  - External multicursor/selection changes should be translated as plain charwise Vim selections when they do not match Vim's cached semantic state.
- Mouse character-cell behavior (normal/visual modes)
  - Clicking anywhere on a character (including its right half) parks the normal cursor on that character.
  - Dragging from one character to another selects both end cells inclusively; dragging back shrinks the selection cell by cell, and reversing direction across the anchor keeps the anchor cell selected.
  - Tiny in-cell drags do not enter visual mode.
  - Regression: select one character via drag (e.g. drag b -> c -> b in `abc`), then click the right half of a previous character; the cursor must land exactly on the clicked character with no stale block cursor (previously it could show on the old selection end).
  - Clicking on an existing selection (drag-and-drop deferral path) and releasing without movement parks the cursor on the clicked cell.
  - Double-click still selects the word under the pointer; double-click drag extends word-wise in both directions and dragging backwards keeps the double-clicked word selected; triple-click selects lines and triple-click drag keeps the clicked line selected.

Known caveats still intentionally not fully covered:

- Full visual search repeat fixture (`test_v_search`) has empty-search forward/backward edge cases still disabled.
- Full paragraph/sentence object fixtures have blank-line and punctuation edge cases beyond the current first slice.
- Full `test_r`, `test_replace_mode_with_counts`, and full dot-repeat fixtures include newline and Zed Put-with-preserved-repeat-state cases beyond the current first slice.
- Full dot-repeat register fixtures need exact repeat-register semantics for numbered-register paste.
- Full macro replay fixtures still need richer replay-while-recording and macro/dot interaction semantics.
- Full matching/jump fixtures still need language-aware matching for comments, tags, preprocessor directives, visual builtin marks, and the jumplist.
- VSCode-contrib files are type-checked by the VSCode build after sync, not by the local `npm run build -- --noEmit` command.

Useful local commands after source changes:

```sh
npm run build -- --noEmit
npm test -- --runInBand
```

The npm commands may print existing `.npmrc` proxy warnings; those warnings are not currently test failures.

For VSCode manual testing, run the VSCode watch/server commands in separate terminals as usual, then manually run:

```sh
./scripts/sync-vscode-contrib.sh /path/to/vscode
```
