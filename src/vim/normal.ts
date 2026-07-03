// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/normal.rs, crates/vim/src/motion.rs
// - translated concepts: the normal-mode cursor-motion applier plus the small
//   legacy count/register accessors still shared with [Vim]. The normal-mode
//   *grammar* (operators, objects, commands) lives in the typed key-handler
//   framework (normal_mode_handler.ts); this class only applies plain motions
//   for owner-side callers (easyMotion jumps, mark jumps, search navigation,
//   `:normal` ranges) and answers a few state queries.

import { VimEditorCapabilities } from "./editor.js";
import { Motion, applyMotionWithGoal, hostViewLineSelectionsForMotion } from "./motion.js";
import { RegisterName, isSystemClipboardRegister } from "./registers.js";
import { charwiseSelection, selectionHead } from "./state.js";

type CountState = {
  get: () => string;
  append: (key: string) => void;
  take: (defaultValue: number | undefined) => number | undefined;
  clear: () => void;
};

type RegisterSelection = {
  get: () => RegisterName | undefined;
  take: () => RegisterName | undefined;
  clear: () => void;
};

export class NormalMode {
  constructor(
    private readonly editor: VimEditorCapabilities,
    private readonly registerSelection: RegisterSelection,
    private readonly countState: CountState
  ) {}

  isPending(): boolean {
    return this.countState.get().length > 0;
  }

  systemClipboardRegisterToReadForKey(key: string): { registerName: RegisterName | undefined } | undefined {
    if (key !== "p" && key !== "P") return undefined;
    const registerName = this.registerSelection.get();
    if (registerName === undefined || isSystemClipboardRegister(registerName)) {
      return { registerName };
    }
    return undefined;
  }

  clearPending(): void {
    this.countState.clear();
    this.registerSelection.clear();
  }

  // Zed: `motion::Vim::motion` — apply a plain cursor motion to every
  // selection. Operator application lives in the framework grammar; this is the
  // owner-side motion path (easyMotion jumps, mark jumps, search navigation).
  applyMotion(motion: Motion, count: number): void {
    const hostSelections = hostViewLineSelectionsForMotion(this.editor, motion, count, { displayLine: false, extend: false });
    if (hostSelections === undefined) this.moveSelections(motion, count);
    else this.editor.setSelections(hostSelections);
    this.registerSelection.clear();
  }

  private moveSelections(motion: Motion, count: number): void {
    this.editor.setSelections(
      this.editor.getSelections().map((selection) => {
        const { position, goal } = applyMotionWithGoal(
          this.editor,
          selectionHead(selection),
          motion,
          count,
          selection.goal
        );
        const nextSelection = charwiseSelection(position);
        return goal === undefined ? nextSelection : { ...nextSelection, goal };
      })
    );
  }
}
