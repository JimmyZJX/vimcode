// Zed reference:
// - sources: crates/vim/src/normal.rs (the leaf normal-mode commands that take
//   no motion/object operand)
// - translated concepts: single-key normal-mode actions (`x`/`X`/`~`/`J`) as
//   small data values, applied through one [applySimpleAction] dispatch so they
//   are uniform across live execution and dot/macro replay.

import type { VimEditorCapabilities } from "../editor.js";
import type { RegisterName, Registers } from "../registers.js";
import { selectionHead } from "../state.js";
import { replaceCharacters } from "../replace.js";
import { deleteCharacters, deleteCharactersBefore } from "./delete.js";
import { toggleCaseCharacters } from "./convert.js";
import { joinLines } from "./join.js";

// A leaf normal-mode command that consumes no motion/object operand. Dot-repeat
// and macros re-run these by replaying the recorded keys, so the count/register
// are re-derived from the replayed chord rather than stored here.
export type SimpleAction =
  | { type: "deleteCharsRight" } // x
  | { type: "deleteCharsLeft" } // X
  | { type: "toggleCaseChars" } // ~
  | { type: "joinLines"; withSpace: boolean } // J (true) / gJ (false)
  | { type: "replaceChar"; char: string }; // r{char}

export function simpleActionForKey(key: string): SimpleAction | undefined {
  switch (key) {
    case "x":
    case "delete":
      return { type: "deleteCharsRight" };
    case "X":
      return { type: "deleteCharsLeft" };
    case "~":
      return { type: "toggleCaseChars" };
    case "J":
      return { type: "joinLines", withSpace: true };
    default:
      return undefined;
  }
}

// The single dispatch for leaf actions, used by both the live grammar and
// dot/macro replay.
export function applySimpleAction(
  editor: VimEditorCapabilities,
  registers: Registers,
  register: RegisterName | undefined,
  count: number,
  action: SimpleAction
): void {
  switch (action.type) {
    case "deleteCharsRight":
      deleteCharacters(editor, registers, register, count);
      return;
    case "deleteCharsLeft":
      deleteCharactersBefore(editor, registers, register, count);
      return;
    case "toggleCaseChars":
      toggleCaseCharacters(editor, count);
      return;
    case "joinLines": {
      // Vim: `J` with no count joins one line; `{count}J` joins count-1 of the
      // following lines. Join operates from the primary cursor's row.
      const head = selectionHead(editor.getSelections()[0]);
      joinLines(editor, head.row, count <= 1 ? 1 : count - 1, { insertWhitespace: action.withSpace });
      return;
    }
    case "replaceChar":
      replaceCharacters(editor, action.char, count);
      return;
  }
}
