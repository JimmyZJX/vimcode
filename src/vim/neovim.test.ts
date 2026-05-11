// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: Zed tests using `test::neovim_backed_test_context::NeovimBackedTestContext`
// - translated concepts: behavior-level comparison against Neovim for supported keys
// - intentional differences: enabled tests start with a tiny subset that the current core
//   already intends to support; skipped tests document migrated expectations for features
//   or edge cases that are not ready yet.

import {
  expectMatchesNeovim,
  expectRegisterMatchesNeovim,
} from "./test/neovim_backed_test_context.js";

describe("Neovim-backed smoke tests", () => {
  it("moves by word with counts", () => {
    expectMatchesNeovim({
      testCaseId: "moves_by_word_with_counts",
      initialState: "ˇone two three",
      keys: ["2", "w"],
    });
  });

  it("inserts and returns to normal mode", () => {
    expectMatchesNeovim({
      testCaseId: "inserts_and_returns_to_normal_mode",
      initialState: "ˇabc",
      keys: ["l", "i", "X", "<escape>"],
    });
  });

  it("deletes by word motion", () => {
    expectMatchesNeovim({
      testCaseId: "deletes_by_word_motion",
      initialState: "ˇone two three",
      keys: ["d", "w"],
    });
  });

  it("deletes whole lines", () => {
    expectMatchesNeovim({
      testCaseId: "deletes_whole_lines",
      initialState: "ˇalpha\nbeta\ngamma",
      keys: ["2", "d", "d"],
    });
  });

  it("opens a line below", () => {
    expectMatchesNeovim({
      testCaseId: "opens_a_line_below",
      initialState: "ˇalpha\nbeta",
      keys: ["o", "x", "<escape>"],
    });
  });

  it("yanks into a named register", () => {
    expectRegisterMatchesNeovim({
      testCaseId: "yanks_into_a_named_register",
      initialState: "ˇone two",
      keys: ["\"", "a", "y", "w"],
      register: "a",
    });
  });
});

describe("Migrated Neovim-backed tests waiting for implementation", () => {
  // DISABLED: Vim's `cw` uses special word-change semantics; current `changeMotion`
  // simply deletes the same range as `dw`, including trailing whitespace.
  it.skip("changes word with Vim cw semantics", () => {
    expectMatchesNeovim({
      testCaseId: "changes_word_with_vim_cw_semantics",
      initialState: "ˇone two",
      keys: ["c", "w", "X", "<escape>"],
    });
  });

  // DISABLED: text-object grammar and `object::Object` translation have not been
  // added yet, so `ciw` is not parsed after a pending change operator.
  it.skip("changes inner word text object", () => {
    expectMatchesNeovim({
      testCaseId: "changes_inner_word_text_object",
      initialState: "one ˇtwo three",
      keys: ["c", "i", "w", "X", "<escape>"],
    });
  });

  // DISABLED: visual mode state and visual marker support in the test harness are
  // not implemented yet.
  it.skip("deletes a visual word selection", () => {
    expectMatchesNeovim({
      testCaseId: "deletes_a_visual_word_selection",
      initialState: "ˇone two three",
      keys: ["v", "w", "d"],
    });
  });

  // DISABLED: search UI/state integration and `/` key handling are not implemented.
  it.skip("searches forward and repeats the match", () => {
    expectMatchesNeovim({
      testCaseId: "searches_forward_and_repeats_the_match",
      initialState: "ˇone\ntwo\none",
      keys: ["/", "o", "n", "e", "enter", "n"],
    });
  });
});
