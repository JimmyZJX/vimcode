// Zed reference:
// - source: the shared (normal + visual) finite-keymap bindings in
//   assets/keymaps/vim.json (pages/scroll/window/fold/...).
// - translated concepts: the finite-keymap chords that were resolved by the
//   legacy [VimKeymapResolver] become pure framework handlers here, shared by the
//   normal and visual grammars. They are mostly thin effects over editor/host
//   commands; the motion-like ones (pages/scroll) extend the selection in visual
//   mode, like the legacy `page`/`scrollLines` actions.

import type { HostCommand, HostDirection, HostFoldCommand, HostRevealTarget, VimEditorCapabilities } from "./editor.js";
import { cloneHandlerState, effect, handler, invalid, unhandled } from "./key_handler.js";
import type { HandleResult, Handler, HandlerState } from "./key_handler.js";
import { applyMotion, bracketMotion } from "./motion.js";
import { paste } from "./normal/paste.js";
import { applyMotionResults } from "./motion_handler.js";
import { charwiseSelection, isVisualModeKind, selectionHead } from "./state.js";
import type { Position, TextEdit, VimMode } from "./state.js";

// A native editor/LSP command run from a finite chord or `g`-chord (`gd`/`gh`/
// `K`/…). Like the legacy `native` action it asks for a post-command
// [syncFromEditorState] (via `syncAfter`) and is never a buffer change (so not
// dot-repeatable). Targets the current mode so the chord works identically in
// normal and visual (these commands do not leave visual mode).
export function nativeCommandEffect(state: HandlerState, command: string): HandleResult<void> {
  const editor = state.editor;
  if (editor === undefined) return invalid();
  return effect(state.mode, () => editor.executeNativeCommand(command), {
    dotRepeatable: false,
    syncAfter: true,
  });
}

// A multicursor chord (`gl`/`ga`/`ctrl-n`/…): run the VSCode command [count]
// times. The editor reconciles its own selections via [syncSelectionAfter], so
// no [syncAfter] is needed. Not a buffer change.
export function multiCursorEffect(state: HandlerState, command: string): HandleResult<void> {
  const editor = state.editor;
  if (editor === undefined) return invalid();
  const count = state.repeat;
  return effect(
    state.mode,
    () => {
      for (let index = 0; index < count; index++) {
        editor.executeNativeCommand(command, [], { syncSelectionAfter: true });
      }
    },
    { dotRepeatable: false }
  );
}

// Editor-tab navigation (`gt`/`gT`, `ctrl-pagedown`/`ctrl-pageup`). A count means
// an absolute tab index for `next` (`2gt` -> the 2nd tab) and a repeat for
// `previous`, matching VSCodeVim.
export function editorTabEffect(state: HandlerState, direction: "next" | "previous"): HandleResult<void> {
  const editor = state.editor;
  if (editor === undefined) return invalid();
  const count = state.hasCount === true ? state.repeat : undefined;
  return effect(state.mode, () => switchEditorTab(editor, direction, count), { dotRepeatable: false });
}

function switchEditorTab(
  editor: VimEditorCapabilities,
  direction: "next" | "previous",
  count: number | undefined
): void {
  if (count !== undefined && count <= 0) return;
  if (direction === "next" && count !== undefined) {
    // `{count}gt` jumps to the one-based tab index instead of repeating.
    editor.executeNativeCommand("workbench.action.openEditorAtIndex", [count - 1], { syncSelectionAfter: true });
    return;
  }
  const command =
    direction === "next" ? "workbench.action.nextEditorInGroup" : "workbench.action.previousEditorInGroup";
  for (let index = 0; index < (count ?? 1); index++) {
    editor.executeNativeCommand(command, [], { syncSelectionAfter: true });
  }
}

type PageSpec = { direction: HostDirection; halfPage: boolean };

function pageSpecForKey(key: string): PageSpec | undefined {
  switch (key) {
    case "ctrl-d":
      return { direction: "down", halfPage: true };
    case "ctrl-u":
      return { direction: "up", halfPage: true };
    case "ctrl-f":
    case "pagedown":
      return { direction: "down", halfPage: false };
    case "ctrl-b":
    case "pageup":
      return { direction: "up", halfPage: false };
    default:
      return undefined;
  }
}

// Pages (`ctrl-d`/`ctrl-u` half, `ctrl-f`/`ctrl-b`/`pagedown`/`pageup` full):
// move by a page. In visual mode the selection extends and the visual state
// re-adopts the host selection (`adoptSelectionFromHost`), so e.g. `V<ctrl-d>`
// grows the linewise selection. Not a buffer change.
export function pageHandler(key: string, state: HandlerState): HandleResult<void> {
  const spec = pageSpecForKey(key);
  if (spec === undefined) return unhandled();
  const editor = state.editor;
  if (editor === undefined) return invalid();
  const visual = state.visual;
  const count = state.repeat;
  const extend = isVisualModeKind(state.mode);
  return effect(
    state.mode,
    () => {
      const selections = editor.moveByPages(spec.direction, count, { halfPage: spec.halfPage, extend });
      if (selections !== undefined) editor.setSelections(selections);
      if (extend) visual?.adoptSelectionFromHost();
    },
    { dotRepeatable: false }
  );
}

// Scroll the view by lines (`ctrl-y` up / `ctrl-e` down) without moving the
// cursor in normal mode; in visual mode the selection extends with the scroll.
export function scrollHandler(key: string, state: HandlerState): HandleResult<void> {
  const direction: HostDirection | undefined = key === "ctrl-y" ? "up" : key === "ctrl-e" ? "down" : undefined;
  if (direction === undefined) return unhandled();
  const editor = state.editor;
  if (editor === undefined) return invalid();
  const visual = state.visual;
  const count = state.repeat;
  const extend = isVisualModeKind(state.mode);
  return effect(
    state.mode,
    () => {
      editor.scrollByLines(direction, count, { extend });
      if (extend) visual?.adoptSelectionFromHost();
    },
    { dotRepeatable: false }
  );
}

// A host command run from a finite chord: `ctrl-o`/`ctrl-i` (jumplist) and
// `u`/`ctrl-r` (undo/redo). Asks for a post-command [syncFromEditorState]; not a
// buffer change as far as the framework's dot-repeat is concerned (the host owns
// undo).
function hostCommandEffect(state: HandlerState, command: HostCommand): HandleResult<void> {
  const editor = state.editor;
  if (editor === undefined) return invalid();
  return effect(state.mode, () => editor.executeHostCommand(command), { dotRepeatable: false, syncAfter: true });
}

// Claim one pending-depth level for a multi-key finite chord (`z`/`ctrl-w`/`]`/
// `[`), like the count/register prefix and the `g`-chord continuation.
function deeper(state: HandlerState): HandlerState {
  return { ...cloneHandlerState(state), operatorDepth: state.operatorDepth + 1 };
}

// Single-key finite chords that run a native/host command. Shared
// (normal + visual): `K` (hover), `ctrl-n` (add cursor at next match),
// `ctrl-pagedown`/`ctrl-pageup` (tabs). Normal-only: `ctrl-o`/`ctrl-i`
// (jumplist back/forward), `u`/`ctrl-r` (undo/redo) — in visual `u`/`ctrl-r` are
// not these (visual `u` is convert), so they are declined there.
export function nativeKeyHandler(key: string, state: HandlerState): HandleResult<void> {
  switch (key) {
    case "K":
      return nativeCommandEffect(state, "editor.action.showHover");
    case "ctrl-n":
      return multiCursorEffect(state, "editor.action.addSelectionToNextFindMatch");
    case "ctrl-pagedown":
      return editorTabEffect(state, "next");
    case "ctrl-pageup":
      return editorTabEffect(state, "previous");
    default:
      break;
  }
  // The jumplist and undo/redo chords are normal-only.
  if (isVisualModeKind(state.mode)) return unhandled();
  switch (key) {
    case "ctrl-o":
      return hostCommandEffect(state, "navigateBack");
    case "ctrl-i":
      return hostCommandEffect(state, "navigateForward");
    case "u":
      return hostCommandEffect(state, "undo");
    case "ctrl-r":
      return hostCommandEffect(state, "redo");
    default:
      return unhandled();
  }
}

// `z`-chords: reveal the current line (`zz` center / `zt` top / `zb` bottom),
// shared with visual; folds (`za`/`zo`/`zc`/`zO`/`zC`/`zR`/`zM`), normal-only.
export function zChordHandler(key: string, state: HandlerState): HandleResult<void> {
  if (key !== "z") return unhandled();
  if (state.editor === undefined) return invalid();
  return handler([{ handler: zContinuation, state: deeper(state) }]);
}

function zContinuation(key: string, state: HandlerState): HandleResult<void> {
  const editor = state.editor;
  if (editor === undefined) return invalid();
  const revealTarget = revealTargetForKey(key);
  if (revealTarget !== undefined) {
    return effect(state.mode, () => editor.revealCurrentLine(revealTarget), { dotRepeatable: false });
  }
  // Folds are normal-only.
  if (isVisualModeKind(state.mode)) return invalid();
  const foldCommand = foldCommandForKey(key);
  if (foldCommand !== undefined) {
    return effect(state.mode, () => editor.executeFoldCommand(foldCommand), { dotRepeatable: false, syncAfter: true });
  }
  return invalid();
}

function revealTargetForKey(key: string): HostRevealTarget | undefined {
  switch (key) {
    case "z":
      return "center";
    case "t":
      return "top";
    case "b":
      return "bottom";
    default:
      return undefined;
  }
}

function foldCommandForKey(key: string): HostFoldCommand | undefined {
  switch (key) {
    case "a":
      return "toggle";
    case "o":
      return "open";
    case "c":
      return "close";
    case "O":
      return "openRecursive";
    case "C":
      return "closeRecursive";
    case "R":
      return "openAll";
    case "M":
      return "closeAll";
    default:
      return undefined;
  }
}

// `ctrl-w` window chords: navigate/split/resize editors. Shared navigation/split/
// resize commands work in both modes; close/maximize (`ctrl-w q`/`c`/`o`) are
// normal-only.
export function ctrlWHandler(key: string, state: HandlerState): HandleResult<void> {
  if (key !== "ctrl-w") return unhandled();
  if (state.editor === undefined) return invalid();
  return handler([{ handler: ctrlWContinuation, state: deeper(state) }]);
}

function ctrlWContinuation(key: string, state: HandlerState): HandleResult<void> {
  const command = windowCommandForKey(key, state.mode);
  if (command === undefined) return invalid();
  return nativeCommandEffect(state, command);
}

function windowCommandForKey(key: string, mode: VimMode): string | undefined {
  switch (key) {
    case "h":
    case "left":
    case "ctrl-h":
      return "workbench.action.navigateLeft";
    case "l":
    case "right":
    case "ctrl-l":
      return "workbench.action.navigateRight";
    case "j":
    case "down":
    case "ctrl-j":
      return "workbench.action.navigateDown";
    case "k":
    case "up":
    case "ctrl-k":
      return "workbench.action.navigateUp";
    case "w":
    case "ctrl-w":
      return "workbench.action.navigateEditorGroups";
    case "v":
    case "ctrl-v":
      return "workbench.action.splitEditor";
    case "s":
    case "ctrl-s":
      return "workbench.action.splitEditorOrthogonal";
    case "=":
      return "workbench.action.evenEditorWidths";
    case ">":
      return "workbench.action.increaseViewWidth";
    case "<":
      return "workbench.action.decreaseViewWidth";
    case "+":
      return "workbench.action.increaseViewHeight";
    case "-":
      return "workbench.action.decreaseViewHeight";
    default:
      break;
  }
  // Close/maximize the active editor are normal-only.
  if (isVisualModeKind(mode)) return undefined;
  switch (key) {
    case "q":
    case "ctrl-q":
    case "c":
    case "ctrl-c":
      return "workbench.action.closeActiveEditor";
    case "o":
    case "ctrl-o":
      return "workbench.action.maximizeEditor";
    default:
      return undefined;
  }
}

// `]`/`[` chords: unmatched-bracket motions (`]}`/`])`/`[{`/`[(`) which move in
// normal mode and extend the selection in visual; and `] space`/`[ space` which
// insert blank lines below/above (normal-only).
export function bracketChordHandler(key: string, state: HandlerState): HandleResult<void> {
  if (key !== "]" && key !== "[") return unhandled();
  if (state.editor === undefined) return invalid();
  return handler([{ handler: bracketContinuation(key), state: deeper(state) }]);
}

function bracketContinuation(bracket: "]" | "["): Handler<void> {
  return (key, state) => {
    const editor = state.editor;
    if (editor === undefined) return invalid();
    // `]p`/`]P`/`[p`/`[P`: paste with the indentation adjusted to the current
    // line (normal-only; `]p` pastes below, the other three above).
    if (key === "p" || key === "P") {
      if (isVisualModeKind(state.mode)) return invalid();
      const registers = state.registers;
      if (registers === undefined) return invalid();
      const register = state.register;
      const count = state.repeat;
      const before = bracket === "[" || key === "P";
      return effect(state.mode, () => paste(editor, registers, register, { before, count, adjustIndent: true }), {
        dotRepeatable: true,
      });
    }

    // `] space`/`[ space`: insert blank lines below/above (normal-only).
    if (key === "space") {
      if (isVisualModeKind(state.mode)) return invalid();
      const side = bracket === "]" ? "below" : "above";
      const count = state.repeat;
      return effect(state.mode, () => insertEmptyLines(editor, side, count), { dotRepeatable: false });
    }
    const motion = bracketMotion(bracket, key);
    if (motion === undefined) return invalid();
    const count = state.repeat;
    const visual = state.visual;
    return effect(
      state.mode,
      () => {
        if (isVisualModeKind(state.mode)) {
          visual?.applyMotion(motion, count);
        } else {
          applyMotionResults(
            editor,
            editor.getSelections().map(selection => ({ position: applyMotion(editor, selectionHead(selection), motion, count) }))
          );
        }
      },
      { dotRepeatable: false }
    );
  };
}

function insertEmptyLines(editor: VimEditorCapabilities, side: "above" | "below", count: number): void {
  const edits: TextEdit[] = [];
  const selectionsAfter = [];
  for (const selection of editor.getSelections()) {
    const head = selectionHead(selection);
    const editPosition: Position = side === "above" ? { row: head.row, column: 0 } : { row: head.row, column: editor.lineLength(head.row) };
    edits.push({ range: { start: editPosition, end: editPosition }, text: "\n".repeat(count) });
    const row = side === "above" ? head.row + count : head.row;
    selectionsAfter.push(charwiseSelection({ row, column: head.column }));
  }
  editor.applyEdits(edits, selectionsAfter);
}
