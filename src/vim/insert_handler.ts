// Zed reference:
// - source: crates/vim/src/insert.rs (insert-mode input) — adapted for VSCode.
// - translated concept: in insert/replace mode Vim does not edit the buffer for
//   ordinary typing; VSCode's native handler does. This handler claims the
//   passthrough characters (plain text + `backspace`) so the owner can record
//   them (macros + dot-repeat) and, on the replay path, reproduce the edit
//   through the VSCode default handler ([editor.replayInsertKey]). Live typing is
//   handled natively (the controller does not preventDefault).
//
// The handler is a pure marker: it returns an [insertTyped] effect with no buffer
// edit. The owner ([Vim.handleThroughExecutor]) records the key as a `typed`
// [RecordedKey] and reproduces / accumulates it; the effect only tells it that
// this key is passthrough insert input. Special insert keys (`ctrl-o`,
// `ctrl-w/u/y/e`, the `ctrl-k/v/r` char waiters) and escape are declined so the
// legacy dispatcher still handles them.

import { lookupDigraph } from "./digraph.js";
import { insertTextForKey, keepUndoTransactionOpen } from "./editor.js";
import {
  deleteToBeginningOfLine,
  deleteToPreviousWord,
  insertCharacterFromAdjacentLine,
  insertText,
} from "./insert.js";
import type { HandleResult, Handler, HandlerState } from "./key_handler.js";
import { cloneHandlerState, effect, invalid, run, unhandled } from "./key_handler.js";
import { parseRegisterName } from "./registers.js";

// The non-text half of the insert-mode passthrough whitelist: editing/navigation
// keys VSCode handles natively that Vim records (as `typed`) so macros and
// dot-repeat replay them through the default handler. Deliberately a static
// whitelist — command-like chords (`ctrl+shift+p`, `ctrl+p`, …) must never land
// in a recording, so anything not listed here stays native *and unrecorded*.
// Clipboard chords (`ctrl+c/v/x`) are intentionally absent: they will be owned
// as Vim commands (their default handlers are async, which does not fit the
// synchronous replay loop).
const passthroughNavigationKeys: ReadonlySet<string> = new Set([
  "up",
  "down",
  "left",
  "right",
  "ctrl-left",
  "ctrl-right",
  "home",
  "end",
  "pageup",
  "pagedown",
]);

const passthroughDeleteKeys: ReadonlySet<string> = new Set([
  "backspace",
  "delete",
  "ctrl-backspace",
  "ctrl-delete",
]);

// Whether [key] is insert-mode passthrough input: plain typed text or a
// whitelisted editing/navigation key. Shared by the grammar below and the
// synchronous ownership decision ([Vim.isInsertPassthroughKey]).
export function isPassthroughInsertKey(key: string): boolean {
  return insertTextForKey(key) !== undefined || passthroughNavigationKeys.has(key) || passthroughDeleteKeys.has(key);
}

// The replace-mode passthrough set is navigation-only: typing overwrites and
// backspace restores, so all editing keys must stay Vim-owned there.
export function isPassthroughReplaceKey(key: string): boolean {
  return passthroughNavigationKeys.has(key);
}

export function insertModeHandler(key: string, state: HandlerState): HandleResult<void> {
  // Escape leaves insert mode via the owner's central escape handling.
  if (isEscape(key)) return unhandled();
  // Passthrough input is claimed as a `typed` marker (the owner records it and
  // reproduces/skips the edit; see [EffectMeta.insertTyped]).
  if (isPassthroughInsertKey(key)) {
    return effect(state.mode, () => {}, { insertTyped: true });
  }
  // Vim's own insert-mode editing commands. These are owned (the host never
  // sees them) and recorded as shortcut keys; the edits keep the insert undo
  // transaction open like typed input.
  const editor = state.editor;
  switch (key) {
    case "ctrl-w":
      if (editor === undefined) return invalid();
      return effect(state.mode, () => deleteToPreviousWord(editor, keepUndoTransactionOpen()));
    case "ctrl-u":
      if (editor === undefined) return invalid();
      return effect(state.mode, () => deleteToBeginningOfLine(editor, keepUndoTransactionOpen()));
    case "ctrl-y":
      if (editor === undefined) return invalid();
      return effect(state.mode, () => insertCharacterFromAdjacentLine(editor, "above", keepUndoTransactionOpen()));
    case "ctrl-e":
      if (editor === undefined) return invalid();
      return effect(state.mode, () => insertCharacterFromAdjacentLine(editor, "below", keepUndoTransactionOpen()));
    case "ctrl-o":
      // Vim `i_CTRL-O`: leave insert for exactly one normal-mode command. The
      // owner callback finishes the session and flags the excursion; the mode
      // transition happens inside it, so the effect's target matches.
      return effect("normal", () => state.enterTemporaryNormal?.());
    // The char-input waiters. Their keys are recorded as shortcuts (owner-side),
    // so a replay feeds them back through the dispatcher and re-runs the waiter.
    case "ctrl-k":
      // Vim `i_CTRL-K`: a two-character digraph.
      return waitFor(state, digraphFirstWaiter(applyInsertResolvedText));
    case "ctrl-r":
      // Vim `i_CTRL-R`: insert a register's contents.
      return waitFor(state, insertRegisterWaiter);
    case "ctrl-v":
      // Vim `i_CTRL-V`: insert the next key literally, or a decimal (`123`) /
      // hex (`x..`/`u....`/`U........`) character code.
      return waitFor(state, literalPlainWaiter);
    default:
      // Anything else (unknown chords) stays with the host / legacy dispatcher.
      return unhandled();
  }
}

function waitFor(state: HandlerState, next: Handler<void>): HandleResult<void> {
  return { type: "handler", handlerEnvs: [{ handler: next, state: cloneHandlerState(state) }] };
}

// How a mode applies resolved text (a digraph, a literal code): insert mode
// inserts it, replace mode overwrites through the owner's replace machinery.
type ApplyResolvedText = (state: HandlerState, text: string) => void;

const applyInsertResolvedText: ApplyResolvedText = (state, text) => {
  const editor = state.editor;
  if (editor === undefined) return;
  insertText(editor, text, keepUndoTransactionOpen());
  state.appendInsertSessionText?.(text);
};

const applyReplaceResolvedText: ApplyResolvedText = (state, text) => {
  state.applyReplaceText?.(text);
};

// First digraph char: remember it and wait for the second. Escape cancels.
function digraphFirstWaiter(applyText: ApplyResolvedText): Handler<void> {
  return (key, state) => {
    if (isEscape(key)) return invalid();
    return waitFor(state, digraphSecondWaiter(applyText, keyForInput(key)));
  };
}

// Second digraph char: look the pair up and apply the result, keeping the
// insert undo transaction open like typed input. The resolved text also joins
// the count-repeat session text (`3i…ctrl-k a :…<esc>`).
function digraphSecondWaiter(applyText: ApplyResolvedText, first: string): Handler<void> {
  return (key, state) => {
    if (isEscape(key)) return invalid();
    return effect(state.mode, () => {
      applyText(state, lookupDigraph(first, keyForInput(key)));
    });
  };
}

// The register name after `ctrl-r`: insert that register's contents. Escape
// cancels; an unknown register name is consumed as a no-op (like the legacy
// waiter). The inserted text intentionally does not join the count-repeat
// session text, matching the legacy behavior.
function insertRegisterWaiter(key: string, state: HandlerState): HandleResult<void> {
  if (isEscape(key)) return invalid();
  const editor = state.editor;
  const registers = state.registers;
  if (editor === undefined || registers === undefined) return invalid();
  return effect(state.mode, () => {
    const registerName = parseRegisterName(key);
    if (registerName === undefined) return;
    insertText(editor, registers.read(registerName), keepUndoTransactionOpen());
  });
}

// `ctrl-v` first key: a code-base selector (`x`/`u`/`U` hex, a digit decimal) or
// the key to insert literally. Note escape is *not* a cancel here — `ctrl-v
// <esc>` inserts a literal escape character, like Vim.
function literalPlainWaiter(key: string, state: HandlerState): HandleResult<void> {
  if (key === "x") return waitFor(state, literalHexWaiter("", 2));
  if (key === "u" || key === "U") return waitFor(state, literalHexWaiter("", key === "u" ? 4 : 8));
  if (/^[0-9]$/.test(key)) return waitFor(state, literalDecimalWaiter(key));
  return insertLiteralEffect(state, literalTextForKey(key));
}

// Decimal character code: up to three digits; any other key completes the code
// and is then re-dispatched as an ordinary key (so `ctrl-v 1 2 <esc>` inserts
// the character and leaves insert mode).
function literalDecimalWaiter(digits: string): Handler<void> {
  return (key, state) => {
    if (/^[0-9]$/.test(key)) {
      const next = digits + key;
      if (next.length >= 3) return insertLiteralEffect(state, literalCodepointText(Number(next)));
      return waitFor(state, literalDecimalWaiter(next));
    }
    return completeLiteralAndRedispatch(state, literalCodepointText(Number(digits)), key);
  };
}

// Hex character code (`x`: 2 digits, `u`: 4, `U`: 8): completes when full, or
// when a non-hex key arrives (which is then re-dispatched; an empty code
// inserts nothing).
function literalHexWaiter(digits: string, maxDigits: number): Handler<void> {
  return (key, state) => {
    if (/^[0-9a-fA-F]$/.test(key)) {
      const next = digits + key;
      if (next.length >= maxDigits) return insertLiteralEffect(state, literalCodepointText(Number.parseInt(next, 16)));
      return waitFor(state, literalHexWaiter(next, maxDigits));
    }
    const text = digits.length > 0 ? literalCodepointText(Number.parseInt(digits, 16)) : "";
    return completeLiteralAndRedispatch(state, text, key);
  };
}

function insertLiteralEffect(state: HandlerState, text: string): HandleResult<void> {
  const editor = state.editor;
  if (editor === undefined) return invalid();
  return effect(state.mode, () => {
    insertText(editor, text, keepUndoTransactionOpen());
    state.appendInsertSessionText?.(text);
  });
}

// Complete an in-flight character code and re-dispatch the terminating key
// through the owner pipeline, where it acts as an ordinary key (typed input,
// escape, …). The terminator is not remappable, mirroring the literal context.
function completeLiteralAndRedispatch(state: HandlerState, text: string, key: string): HandleResult<void> {
  const editor = state.editor;
  if (editor === undefined) return invalid();
  return run({
    type: "sequence",
    mode: state.mode,
    actions: [
      {
        type: "effect",
        mode: state.mode,
        run: () => {
          if (text.length === 0) return;
          insertText(editor, text, keepUndoTransactionOpen());
          state.appendInsertSessionText?.(text);
        },
      },
      { type: "keys", mode: state.mode, keys: [{ key, allowRemap: false }] },
    ],
  });
}

function literalCodepointText(codepoint: number): string {
  return String.fromCodePoint(Math.max(0, Number.isNaN(codepoint) ? 0 : codepoint));
}

// Vim `i_CTRL-V`: the literal text a key stands for (control codes for ctrl
// chords, `\t`/`\n`/escape for the named keys, the character itself otherwise).
function literalTextForKey(key: string): string {
  if (key === "tab") return "\t";
  if (key === "enter") return "\n";
  if (key === "escape" || key === "<escape" || key === "<escape>") return "\u001b";
  const control = /^ctrl-(.)$/.exec(key);
  if (control !== null) {
    if (control[1] === "j") return "\u0000";
    if (control[1] === "[") return "\u001b";
    return String.fromCodePoint(control[1].toLowerCase().charCodeAt(0) - "a".charCodeAt(0) + 1);
  }
  return keyForInput(key);
}

function keyForInput(key: string): string {
  return key === "space" ? " " : key;
}

// Replace mode (`R`). Unlike insert, plain typing cannot pass through — native
// typing inserts while Vim overwrites and remembers what it replaced for
// backspace to restore — so text and backspace are Vim-owned effects driving the
// owner's replace machinery ([applyReplaceText]/[undoReplace]). Only the
// navigation keys pass through (recorded as `typed`, like insert mode).
export function replaceModeHandler(key: string, state: HandlerState): HandleResult<void> {
  // Escape leaves replace mode via the owner's central escape handling.
  if (isEscape(key)) return unhandled();
  if (isPassthroughReplaceKey(key)) {
    return effect(state.mode, () => {}, { insertTyped: true });
  }
  if (key === "backspace") {
    // Restore the most recently overwritten character (or just step left).
    return effect(state.mode, () => state.undoReplace?.());
  }
  if (key === "ctrl-k") {
    // Vim `i_CTRL-K` in replace mode: the digraph overwrites.
    return waitFor(state, digraphFirstWaiter(applyReplaceResolvedText));
  }
  const text = insertTextForKey(key);
  if (text !== undefined) {
    return effect(state.mode, () => state.applyReplaceText?.(text));
  }
  // Anything else (other ctrl chords) stays with the host / legacy dispatcher.
  return unhandled();
}

// `R` from normal mode: enter replace mode. The session params (count for `3R`)
// ride out on the effect's [enterInsert] meta — replace shares the insert
// session (count-repeat text, `<esc>` finish) — and the owner's mode transition
// starts it. Dot-repeat/macros replay the recorded keys.
export function replaceEntryHandler(key: string, state: HandlerState): HandleResult<void> {
  if (key !== "R") return unhandled();
  return effect("replace", () => {}, {
    enterInsert: { count: state.repeat, separator: "" },
    dotRepeatable: true,
  });
}

function isEscape(key: string): boolean {
  return key === "escape" || key === "<escape>" || key === "ctrl-[";
}
