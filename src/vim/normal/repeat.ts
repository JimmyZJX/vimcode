// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/repeat.rs and dot-recording state in `state::VimGlobals`
// - translated concepts: record and replay the last repeatable normal-mode key sequence
// - intentional differences: this records a small key sequence rather than Zed's full action
//   recording system. Register-for-dot and complex repeat grouping remain future work.

export class RepeatState {
  private current: string[] | undefined;
  private last: string[] | undefined;
  private replaying = false;

  isReplaying(): boolean {
    return this.replaying;
  }

  maybeStart(key: string, { mode, pendingChord }: { mode: string; pendingChord: string }): void {
    if (this.current !== undefined || mode !== "normal") return;
    if (isRepeatableStartKey(key)) this.current = [...pendingChord];
  }

  recordKey(key: string): void {
    this.current?.push(key);
  }

  maybeFinish({ mode, isPending }: { mode: string; isPending: boolean }): void {
    if (this.current === undefined) return;
    if (mode === "normal" && !isPending) {
      this.last = this.current;
      this.current = undefined;
    }
  }

  replay(count: number, runKey: (key: string) => void): void {
    if (this.last === undefined) return;
    this.replaying = true;
    try {
      for (let index = 0; index < count; index++) {
        for (const key of this.last) runKey(key);
      }
    } finally {
      this.replaying = false;
    }
  }
}

function isRepeatableStartKey(key: string): boolean {
  return key === "x"
    || key === "p"
    || key === "P"
    || key === "d"
    || key === "c"
    || key === "r"
    || key === "R"
    || key === "o"
    || key === "O"
    || key === "i"
    || key === "a"
    || key === "I"
    || key === "A";
}
