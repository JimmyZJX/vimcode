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

After syncing, VSCode also needs this import added to `src/vs/editor/editor.all.ts`:

```ts
import './contrib/vim/browser/vim.contribution.js';
```

The sync script can patch that import automatically.
