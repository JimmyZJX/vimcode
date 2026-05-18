// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/repeat.rs and repeat/macro state in `state::VimGlobals`
// - translated concepts: record and replay the last repeatable normal-mode key sequence,
//   plus first named macro recording/replay
// - intentional differences: this records small key sequences rather than Zed's full action
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
    const keys = count === 1 ? this.last : keysWithCountOverride(this.last, count);
    this.replaying = true;
    try {
      for (const key of keys) runKey(key);
    } finally {
      this.replaying = false;
    }
  }
}

export class MacroState {
  private pendingRecordRegister = false;
  private pendingReplayRegister = false;
  private pendingReplayCount = 1;
  private recordingRegister: string | undefined;
  private current: string[] = [];
  private readonly recorded = new Map<string, readonly string[]>();
  private lastReplayRegister: string | undefined;
  private replaying = false;

  isRecording(): boolean {
    return this.recordingRegister !== undefined;
  }

  isReplaying(): boolean {
    return this.replaying;
  }

  startRecordingPrefix(): void {
    this.pendingRecordRegister = true;
  }

  startReplayPrefix(count: number): void {
    this.pendingReplayRegister = true;
    this.pendingReplayCount = count;
  }

  wantsRecordRegister(): boolean {
    return this.pendingRecordRegister;
  }

  wantsReplayRegister(): boolean {
    return this.pendingReplayRegister;
  }

  handleRecordRegister(key: string): void {
    this.pendingRecordRegister = false;
    this.recordingRegister = key;
    this.current = [];
  }

  recordKey(key: string): void {
    if (this.recordingRegister !== undefined && !this.replaying) this.current.push(key);
  }

  stopRecording(): boolean {
    const register = this.recordingRegister;
    if (register === undefined) return false;
    this.recordingRegister = undefined;
    this.recorded.set(register, this.current);
    this.lastReplayRegister = register;
    this.current = [];
    return true;
  }

  replayRegisterKey(key: string, runKey: (key: string) => void): void {
    this.pendingReplayRegister = false;
    const count = this.pendingReplayCount;
    this.pendingReplayCount = 1;
    const register = key === "@" ? this.lastReplayRegister : key;
    if (register === undefined) return;
    this.replay(register, count, runKey);
  }

  replayLast(count: number, runKey: (key: string) => void): void {
    const register = this.lastReplayRegister;
    if (register === undefined) return;
    this.replay(register, count, runKey);
  }

  private replay(register: string, count: number, runKey: (key: string) => void): void {
    const keys = this.recorded.get(register);
    if (keys === undefined) return;
    this.lastReplayRegister = register;
    this.replaying = true;
    try {
      for (let index = 0; index < count; index++) {
        for (const key of keys) runKey(key);
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
    || key === "~"
    || key === "g"
    || key === "o"
    || key === "O"
    || key === "i"
    || key === "a"
    || key === "I"
    || key === "A";
}

function keysWithCountOverride(keys: readonly string[], count: number): readonly string[] {
  const { index: afterPrefix } = consumeCount(keys, 0);
  const firstCommandKey = keys[afterPrefix];
  if (firstCommandKey === undefined) return keys;

  if (isOperatorKey(firstCommandKey)) {
    const { index: afterMotionCount } = consumeCount(keys, afterPrefix + 1);
    const motionKey = keys[afterMotionCount];
    if (motionKey === undefined) return withCountPrefix(keys.slice(afterPrefix), count);
    return withCountPrefix([firstCommandKey, motionKey, ...keys.slice(afterMotionCount + 1)], count);
  }

  return withCountPrefix(keys.slice(afterPrefix), count);
}

function consumeCount(keys: readonly string[], start: number): { index: number } {
  let index = start;
  while (index < keys.length && /^\d$/.test(keys[index])) index++;
  return { index };
}

function withCountPrefix(keys: readonly string[], count: number): readonly string[] {
  return count === 1 ? keys : [...String(count), ...keys];
}

function isOperatorKey(key: string): boolean {
  return key === "d" || key === "c" || key === "y";
}
