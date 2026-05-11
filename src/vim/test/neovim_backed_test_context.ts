// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `test::neovim_backed_test_context::NeovimBackedTestContext`
// - translated concepts: run the same initial state and keystrokes in Neovim and the
//   local editor, then compare marked text/mode
// - intentional differences: this is a synchronous Jest helper and only supports the
//   normal/insert subset represented by the current TypeScript core.

import { RegisterName } from "../registers.js";
import { runKeys } from "../vim.js";
import { editorFromMarkedText, markedTextFromEditor } from "./marked_text.js";
import {
  NeovimFixture,
  readFixture,
  shouldRecordNeovimFixtures,
  writeFixture,
} from "./neovim_fixtures.js";
import { NeovimState, neovimAvailable, runNeovim } from "./neovim_connection.js";

export type SharedState = {
  neovim: NeovimState;
  local: {
    mode: string;
    markedText: string;
  };
  initialState: string;
  keys: readonly string[];
};

export function simulateWithNeovim({
  testCaseId,
  initialState,
  keys,
  readRegisters = [],
}: {
  testCaseId: string;
  initialState: string;
  keys: readonly string[];
  readRegisters?: readonly string[];
}): SharedState {
  const neovim = neovimStateForTest({ testCaseId, initialState, keys, readRegisters });
  const { editor, vim } = editorFromMarkedText(initialState);
  runKeys(vim, keys);
  return {
    neovim,
    local: { mode: vim.mode.kind, markedText: markedTextFromEditor(editor) },
    initialState,
    keys,
  };
}

export function expectMatchesNeovim({
  testCaseId,
  initialState,
  keys,
}: {
  testCaseId: string;
  initialState: string;
  keys: readonly string[];
}): void {
  const shared = simulateWithNeovim({ testCaseId, initialState, keys });
  expect(shared.local).toEqual({
    mode: shared.neovim.mode,
    markedText: shared.neovim.markedText,
  });
}

export function expectRegisterMatchesNeovim({
  testCaseId,
  initialState,
  keys,
  register,
}: {
  testCaseId: string;
  initialState: string;
  keys: readonly string[];
  register: RegisterName;
}): void {
  const shared = simulateWithNeovim({ testCaseId, initialState, keys, readRegisters: [register] });
  const expected = shared.neovim.registers?.[register] ?? "";
  const { vim } = editorFromMarkedText(initialState);
  runKeys(vim, keys);
  expect(shared.local).toEqual({
    mode: shared.neovim.mode,
    markedText: shared.neovim.markedText,
  });
  expect({ local: vim.readRegister(register), neovim: expected }).toEqual({
    local: expected,
    neovim: expected,
  });
}

function neovimStateForTest({
  testCaseId,
  initialState,
  keys,
  readRegisters,
}: {
  testCaseId: string;
  initialState: string;
  keys: readonly string[];
  readRegisters: readonly string[];
}): NeovimState {
  const fixture = readFixture(testCaseId);
  if (!shouldRecordNeovimFixtures() && fixture !== undefined) {
    assertFixtureMatchesRequest(testCaseId, fixture, { initialState, keys });
    return fixture.result;
  }

  if (!neovimAvailable()) {
    throw new Error(`Neovim fixture ${testCaseId} is missing and live nvim is unavailable`);
  }

  const result = runNeovim({ initialState, keys, readRegisters });
  if (shouldRecordNeovimFixtures() || fixture === undefined) {
    writeFixture(testCaseId, { initialState, keys, result });
  }
  return result;
}

function assertFixtureMatchesRequest(
  testCaseId: string,
  fixture: NeovimFixture,
  request: { initialState: string; keys: readonly string[] }
): void {
  expect({ initialState: fixture.initialState, keys: fixture.keys }).toEqual(request);
}
