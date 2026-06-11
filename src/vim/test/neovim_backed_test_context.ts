// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `test::neovim_backed_test_context::NeovimBackedTestContext`
// - translated concepts: run the same initial state and keystrokes in Neovim and the
//   local editor, then compare marked text/mode/registers
// - intentional differences: this is a synchronous Jest helper and fixtures are the
//   source of truth for which tests exist.

import { RemapTimeoutKey } from "../config.js";
import { parseRegisterName } from "../registers.js";
import { Vim, runKeys } from "../vim.js";
import { InMemoryVimEditor } from "../editor.js";
import { fixtureConfigurations } from "./fixture_configurations.js";
import { editorFromMarkedText, markedTextFromEditor, resetEditorFromMarkedText } from "./marked_text.js";
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
  const viewportOptions: { lines?: number; scrolloff?: number } = {};

  let step = 0;
  let currentScenario: string[] = [];
  for (const entry of fixture.entries) {
    step++;
    if ("Put" in entry) {
      currentScenario = [`Put ${entry.Put.state}`];
      if (editor === undefined || vim === undefined) {
        // Some Zed fixtures configure key remappings in the test body rather
        // than the fixture file; mirror that setup here.
        ({ editor, vim } = editorFromMarkedText(entry.Put.state, fixtureConfigurations[fixture.testCaseId] ?? {}));
        editor.configureViewportForTest(viewportOptions);
      } else {
        resetEditorFromMarkedText(editor, vim, entry.Put.state);
      }
    } else if ("Key" in entry) {
      currentScenario.push(`Key ${entry.Key}`);
      // A few Zed fixtures contain empty key entries (recording artifacts);
      // Neovim treats them as no-ops.
      if (entry.Key.length === 0) continue;
      // Some fixtures type setup commands (`:set gdefault`) before the first
      // Put; run them against an empty scratch buffer.
      if (vim === undefined) {
        ({ editor, vim } = editorFromMarkedText("ˇ", fixtureConfigurations[fixture.testCaseId] ?? {}));
      }
      const localKey = keyForLocalVim(entry.Key);
      const dispatchResult = vim.onKey(localKey);
      // Keys the core leaves to the host (arrow keys in insert mode) take
      // effect natively in a real editor; emulate that for the in-memory
      // editor, including the undo split native cursor movement causes.
      if (dispatchResult === "native") {
        emulateNativeInsertKey(requireEditor(editor, fixture.testCaseId), requireVim(vim, fixture.testCaseId), localKey);
      }
    } else if ("SetOption" in entry) {
      // Zed fixtures may contain Neovim UI options (e.g. wrap/columns) that do
      // not affect the model-buffer semantics supported by this harness yet.
      // `lines`/`scrolloff` feed the in-memory viewport model so page motions
      // replay with the recorded window geometry.
      const lines = /^lines=(\d+)$/.exec(entry.SetOption.value);
      if (lines !== null) viewportOptions.lines = Number(lines[1]);
      const scrolloff = /^scrolloff=(\d+)$/.exec(entry.SetOption.value);
      if (scrolloff !== null) viewportOptions.scrolloff = Number(scrolloff[1]);
      editor?.configureViewportForTest(viewportOptions);
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
      // Zed advances the clock past the remap timeout before asserting;
      // resolve any ambiguous pending remap the same way (`pin` vs `pine`).
      if (currentVim.status.remapPending) runKeys(currentVim, [RemapTimeoutKey]);
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

// Native cursor movement during insert/replace mode: a real host moves the
// cursor itself, which also breaks Vim's undo block (`i_<Left>` etc.).
function emulateNativeInsertKey(editor: InMemoryVimEditor, vim: Vim, key: string): void {
  if (vim.mode.kind !== "insert" && vim.mode.kind !== "replace") return;
  const selection = editor.getSelections()[0];
  if (selection === undefined || selection.type !== "charwise") return;
  const head = selection.cursor ?? selection.head;
  const lineLength = editor.lineLength(head.row);
  const target = (() => {
    switch (key) {
      case "left":
        return { row: head.row, column: Math.max(0, head.column - 1) };
      case "right":
        return { row: head.row, column: Math.min(head.column + 1, lineLength) };
      case "up":
      case "down": {
        const row = Math.max(0, Math.min(head.row + (key === "down" ? 1 : -1), editor.lineCount() - 1));
        return { row, column: Math.min(head.column, editor.lineLength(row)) };
      }
      case "home":
        return { row: head.row, column: 0 };
      case "end":
        return { row: head.row, column: lineLength };
      default:
        return undefined;
    }
  })();
  if (target === undefined) return;
  editor.finishUndoTransaction();
  editor.setSelections([{ type: "charwise", anchor: target, head: target }]);
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
