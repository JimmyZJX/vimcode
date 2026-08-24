# Agent instructions

Read `README.md` before changing `src/vim` or the VSCode Vim rewrite plan.

This branch is intentionally replacing the old `vimcode` implementation with a Zed-inspired Vim/Helix implementation for a patched VSCode integration. Do not preserve old chord-menu code or tests for their own sake.

When translating behavior from Zed, add source comments using stable Zed module/type/function names rather than brittle line numbers. See `README.md` for the current Zed reference commit, source map, completed work, and next steps.
