# VSCodeVim → vimcode migration audit

Goal: migrate VSCodeVim users to vimcode with minimal surprise. This compares
vimcode's implemented surface (source audit of `src/vim/` + `vscode-contrib/`)
against VSCodeVim's documented surface (README, settings schema). VSCodeVim
claims are from its documentation; where unverified against its source, they
are marked *(verify)*.

Method note: vimcode's semantics are pinned to **Neovim** via ~310 recorded
fixtures; VSCodeVim's semantics are hand-written and diverge from Vim in
places. Where the two disagree, "matches nvim" is our tie-breaker — but
migration friction is measured against *VSCodeVim* behavior, since that is
what users' muscle memory and settings encode.

## TL;DR — ranked migration blockers

1. ~~**Normal-mode `Y` is unbound**~~ **Fixed**: `Y` = `y$` (Neovim's default
   mapping, count/register-aware; pinned by `test_yank_to_eol`). Classic
   whole-line `Y` users can remap `Y` → `yy`. Divergence from VSCodeVim noted
   below.
2. ~~**No vim-commentary**~~ **Fixed**: `gc{motion}`/`gcc`/`gcgc` (linewise),
   `gC{motion|object}`/`gCC` (block), visual `gc`/`gC` — delegated to the
   native language-aware toggle-comment commands, dot-repeatable
   (`comment.test.ts`).
3. **`:s` replacement supports only `\0`, no capture groups (`\1`…), no `c`
   (confirm) / `i` flags, no `vim.inccommand` live preview.** `:s` power users
   will hit `\1` immediately.
4. **Search case controls missing**: no `vim.ignorecase` / `vim.smartcase`.
   Hardcoded behavior equals VSCodeVim's *defaults* (ignorecase+smartcase), so
   most users won't notice — but `ignorecase=false` users can't get their
   behavior back, and `\c`/`\C` pattern overrides don't work either.
5. **`vim.mode` when-clause values differ mid-chord and in prompts**:
   vimcode emits `Normal+` while a chord is pending, `Search`/`Command` for
   prompts (VSCodeVim: `SearchInProgressMode`/`CommandlineInProgress`, and a
   distinct `OperatorPendingMode`). Users' keybindings.json rules using
   `vim.mode == 'Normal'` etc. behave differently. Consider emitting
   VSCodeVim-compatible values (or additionally exposing compat aliases).
6. **Enablement model differs**: vimcode is opt-in via `vim.enabled`
   (default false); VSCodeVim is on-by-install with `vim.disableExtension`.
   Migration tooling must set `vim.enabled: true` for migrated users, or the
   rollout flips them to no-Vim.
7. **Tag text objects `it`/`at` and surround `t` targets missing** (VSCodeVim
   has both; web/XML users notice fast).
8. **Jumplist**: `ctrl-o`/`ctrl-i` are native VSCode nav history, not a Vim
   jumplist (deliberate). VSCodeVim implements a real jumplist. Behavior is
   *similar* but ordering/granularity differ; document rather than change,
   but expect questions.
9. **Custom digraphs**: `vim.digraphs` unsupported and the built-in digraph
   table is a ~7-entry stub (VSCodeVim ships the full RFC1345-ish table).
   Niche but a hard blocker for the users who need it.
10. ~~**`gb` unbound**~~ **Fixed**: `gb` aliases `gl`
    (add-cursor-at-next-match).

## Settings compatibility

vimcode already reads the `vim.*` namespace (mirrored as `vimcode.*`, which
wins when set), so existing settings.json files partially "just work".

### Supported, compatible

`vim.leader`, `vim.useCtrlKeys`, `vim.handleKeys` (same default map),
`vim.timeout`, `vim.easymotion`, `vim.easymotionKeys`,
`vim.easymotionJumpToAnywhereRegex`, and all eight remapping arrays
(`normal/insert/visual/operatorPending` × recursive/non-recursive) with
`before`/`after`/`commands` (string or `{command, args}`, `:`-commands run
through the ex executor), `silent`, plus vimcode extras VSCodeVim lacks:
per-mapping `recursive` override and `when` clauses. `vim.remap` command and
`toggleVim` command ids match.

### Supported, different default or semantics

| Setting | VSCodeVim | vimcode | Impact |
|---|---|---|---|
| `vim.useSystemClipboard` | default false | default **true** (VSCode-native feel) | migrated users get clipboard-as-unnamed unless set; decide one default for rollout |
| `vim.textwidth` | default 80 | 0 → first `editor.rulers` → 79 | `gq` width differs when unset; ruler detection is arguably better — document |
| enable/disable | `vim.disableExtension` (default false) | `vim.enabled` (default false) | **inverted opt-in**; migration must set `vim.enabled` |

### Read by VSCodeVim, missing in vimcode

Grouped by expected pain (settings silently ignored today — consider logging
unknown `vim.*` keys at startup as a migration aid):

- **Behavior, likely noticed**: `vim.ignorecase`, `vim.smartcase`,
  `vim.hlsearch` (vimcode: persistent highlight always on until `:noh`;
  VSCodeVim default off → migrated users see *more* highlighting),
  `vim.incsearch` (vimcode always on — matches VSCodeVim default),
  `vim.inccommand` (`:s` live preview — unimplemented),
  `vim.startInInsertMode`, `vim.changeWordIncludesWhitespace`,
  `vim.whichwrap` (vimcode hardcodes `b,s`-equivalent),
  `vim.joinspaces` (VSCodeVim default true = double space after `.`;
  vimcode is nvim-faithful single-space — behavior diff on `J`/`gq`),
  `vim.autoindent`, `vim.gdefault` (vimcode supports `:set gdefault` at
  runtime but not the *setting*), `vim.maxmapdepth`, `vim.report`,
  `vim.digraphs`, `vim.commandLineModeKeyBindings[NonRecursive]`.
- **Visual/UI**: `vim.cursorStylePerMode.*`, `vim.searchHighlightColor` (+3
  color settings), `vim.substitutionColor`/`TextColor`,
  `vim.highlightedyank.{enable,color,duration}`,
  `vim.statusBarColorControl` + `vim.statusBarColors.*` (airline),
  `vim.showcmd`/`vim.showmodename` (vimcode always shows),
  easymotion appearance settings (`vim.easymotionDimBackground` — VSCodeVim
  dims surrounding text by default; vimcode doesn't dim,
  `vim.easymotionMarker*` colors/weight).
- **Plugins** (see below): `vim.sneak*`, `vim.camelCaseMotion.enable`,
  `vim.replaceWithRegister`, `vim.surround` (vimcode surround is always-on,
  no off-switch), `vim.argumentObject*`, `vim.visualstar`.
- **Platform/exotic**: `vim.overrideCopy`, `vim.foldfix`,
  `vim.autoSwitchInputMethod.*`, `vim.vimrc.{enable,path}`,
  `vim.enableNeovim`/`vim.neovim*` (neovim-backed ex commands), `vim.shell`
  (no `:!` anyway), `vim.showQuickpickCmdLine` command.

Action: diff the full VSCodeVim `package.json` `contributes.configuration`
against `vim.contribution.ts` when building the config shim; the list above
is from the README plus known majors and may miss minor keys.

## Feature gaps (keys/commands)

### Tier 1 — daily-use, should fix before migration

- `Y` (normal) — unbound.
- `gcc`/`gc{motion}`/visual `gc`, `gC{object}` — commentary via native
  toggle-comment.
- `:s` capture groups `\1`–`\9` (and ideally `&`), `c` confirm flag.
- `it`/`at` tag objects; surround `t` target (`cst<`, `ysiwt`).
- `gb` alias for add-next-match cursor.
- `vim.mode` context-value compatibility for keybindings.json users.
- Vim-regex conveniences in search: at minimum translate `\<` `\>` word
  boundaries and `\c`/`\C` case overrides (VSCodeVim does *(verify scope)*;
  users type `/\<foo\>` reflexively).

### Tier 2 — common enough to schedule

- Indent objects `ii`/`ai`/`aI` (VSCodeVim always-on).
- Argument objects `ia`/`aa` (VSCodeVim always-on; delimiters configurable).
- `ae`/`ie` entire-buffer objects (always-on).
- ReplaceWithRegister `gr{motion}`/`grr` (opt-in but popular).
- `af` visual expand-selection (VSCodeVim special).
- Paste variants `gp`/`gP`/`]p`/`[p`.
- Ex: `:m[ove]`, `:t`/`:co[py]`, `:pu[t]`, `:reg[isters]`, `:marks`,
  `:delmarks`, `:>`/`:<`, `:sort` flags (`i`, `u`, `n`), `:s` repeat (`:s`,
  `&`), `:g` with more than `d`/`normal`.
- `U` (undo line) — nvim fixtures already recorded (disabled).
- Highlightedyank (cheap in-fork decoration; users like the feedback).
- `vim.cursorStylePerMode`.
- Multi-cursor escape semantics: VSCodeVim's two-stage escape
  (multi-visual → multi-normal → normal) *(verify)* vs vimcode collapse.

### Tier 3 — document as unsupported initially

Sneak, CamelCaseMotion, input-method switching, `.vimrc` parsing, neovim
ex-command delegation, airline status colors, `:!`/`:%!` shell filters,
expression register `=`/read-only registers, `zf` folds-as-operator,
command-line-mode remaps, `vim.visualstar`, quickpick cmdline, `ctrl-w`
`x/r/T/H/J/K/L`, `z.`-family, section motions `[[`/`]]`.

## Deliberate divergences (document in release notes, not bugs)

- **Insert mode is native-first**: ordinary typing/completion/snippets are
  VSCode-native and recorded for macro/dot replay via the host; keys outside
  the whitelist (e.g. `tab`, completion accept) are native and *not*
  replayed. VSCodeVim intercepts nearly everything; vimcode trades exact
  macro fidelity on host-UI keys for zero interference with IntelliSense.
- **`ctrl-o`/`ctrl-i`** = VSCode navigation history, not a Vim jumplist.
- **`%`** matches nvim's bundled matchit for brackets (and the failed-`d%`
  cursor-char quirk) but has no language-aware comment/tag/preprocessor
  matching yet.
- **`ctrl-c` in visual = yank** (VSCode-compat); visual `S` = surround (like
  VSCodeVim, unlike Vim's substitute).
- **Semantics tie-break to nvim** where VSCodeVim differs (e.g. joinspaces
  off, `cw`≈`ce` matching Vim special-case, register/count edge cases pinned
  by fixtures, and `Y` = `y$` per Neovim's default mapping — VSCodeVim yanks
  the whole line; remap `Y` → `yy` for the classic behavior).
- Persistent search highlight until `:noh` (Vim hlsearch-on behavior).

## vimcode advantages worth stating in the migration pitch

- In-core integration: no extension-host round trip per keystroke, no
  `extensions.experimental.affinity` workaround, no `type`-command conflicts.
- ~310 Neovim-recorded parity fixtures + per-key mode/session invariants;
  behavior regressions are caught mechanically.
- Insert mode never fights IntelliSense/snippets/IME by construction.
- Macros/dot-repeat replay *native* insert edits (auto-pairs, auto-indent)
  through the host.
- Remaps support VSCode `when` clauses and per-mapping `recursive` — beyond
  VSCodeVim.
- Search offsets (`/pat/e+2`), prompt history with prefix filtering, `gq`
  with comment leaders + `editor.rulers` detection, undo coalescing per
  insert session.

## Recommended sequence

1. ~~Cheap high-visibility fixes: `Y`, `gb` alias, commentary (`gc`/`gC`).~~
   Done.
2. Config shim: accept-and-honor `vim.ignorecase`/`vim.smartcase`/
   `vim.hlsearch`/`vim.startInInsertMode`; log ignored `vim.*` settings;
   decide the `useSystemClipboard` default; migration doc for
   `vim.enabled`.
3. `:s` capture groups + `c` flag; minimal Vim-regex translation
   (`\<`/`\>`, `\c`/`\C`).
4. `vim.mode` context compatibility values.
5. Text objects wave: `it`/`at` (+surround `t`), `ii`/`ai`, `ia`/`aa`,
   `ae`/`ie`.
6. Tier-2 ex commands and paste variants; highlightedyank;
   `cursorStylePerMode`.
7. Publish a "differences from VSCodeVim" page from the divergences section;
   collect dogfooder feedback before broad rollout.

## Verification follow-ups

- Diff VSCodeVim `package.json` settings schema against `vim.contribution.ts`
  (full key list, including minor ones not in its README).
- Verify VSCodeVim behaviors marked *(verify)* against its source before
  citing them in user-facing docs.
- Sample real users' settings.json / keybindings.json (grep for `vim.`) to
  weight the gap list by actual usage rather than guesswork.
