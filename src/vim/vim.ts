// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: `vim::Vim`
// - translated concepts: main Vim state holder and high-level mode dispatch
// - intentional differences: GPUI action registration is replaced by direct key dispatch
//   from the VSCode patch / tests.

import { VimEditorCapabilities } from "./editor.js";
import { enterNormalMode, insertText } from "./insert.js";
import { NormalMode } from "./normal.js";
import { RegisterName, Registers } from "./registers.js";
import { KeyResult, Operator, VimMode } from "./state.js";
import { VisualMode } from "./visual.js";

export type VimStatus = {
  mode: VimMode["kind"];
  pending: boolean;
  operator: Operator | undefined;
  chord: string;
  text: string;
};

// Zed: `vim::Vim`. This class is the local main state holder; GPUI
// entity/window fields are intentionally replaced by the injected
// `VimEditorCapabilities`.
export class Vim {
  private modeState: VimMode = { dialect: "vim", kind: "normal" };
  private readonly registers = new Registers();
  private readonly normalMode: NormalMode;
  private readonly visualMode: VisualMode;

  constructor(private readonly editor: VimEditorCapabilities) {
    this.editor.setCursorStyle("block");
    this.normalMode = new NormalMode(editor, this.registers);
    this.visualMode = new VisualMode(editor, this.registers);
  }

  get mode(): VimMode {
    return this.modeState;
  }

  get modeName(): string {
    const suffix = this.normalMode.isPending() ? "+" : "";
    return `${this.modeState.dialect}:${this.modeState.kind}${suffix}`;
  }

  get status(): VimStatus {
    const chord = this.modeState.kind === "normal" ? this.normalMode.pendingChord() : "";
    const mode = this.modeState.kind;
    return {
      mode,
      pending: chord.length > 0,
      operator: this.modeState.kind === "normal" ? this.normalMode.pendingOperatorName() : undefined,
      chord,
      text: chord.length > 0 ? `${mode.toUpperCase()} ${chord}` : mode.toUpperCase(),
    };
  }

  readRegister(name: RegisterName | undefined): string {
    return this.registers.read(name);
  }

  // Zed: key dispatch normally arrives through GPUI actions registered by
  // `vim::Vim::action` and key contexts from `vim::Vim::extend_key_context`.
  // The VSCode patch calls this direct key entry point instead.
  onKey(key: string): KeyResult {
    if (this.isEscape(key)) {
      this.normalMode.clearPending();
      if (
        this.modeState.kind === "visual"
        || this.modeState.kind === "visualLine"
        || this.modeState.kind === "visualBlock"
      ) {
        this.visualMode.exit();
        this.modeState = { dialect: this.modeState.dialect, kind: "normal" };
      } else if (this.modeState.kind !== "normal") {
        enterNormalMode(this.editor, { moveLeft: this.modeState.kind === "insert" });
        this.modeState = { dialect: this.modeState.dialect, kind: "normal" };
      }
      return "handled";
    }

    if (this.modeState.kind === "insert") {
      if (key.length === 1 || key === "\n") {
        insertText(this.editor, key);
        return "handled";
      }
      return "not-handled";
    }

    if (
      this.modeState.kind === "visual"
      || this.modeState.kind === "visualLine"
      || this.modeState.kind === "visualBlock"
    ) {
      const result = this.visualMode.onKey(key);
      if (result.enterInsert) {
        this.modeState = { dialect: this.modeState.dialect, kind: "insert" };
      } else if (result.nextMode !== undefined) {
        this.modeState = { dialect: this.modeState.dialect, kind: result.nextMode };
      } else if (result.exitVisual) {
        this.modeState = { dialect: this.modeState.dialect, kind: "normal" };
      }
      return result.keyResult;
    }

    if (this.modeState.kind !== "normal") {
      return "not-handled";
    }

    if (key === "v") {
      this.visualMode.enter("charwise");
      this.modeState = { dialect: this.modeState.dialect, kind: "visual" };
      return "handled";
    }

    if (key === "V") {
      this.visualMode.enter("linewise");
      this.modeState = { dialect: this.modeState.dialect, kind: "visualLine" };
      return "handled";
    }

    if (key === "ctrl-v") {
      this.visualMode.enter("blockwise");
      this.modeState = { dialect: this.modeState.dialect, kind: "visualBlock" };
      return "handled";
    }

    const normalResult = this.normalMode.onKey(key);
    if (normalResult.enterInsert) {
      this.modeState = { dialect: this.modeState.dialect, kind: "insert" };
    }
    return normalResult.keyResult;
  }

  private isEscape(key: string): boolean {
    return key === "<escape>" || key === "escape" || key === "ctrl-[";
  }
}

// Local test helper, analogous in spirit to Zed's test harness helpers in
// `test::vim_test_context::VimTestContext` rather than a production API.
export function runKeys(vim: Vim, keys: readonly string[]): void {
  for (const key of keys) {
    vim.onKey(key);
  }
}
