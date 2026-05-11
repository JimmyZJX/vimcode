// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/vim.rs, crates/vim/src/normal.rs, crates/vim/src/motion.rs
// - translated concepts: main Vim state holder and high-level mode dispatch
// - intentional differences: GPUI action registration is replaced by direct key dispatch
//   from the VSCode patch / tests.

import { VimEditorCapabilities } from "./editor.js";
import { enterNormalMode, insertText } from "./insert.js";
import { NormalMode } from "./normal.js";
import { RegisterName, Registers } from "./registers.js";
import { KeyResult, VimMode } from "./state.js";

// Zed: `vim::Vim`. This class is the local main state holder; GPUI
// entity/window fields are intentionally replaced by the injected
// `VimEditorCapabilities`.
export class Vim {
  private modeState: VimMode = { dialect: "vim", kind: "normal" };
  private readonly registers = new Registers();
  private readonly normalMode: NormalMode;

  constructor(private readonly editor: VimEditorCapabilities) {
    this.editor.setCursorStyle("block");
    this.normalMode = new NormalMode(editor, this.registers);
  }

  get mode(): VimMode {
    return this.modeState;
  }

  get modeName(): string {
    const suffix = this.normalMode.isPending() ? "+" : "";
    return `${this.modeState.dialect}:${this.modeState.kind}${suffix}`;
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
      if (this.modeState.kind !== "normal") {
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

    if (this.modeState.kind !== "normal") {
      return "not-handled";
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
