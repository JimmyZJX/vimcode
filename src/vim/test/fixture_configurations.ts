// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/test.rs
// - translated concepts: Zed's remap fixtures configure key bindings in the
//   test function body (`cx.bind_keys(...)` mirrored into Neovim with
//   `imap`/`map`/`noremap`), outside the recorded fixture file. This registry
//   carries the same per-fixture setup for the local harness, expressed as
//   VSCodeVim-compatible remappings.

import type { VimConfiguration } from "../config.js";

export const fixtureConfigurations: Record<string, Partial<VimConfiguration>> = {
  // Zed test_jk: `j k -> NormalBefore` in insert mode (`imap jk <esc>`).
  test_jk: {
    insertModeKeyBindings: [{ before: ["j", "k"], after: ["<Esc>"] }],
  },
  // Zed test_remap_adjacent_dog_cat: `imap dog 🐶`, `imap cat 🐱`.
  test_remap_adjacent_dog_cat: {
    insertModeKeyBindings: [
      { before: ["d", "o", "g"], after: ["🐶"] },
      { before: ["c", "a", "t"], after: ["🐱"] },
    ],
  },
  // Zed test_remap_nested_pineapple: `imap pin 📌`, `imap pine 🌲`,
  // `imap pineapple 🍍` — exercises longest-match disambiguation through the
  // remap timeout.
  test_remap_nested_pineapple: {
    insertModeKeyBindings: [
      { before: ["p", "i", "n"], after: ["📌"] },
      { before: ["p", "i", "n", "e"], after: ["🌲"] },
      { before: ["p", "i", "n", "e", "a", "p", "p", "l", "e"], after: ["🍍"] },
    ],
  },
  // Zed test_remap_recursion: `noremap x "_x`, `map y 2x` — `y` re-enters the
  // `x` mapping recursively, `x` itself must not recurse.
  test_remap_recursion: {
    normalModeKeyBindingsNonRecursive: [{ before: ["x"], after: ["\"", "_", "x"] }],
    normalModeKeyBindings: [{ before: ["y"], after: ["2", "x"] }],
  },
};
