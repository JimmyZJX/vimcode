// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `test::neovim_backed_test_context::NeovimBackedTestContext`
// - translated concepts: run the same initial state and keystrokes in Neovim and the
//   local editor, then compare marked text/mode/registers
// - intentional differences: this is a synchronous Jest helper and fixtures are the
//   source of truth for which tests exist.

import { parseRegisterName } from "../registers.js";
import { Vim, runKeys } from "../vim.js";
import { InMemoryVimEditor } from "../editor.js";
import { editorFromMarkedText, markedTextFromEditor } from "./marked_text.js";
import { EnabledNeovimFixture } from "./neovim_fixtures.js";

export type SharedState = {
  local: {
    mode: string;
    markedText: string;
    registers: Record<string, string>;
  };
};

export function simulateFixture(fixture: EnabledNeovimFixture): SharedState {
  let editor: InMemoryVimEditor | undefined;
  let vim: Vim | undefined;
  const registers: Record<string, string> = {};

  let step = 0;
  let currentScenario: string[] = [];
  for (const entry of fixture.entries) {
    step++;
    if ("Put" in entry) {
      currentScenario = [`Put ${entry.Put.state}`];
      ({ editor, vim } = editorFromMarkedText(entry.Put.state));
    } else if ("Key" in entry) {
      currentScenario.push(`Key ${entry.Key}`);
      const currentVim = requireVim(vim, fixture.testCaseId);
      runKeys(currentVim, [keyForLocalVim(entry.Key)]);
    } else if ("SetOption" in entry) {
      // Zed fixtures may contain Neovim UI options (e.g. wrap/columns) that do
      // not affect the model-buffer semantics supported by this harness yet.
    } else if ("Exec" in entry) {
      // Some Zed fixtures set filetype or other Neovim-local state. The current
      // model-buffer harness ignores those unless a fixture explicitly needs a
      // language-aware capability.
    } else if ("ReadRegister" in entry) {
      const currentVim = requireVim(vim, fixture.testCaseId);
      const registerName = parseRegisterName(entry.ReadRegister.name);
      const registerToRead = entry.ReadRegister.name as Parameters<typeof currentVim.readRegister>[0];
      if (registerName === undefined && !["-", "/", "_", "+", "*"].includes(entry.ReadRegister.name)) {
        throw new Error(`unsupported register ${entry.ReadRegister.name} in ${fixture.testCaseId}`);
      }
      registers[entry.ReadRegister.name] = currentVim.readRegister(registerName ?? registerToRead);
      expect(registers[entry.ReadRegister.name]).toBe(entry.ReadRegister.value);
    } else {
      const currentEditor = requireEditor(editor, fixture.testCaseId);
      const currentVim = requireVim(vim, fixture.testCaseId);
      const actual = { mode: currentVim.mode.kind, markedText: markedTextFromEditor(currentEditor, currentVim.mode.kind) };
      const expected = { mode: entry.Get.mode, markedText: entry.Get.state };
      try {
        expect(actual).toEqual(expected);
      } catch (error) {
        throw new Error(
          `fixture ${fixture.testCaseId} mismatch at step ${step}\n${currentScenario.join("\n")}\n${(error as Error).message}`
        );
      }
    }
  }

  const currentEditor = requireEditor(editor, fixture.testCaseId);
  const currentVim = requireVim(vim, fixture.testCaseId);
  return {
    local: {
      mode: currentVim.mode.kind,
      markedText: markedTextFromEditor(currentEditor),
      registers,
    },
  };
}

export function expectFixtureMatchesNeovim(fixture: EnabledNeovimFixture): void {
  simulateFixture(fixture);
}

function requireEditor(editor: InMemoryVimEditor | undefined, testCaseId: string): InMemoryVimEditor {
  if (editor === undefined) throw new Error(`fixture ${testCaseId} used editor state before Put`);
  return editor;
}

function requireVim(vim: Vim | undefined, testCaseId: string): Vim {
  if (vim === undefined) throw new Error(`fixture ${testCaseId} used Vim state before Put`);
  return vim;
}

function keyForLocalVim(key: string): string {
  switch (key) {
    case "escape":
      return "<escape>";
    case "enter":
      return "enter";
    default:
      break;
  }

  const shiftMatch = /^shift-(.)$/.exec(key);
  if (shiftMatch !== null) return shiftMatch[1].toUpperCase();

  return key;
}
