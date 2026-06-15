# VSCode contribution prototype

This directory contains the VSCode-specific patch layer for the Vim core in `src/vim`.

It is intentionally outside `src/` so it does not participate in the `vimcode` package build. The files here are meant to be copied into a VSCode/code-oss checkout by `scripts/sync-vscode-contrib.sh`.

Target layout in VSCode:

```text
src/vs/editor/contrib/vim/
  browser/
    vim.contribution.ts
    vimController.ts
    vscodeClipboard.ts
    vscodeVimEditor.ts
  common/
    editor.ts
    insert.ts
    motion.ts
    normal.ts
    object.ts
    registers.ts
    state.ts
    vim.ts
    visual.ts
    normal/
      change.ts
      delete.ts
      paste.ts
      yank.ts
```

The sync script also applies `vscode-contrib/patches/*.patch`. The key patches are:

- `editor-vim-contribution.patch` / `workbench-vim-status.patch`: import the editor and status-bar contributions.
- `vim-cursor-rendering.patch` / `vim-half-block-cursor.patch`: cursor-cell rendering and pending-operator cursor style.
- `vim-mouse-hit-testing.patch`: Vim character-cell mouse hit testing and charwise drag extension.
- `vim-selection-start-kind-event.patch`: exposes VSCode's existing `SelectionStartKind` on cursor-selection events so the adapter can handle one-character double-click word selections without changing `event.source`.
