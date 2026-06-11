// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/repeat.rs and repeat/macro state in `state::VimGlobals`
// - translated concepts: record and replay the last repeatable action, including a first
//   `RecordedSelection`-style visual action shape, plus first named macro replay
// - intentional differences: key-based actions are still stored as small key sequences;
//   visual actions are modeled explicitly only for the actions currently implemented.

import { RegisterName } from "../registers.js";
import { IndentDirection } from "./indent.js";

export type RecordedSelection =
  | { type: "none" }
  | { type: "charwise"; rowDelta: number; columnDelta: number; endColumn: number }
  | { type: "visualLine"; rows: number }
  | { type: "visualBlock"; rows: number; side: "start" | "end" };

export type VisualRepeatAction =
  | { type: "indent"; direction: IndentDirection }
  | { type: "delete" }
  | { type: "change"; insertedText: string };

export type RepeatAction =
  | { type: "keys"; keys: readonly string[] }
  | { type: "visual"; selection: RecordedSelection; action: VisualRepeatAction };

export class RepeatState {
  private current: string[] | undefined;
  private last: RepeatAction | undefined;
  private replaying = false;
  private abortRequested = false;

  isReplaying(): boolean {
    return this.replaying;
  }

  /** Stop feeding the remaining recorded keys of an in-flight `.` replay.
      Vim: when a replayed operator aborts (`cgn` with no match), the rest of
      the recording — typically insert-mode text — must not run as keys. */
  abortCurrentReplay(): void {
    if (this.replaying) this.abortRequested = true;
  }

  maybeStart(key: string, { mode, pendingChord }: { mode: string; pendingChord: string }): void {
    if (this.current !== undefined || mode !== "normal") return;
    if (isRepeatableStartKey(key)) this.current = [...pendingChord];
  }

  recordKey(key: string): void {
    this.current?.push(key);
  }

  recordCompleted(keys: readonly string[]): void {
    this.current = undefined;
    this.last = { type: "keys", keys: [...keys] };
  }

  cancelCurrent(): void {
    this.current = undefined;
  }

  recordVisualAction(selection: RecordedSelection, action: VisualRepeatAction): void {
    this.current = undefined;
    this.last = { type: "visual", selection, action };
  }

  maybeFinish({ mode, isPending }: { mode: string; isPending: boolean }): void {
    if (this.current === undefined) return;
    if (mode === "normal" && !isPending) {
      this.last = { type: "keys", keys: this.current };
      this.current = undefined;
    }
  }

  replay(
    count: number | undefined,
    { runKey, runVisualAction, registerName }: { runKey: (key: string) => void; runVisualAction: (selection: RecordedSelection, action: VisualRepeatAction) => void; registerName?: RegisterName }
  ): void {
    if (this.last === undefined) return;
    this.replaying = true;
    try {
      switch (this.last.type) {
        case "keys": {
          const countedKeys = count === undefined ? this.last.keys : keysWithCountOverride(this.last.keys, count);
          const registerKeys = registerName === undefined ? countedKeys : keysWithRegisterOverride(countedKeys, registerName);
          const keys = advanceNumberedPasteRepeat(registerKeys);
          for (const key of keys) {
            if (this.abortRequested) break;
            runKey(key);
          }
          if (count !== undefined || keys !== this.last.keys) this.last = { type: "keys", keys: [...keys] };
          break;
        }
        case "visual":
          runVisualAction(this.last.selection, this.last.action);
          break;
      }
    } finally {
      this.replaying = false;
      this.abortRequested = false;
    }
  }
}

export class MacroState {
  private recordingRegister: string | undefined;
  private current: string[] = [];
  private readonly recorded = new Map<string, readonly string[]>();
  private lastRecordedRegister: string | undefined;
  private lastReplayRegister: string | undefined;
  private replaying = false;

  isRecording(): boolean {
    return this.recordingRegister !== undefined;
  }

  isReplaying(): boolean {
    return this.replaying;
  }

  startRecording(key: string): void {
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
    this.lastRecordedRegister = register;
    this.current = [];
    return true;
  }

  replayRegisterKey(key: string, count: number, runKey: (key: string) => void): void {
    const register = key === "@" ? this.lastReplayRegister : key;
    if (register === undefined) return;
    this.replay(register, count, runKey);
  }

  replayLast(count: number, runKey: (key: string) => void): void {
    const register = this.lastRecordedRegister;
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
    || key === "ctrl-a"
    || key === "ctrl-x"
    || key === "o"
    || key === "O"
    || key === "i"
    || key === "a"
    || key === "I"
    || key === "A"
    || key === "v"
    || key === "V"
    || key === "ctrl-v";
}

function keysWithRegisterOverride(keys: readonly string[], registerName: RegisterName): readonly string[] {
  const { index: afterCount } = consumeCount(keys, 0);
  if (keys[afterCount] === '"') return keys;
  return [...keys.slice(0, afterCount), '"', registerName, ...keys.slice(afterCount)];
}

function advanceNumberedPasteRepeat(keys: readonly string[]): readonly string[] {
  const { index: afterCount } = consumeCount(keys, 0);
  if (keys[afterCount] !== '"') return keys;
  const registerName = keys[afterCount + 1];
  const command = keys[afterCount + 2];
  if (!/^\d$/.test(registerName) || (command !== "p" && command !== "P")) return keys;
  const nextRegister = String(Math.min(9, Number(registerName) + 1));
  return [...keys.slice(0, afterCount + 1), nextRegister, ...keys.slice(afterCount + 2)];
}

function keysWithCountOverride(keys: readonly string[], count: number): readonly string[] {
  const { index: afterPrefix } = consumeCount(keys, 0);
  const firstCommandKey = keys[afterPrefix];
  if (firstCommandKey === undefined) return keys;

  if (firstCommandKey === "ctrl-a" || firstCommandKey === "ctrl-x") {
    return withCountPrefix([firstCommandKey, ...keys.slice(afterPrefix + 1)], count);
  }

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
