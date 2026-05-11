// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `test::neovim_backed_test_context::NeovimBackedTestContext`
// - translated concepts: run the same initial state and keystrokes in Neovim and the
//   local editor, then compare marked text/mode/registers
// - intentional differences: this is a synchronous Jest helper and fixtures are the
//   source of truth for which tests exist.

import { RegisterName } from "../registers.js";
import { runKeys } from "../vim.js";
import { editorFromMarkedText, markedTextFromEditor } from "./marked_text.js";
import { EnabledNeovimFixture } from "./neovim_fixtures.js";

export type SharedState = {
  neovim: EnabledNeovimFixture["result"];
  local: {
    mode: string;
    markedText: string;
    registers: Record<string, string>;
  };
  initialState: string;
  keys: readonly string[];
};

export function simulateFixture(fixture: EnabledNeovimFixture): SharedState {
  const { editor, vim } = editorFromMarkedText(fixture.initialState);
  runKeys(vim, fixture.keys);
  const localRegisters = Object.fromEntries(
    Object.keys(fixture.result.registers ?? {}).map((register) => [
      register,
      vim.readRegister(register as RegisterName),
    ])
  );
  return {
    neovim: fixture.result,
    local: {
      mode: vim.mode.kind,
      markedText: markedTextFromEditor(editor),
      registers: localRegisters,
    },
    initialState: fixture.initialState,
    keys: fixture.keys,
  };
}

export function expectFixtureMatchesNeovim(fixture: EnabledNeovimFixture): void {
  const shared = simulateFixture(fixture);
  expect(shared.local).toEqual({
    mode: shared.neovim.mode,
    markedText: shared.neovim.markedText,
    registers: shared.neovim.registers ?? {},
  });
}
