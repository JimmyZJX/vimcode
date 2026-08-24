// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: Zed tests using `test::neovim_backed_test_context::NeovimBackedTestContext`
// - translated concepts: behavior-level comparison against recorded Neovim fixtures
// - intentional differences: `src/vim/test_data/*.json` is the source of truth for the
//   test list. Files with a `// DISABLED: <reason>` header become skipped Jest tests.

import { expectFixtureMatchesNeovim } from "./test/neovim_backed_test_context.js";
import { readAllFixtures } from "./test/neovim_fixtures.js";

describe("Neovim-backed compatibility fixtures", () => {
  for (const fixture of readAllFixtures()) {
    if (fixture.status === "disabled") {
      it.skip(`${fixture.testCaseId} // DISABLED: ${fixture.reason}`, () => {});
    } else {
      it(fixture.testCaseId, () => {
        expectFixtureMatchesNeovim(fixture);
      });
    }
  }
});
