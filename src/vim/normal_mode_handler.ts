// Zed reference:
// - sources: crates/vim/src/normal.rs and crates/vim/src/motion.rs
// - translated concepts: the normal-mode key grammar as a typed, pure handler
//   graph. Count/register are handled by the shared [prefixHandler]; motions
//   resolve through [motionHandler]/[resolveMotion]; operators apply through
//   [operator_target]. Editor, registers, and Vim-level effects travel in
//   [HandlerState], so handlers stay pure `(key, state) => result` with no
//   injected dependencies.

import { VimEditorCapabilities, keepUndoTransactionOpen } from "./editor.js";
import { enterInsertAtSelections, firstNonWhitespace, openLine } from "./insert.js";
import type { HandleResult, HandlerState, InsertEntryKind } from "./key_handler.js";
import {
  Handler,
  cloneHandlerState,
  combineHandleResults,
  dynamicModeEffect,
  effect,
  handler,
  invalid,
  mapHandler,
  unhandled,
} from "./key_handler.js";
import type { ChangeListDirection } from "./normal/change_list.js";
import type { ConvertTarget } from "./normal/convert.js";
import type { FindMotion, Motion, MotionResult } from "./motion.js";
import { applyMotion, bracketMotion, lineRange, motionForKey } from "./motion.js";
import { applyMotionResults, motionHandler } from "./motion_handler.js";
import { bracketChordHandler, ctrlWHandler, editorTabEffect, multiCursorEffect, nativeCommandEffect, nativeKeyHandler, pageHandler, scrollHandler, zChordHandler } from "./finite_chord_handlers.js";
import { commandPromptHandler } from "./command_handler.js";
import { replaceEntryHandler } from "./insert_handler.js";
import { macroControlHandler } from "./macro_handler.js";
import { searchActionHandler, searchOperandHandler, searchPromptHandler, searchSelectionHandler } from "./search_handler.js";
import { prefixHandler } from "./prefix_handlers.js";
import {
  OperatorTarget,
  RangeOperator,
  ResolvedTarget,
  applyOperatorToTarget,
  resolveTarget,
} from "./operator_target.js";
import { lookupDigraph } from "./digraph.js";
import { textObjectForKey, textObjectRange } from "./object.js";
import { SimpleAction, applySimpleAction, simpleActionForKey } from "./normal/simple_action.js";
import { addSurrounds, addTagSurrounds, changeSurrounds, changeSurroundsToTag, deleteSurrounds } from "./surrounds.js";
import { TextRange, VimMode, charwiseSelection, selectionHead } from "./state.js";

// The full normal-mode grammar: the count/register prefix wrapping the raw
// grammar (operators + motions).
export function normalModeHandler(): Handler<void> {
  return prefixHandler(rawNormalModeHandler());
}

function rawNormalModeHandler(): Handler<void> {
  return (key, state) =>
    combineHandleResults([
      operatorRootHandler(key, state),
      simpleActionHandler(key, state),
      markHandler(key, state),
      markJumpHandler(key, state),
      dotRepeatHandler(key, state),
      insertEntryHandler(key, state),
      replaceEntryHandler(key, state),
      changeDeleteShortcutHandler(key, state),
      findHandler(key, state),
      repeatFindHandler(key, state),
      searchActionHandler(key, state),
      searchPromptHandler(key, state),
      commandPromptHandler(key, state),
      macroControlHandler(key, state),
      visualEntryHandler(key, state),
      gChordHandler(key, state),
      zChordHandler(key, state),
      ctrlWHandler(key, state),
      bracketChordHandler(key, state),
      nativeKeyHandler(key, state),
      pageHandler(key, state),
      scrollHandler(key, state),
      lineMotionHandler(key, state),
      movementHandler(key, state),
    ]);
}

// `v`/`V`/`ctrl-v` from normal mode: enter the corresponding visual mode. The
// effect just targets the mode; the owner's transition ([enterModeFromExecutor])
// starts the selection (`VisualMode.enter`). In operator-pending context `v`/`V`
// are forced-motion operands instead, handled in [operandHandler] (this runs at
// the root, where no operator is pending).
function visualEntryHandler(key: string, state: HandlerState): HandleResult<void> {
  switch (key) {
    case "v":
      return effect("visual", () => {}, { dotRepeatable: false });
    case "V":
      return effect("visualLine", () => {}, { dotRepeatable: false });
    case "ctrl-v":
      return effect("visualBlock", () => {}, { dotRepeatable: false });
    default:
      return unhandled();
  }
}

// The `g`-chord prefix. The framework owns parsing of the `g`-chords that do not
// depend on the (not-yet-migrated) visual-mode and search subsystems: motions,
// convert operators, increment/join, native editor/LSP commands, multicursor,
// tabs, the change list, `gi`, `gv` (restore visual selection), and `gn`/`gN`
// (search-selection). All `g`-chords are handled in the framework now (no legacy
// keymap delegation remains).
function gChordHandler(key: string, state: HandlerState): HandleResult<void> {
  if (key !== "g") return unhandled();
  // The `g` prefix claims one pending-depth level (a count typed before it folds
  // in, like an operator). The convert operand reuses this level.
  const operatorDepth = state.hasCount === true ? state.operatorDepth : state.operatorDepth + 1;
  return handler([{ handler: gContinuation, state: { ...cloneHandlerState(state), operatorDepth } }]);
}

function gContinuation(key: string, state: HandlerState): HandleResult<void> {
  // Motions: `gg`/`gj`/`gk`/`g_`/`gM`/`ge`/`gE`.
  const motion = gChordMotion(key);
  if (motion !== undefined) return applyResolvedMotion(state, motion);

  // Convert operators `gu`/`gU`/`g~`/`g?`: g-prefixed operators that take an
  // operand (`guiw`, `gUU`, `gugu`). They reuse the operator machinery; the `g`
  // already claimed the depth level, so use [operandGrammar] directly.
  const convertTarget = convertTargetForKey(key);
  if (convertTarget !== undefined) {
    return operandGrammar({ key, operator: { type: "convert", target: convertTarget }, forChange: false, gPrefixed: true }, state);
  }

  // Format operators `gq`/`gw` (`gw` keeps the cursor): g-prefixed operators
  // over linewise motion operands, with the usual doublings (`gqq`/`gqgq`,
  // `gww`/`gwgw`).
  if (key === "q" || key === "w") {
    return operandGrammar(formatOperatorSpec(key, state), state);
  }

  // Commentary (vim-commentary / VSCodeVim): `gc{motion}`/`gcc`/`gcgc` toggle
  // line comments (linewise, like the plugin), `gC{motion|object}`/`gCC`
  // toggle block comments over the exact range. Delegated to the host's
  // language-aware commenting commands.
  if (key === "c" || key === "C") {
    return operandGrammar(
      { key, operator: { type: "comment", block: key === "C" }, forChange: false, gPrefixed: true, linewiseMotion: key === "c" },
      state
    );
  }

  // `gp`/`gP`: paste after/before, cursor just after the pasted text.
  if (key === "p" || key === "P") {
    return applySimpleActionEffect(state, { type: "paste", before: key === "P", cursorAfter: true });
  }

  // Cumulative increment `g ctrl-a`/`g ctrl-x` and `gJ` (join without a space).
  if (key === "ctrl-a") return applySimpleActionEffect(state, { type: "increment", direction: "increment", cumulative: true });
  if (key === "ctrl-x") return applySimpleActionEffect(state, { type: "increment", direction: "decrement", cumulative: true });
  if (key === "J") return applySimpleActionEffect(state, { type: "joinLines", withSpace: false });

  // Editor-level `g`-chords shared with visual mode: `g r` (refs/rename/quick
  // fix), native `gd`/`gh`/…, multicursor `gl`/…, tabs `gt`/`gT`, change list
  // `g;`/`g,`.
  const editorGChord = editorGChordHandler(key, state);
  if (editorGChord !== undefined) return editorGChord;

  // `gi`: re-enter insert mode at the previous insert position.
  if (key === "i") return insertAtPreviousEffect(state);

  // `gn`/`gN`: select the next/previous search match into a visual selection.
  if (key === "n" || key === "N") return searchSelectionHandler(state, key === "N");

  // `gv`: restore the last visual selection.
  if (key === "v") return restoreVisualSelectionHandler(state);

  // Any other `g`-chord is unrecognized; cancel the chord.
  return invalid();
}

// Editor-level `g`-chords that behave identically in normal and visual mode:
// they run editor/LSP commands and keep the current Vim mode (the leaf effects
// target [state.mode]). `g r` (references/rename/quick fix), native
// `gd`/`gD`/`gy`/`gI`/`gh`/`gx`/`g]`/`g[`, multicursor `gl`/`gL`/`g>`/`g<`/`ga`,
// tabs `gt`/`gT`, change list `g;`/`g,`. Returns undefined for keys that are not
// editor `g`-chords, so the caller can try its mode-specific chords. Shared by
// [gContinuation] and the visual `g`-chord continuation.
export function editorGChordHandler(key: string, state: HandlerState): HandleResult<void> | undefined {
  if (key === "r") return handler([{ handler: gReplaceChord, state: deeper(state) }]);
  const nativeCommand = gChordNativeCommand(key);
  if (nativeCommand !== undefined) return nativeCommandEffect(state, nativeCommand);
  const multiCursorCommand = gChordMultiCursorCommand(key);
  if (multiCursorCommand !== undefined) return multiCursorEffect(state, multiCursorCommand);
  if (key === "t") return editorTabEffect(state, "next");
  if (key === "T") return editorTabEffect(state, "previous");
  if (key === ";") return changeListEffect(state, "older");
  if (key === ",") return changeListEffect(state, "newer");
  return undefined;
}

// `gv`: restore the last visual selection — re-enter visual from normal, or swap
// the current and last selections from visual. [VisualMode.restoreLastSelection]
// sets the selection and returns the restored kind; the dynamic target mode
// follows it (and stays put when there is no remembered selection).
export function restoreVisualSelectionHandler(state: HandlerState): HandleResult<void> {
  const visual = state.visual;
  if (visual === undefined) return invalid();
  let target: VimMode = state.mode;
  return dynamicModeEffect(
    state.mode,
    () => {
      const restored = visual.restoreLastSelection();
      if (restored !== undefined) target = restored;
    },
    () => target,
    { dotRepeatable: false }
  );
}

// The key after `g r`: `g r r` (find references), `g r n` (rename), `g r a`
// (quick fix). All are native commands; an unrecognized key cancels the chord.
function gReplaceChord(key: string, state: HandlerState): HandleResult<void> {
  switch (key) {
    case "r":
      return nativeCommandEffect(state, "editor.action.referenceSearch.trigger");
    case "n":
      return nativeCommandEffect(state, "editor.action.rename");
    case "a":
      return nativeCommandEffect(state, "editor.action.quickFix");
    default:
      return invalid();
  }
}

// `g`-chords that run a single native editor/LSP command.
function gChordNativeCommand(key: string): string | undefined {
  switch (key) {
    case "d":
      return "editor.action.revealDefinition";
    case "D":
      return "editor.action.goToDeclaration";
    case "y":
      return "editor.action.goToTypeDefinition";
    case "I":
      return "editor.action.goToImplementation";
    case "h":
      return "editor.action.showHover";
    case "x":
      return "editor.action.openLink";
    case "]":
      return "editor.action.marker.next";
    case "[":
      return "editor.action.marker.prev";
    default:
      return undefined;
  }
}

// `g`-chords that drive VSCode multicursor/selection commands.
function gChordMultiCursorCommand(key: string): string | undefined {
  switch (key) {
    case "l":
    case "b":
      // `gb` is VSCodeVim's name for add-cursor-at-next-match; kept as an
      // alias of `gl` for migrating users.
      return "editor.action.addSelectionToNextFindMatch";
    case "L":
      return "editor.action.addSelectionToPreviousFindMatch";
    case ">":
      return "editor.action.moveSelectionToNextFindMatch";
    case "<":
      return "editor.action.moveSelectionToPreviousFindMatch";
    case "a":
      return "editor.action.selectHighlights";
    default:
      return undefined;
  }
}

// Change-list navigation (`g;` older / `g,` newer): move [count] entries and put
// the cursor at the resulting position. Not a buffer change.
function changeListEffect(state: HandlerState, direction: ChangeListDirection): HandleResult<void> {
  const editor = state.editor;
  const changeList = state.changeList;
  if (editor === undefined || changeList === undefined) return invalid();
  const count = state.repeat;
  return effect(
    state.mode,
    () => {
      const position = changeList.move(count, direction);
      if (position !== undefined) editor.setSelections([charwiseSelection(position)]);
    },
    { dotRepeatable: false }
  );
}

// `gi`: re-enter insert mode where insert was last left. Like the spelled-out
// insert-entry commands, positioning happens in the effect and the insert
// session (count) rides on [enterInsert].
function insertAtPreviousEffect(state: HandlerState): HandleResult<void> {
  const editor = state.editor;
  if (editor === undefined) return invalid();
  const position = state.lastInsertPosition;
  return effect(
    "insert",
    () => {
      if (position !== undefined) editor.setSelections([charwiseSelection(position)]);
      editor.setCursorStyle("line");
    },
    { enterInsert: { count: state.repeat, separator: "" }, dotRepeatable: true }
  );
}

export function convertTargetForKey(key: string): ConvertTarget | undefined {
  switch (key) {
    case "u":
      return "lower";
    case "U":
      return "upper";
    case "~":
      return "toggle";
    case "?":
      return "rot13";
    default:
      return undefined;
  }
}

// How to apply a resolved find motion. Normal mode moves the cursor
// ([applyFindToCursor]); visual mode extends the live selection (see
// `visual_handler.ts`). [record] is set for a fresh `f`/`t` (so `;`/`,` can
// repeat it) and cleared for a `;`/`,` repeat.
export type FindApplier = (
  state: HandlerState,
  motion: FindMotion,
  opts: { record: boolean }
) => HandleResult<void>;

// Default find applier: move the cursor (normal-mode find), recording the motion
// for `;`/`,` when requested.
const applyFindToCursor: FindApplier = (state, motion, { record }) =>
  applyResolvedMotion(state, motion, record ? motion : undefined);

// Bare find motions `f`/`t`/`F`/`T` then the target char: apply the find (move
// the cursor in normal mode, extend the selection in visual mode) and remember
// it so `;`/`,` can repeat it. As an operator operand (`dfx`), find is handled in
// [operandHandler]; this is the root (plain motion) form. [apply] selects the
// normal vs visual application so both grammars share the chord/digraph logic.
export function findHandler(
  key: string,
  state: HandlerState,
  apply: FindApplier = applyFindToCursor
): HandleResult<void> {
  const kind = findKindForKey(key);
  if (kind === undefined) return unhandled();
  const findChar = (char: string, charState: HandlerState): HandleResult<void> =>
    apply(charState, findMotionForChar(kind, char), { record: true });
  return handler([
    {
      handler: (char, charState) => {
        if (char === "ctrl-k") {
          return handler([{ handler: digraphWaiter(findChar), state: deeper(charState) }]);
        }
        const input = keyForInput(char);
        if (input.length !== 1) return invalid();
        return findChar(input, charState);
      },
      state: deeper(state),
    },
  ]);
}

// `;` repeats the last find, `,` repeats it reversed. [apply] selects the normal
// vs visual application, like [findHandler].
export function repeatFindHandler(
  key: string,
  state: HandlerState,
  apply: FindApplier = applyFindToCursor
): HandleResult<void> {
  if (key !== ";" && key !== ",") return unhandled();
  const motion = state.find?.repeat(key === ",");
  if (motion === undefined) return effect(state.mode, () => {});
  return apply(state, motion, { record: false });
}

// Apply an already-resolved motion to the live selections — the root-motion
// counterpart of [movementHandler] for motions the grammar resolves itself
// (char-input find). [recordFind], when given, stores the motion for `;`/`,`.
function applyResolvedMotion(state: HandlerState, motion: Motion, recordFind?: FindMotion): HandleResult<void> {
  const editor = state.editor;
  if (editor === undefined) return invalid();
  return effect(state.mode, () => {
    const results: MotionResult[] = editor.getSelections().map(selection => ({
      position: applyMotion(editor, selectionHead(selection), motion, state.repeat),
    }));
    applyMotionResults(editor, results);
    if (recordFind !== undefined) state.find?.record(recordFind);
  });
}

// Single-key operator+operand aliases: `s`=`cl`, `S`=`cc`, `C`=`c$`, `D`=`d$`,
// `Y`=`y$` (Neovim's default `Y` mapping; classic Vim's whole-line `Y` is a
// one-line user remap away). `s`/`S`/`C` are changes (enter insert); `D`
// deletes; `Y` yanks. They reuse the operator machinery with a fixed target,
// so counts, registers, and dot-repeat behave like the spelled-out forms.
function changeDeleteShortcutHandler(key: string, state: HandlerState): HandleResult<void> {
  switch (key) {
    case "s":
      return applyOperator(CHANGE_OPERATOR, state, { kind: "motion", motion: { type: "right" } });
    case "S":
      return applyOperator(CHANGE_OPERATOR, state, { kind: "line" });
    case "Y":
      return applyOperator(YANK_OPERATOR, state, { kind: "motion", motion: { type: "endOfLine" } });
    case "C":
      return applyOperator(CHANGE_OPERATOR, state, { kind: "motion", motion: { type: "endOfLine" } });
    case "D":
      return applyOperator(DELETE_OPERATOR, state, { kind: "motion", motion: { type: "endOfLine" } });
    default:
      return unhandled();
  }
}

// Insert-entry commands (`i`/`a`/`I`/`A`/`o`/`O`): position the cursor (pure
// editor work) and target insert mode. The session params (count for `3i`,
// `\n` separator for `o`/`O`) ride out on the effect's [enterInsert] meta, which
// the executor-owned mode transition consumes; [Vim] still owns the session
// itself. Dot-repeat/macros replay the recorded keys (typed text + `<escape>`).
function insertEntryHandler(key: string, state: HandlerState): HandleResult<void> {
  const kind = insertEntryKindForKey(key);
  if (kind === undefined) return unhandled();
  const editor = state.editor;
  if (editor === undefined) return invalid();
  const separator = kind === "o" || kind === "O" ? "\n" : "";
  return effect("insert", () => positionForInsertEntry(editor, kind), {
    enterInsert: { count: state.repeat, separator },
    dotRepeatable: true,
  });
}

function positionForInsertEntry(editor: VimEditorCapabilities, kind: InsertEntryKind): void {
  switch (kind) {
    case "i":
      enterInsertAtSelections(editor, pos => pos);
      return;
    case "a":
      enterInsertAtSelections(editor, pos => ({
        row: pos.row,
        column: Math.min(pos.column + 1, editor.lineLength(pos.row)),
      }));
      return;
    case "I":
      enterInsertAtSelections(editor, pos => firstNonWhitespace(editor.line(pos.row), pos.row));
      return;
    case "A":
      enterInsertAtSelections(editor, pos => ({ row: pos.row, column: editor.lineLength(pos.row) }));
      return;
    case "o":
      openLine(editor, { above: false }, keepUndoTransactionOpen());
      return;
    case "O":
      openLine(editor, { above: true }, keepUndoTransactionOpen());
      return;
  }
}

function insertEntryKindForKey(key: string): InsertEntryKind | undefined {
  switch (key) {
    case "i":
    case "a":
    case "I":
    case "A":
    case "o":
    case "O":
      return key;
    default:
      return undefined;
  }
}

// `m{char}`: set the named mark to the current cursor. The injected [marks]
// store is reached straight from the handler state. Not a buffer edit and not
// dot-repeatable; macros replay it via the recorded `m`+name keys.
function markHandler(key: string, state: HandlerState): HandleResult<void> {
  if (key !== "m") return unhandled();
  return handler([
    {
      handler: (name, markState) =>
        effect(markState.mode, () => {
          const editor = markState.editor;
          if (editor !== undefined) markState.marks?.createMark(editor, name);
        }),
      state: deeper(state),
    },
  ]);
}

// Standalone `` ` ``/`'` mark jumps: wait for the mark name, then jump (`'` is
// linewise: first non-blank of the mark's line). The operand form (`d'a`) is
// handled by the operator grammar; this is the idle motion. A count is ignored,
// like the legacy jump. Not a change, so not dot-repeatable.
function markJumpHandler(key: string, state: HandlerState): HandleResult<void> {
  if (key !== "'" && key !== "`") return unhandled();
  const line = key === "'";
  return handler([
    {
      handler: (name, jumpState) => {
        if (isEscapeKey(name)) return invalid();
        const editor = jumpState.editor;
        const marks = jumpState.marks;
        if (editor === undefined || marks === undefined) return invalid();
        return effect(
          "normal",
          () => {
            const motion = marks.jumpMotion(editor, name, { line });
            if (motion === undefined) return;
            applyMotionResults(
              editor,
              editor.getSelections().map(selection => ({
                position: applyMotion(editor, selectionHead(selection), motion, 1),
              }))
            );
          },
          { dotRepeatable: false }
        );
      },
      state: deeper(state),
    },
  ]);
}

// `.`: replay the last recorded change. Like the macro replay (`@`/`Q`), the
// replay is *requested* and run by the owner after the executor's effect drain,
// because it feeds recorded keys back through the dispatcher. Transparent to
// dot-repeat: `.` itself must not open or cancel a recording — the replay
// machinery updates the last change (count overrides, numbered-paste advance)
// itself. A `.` typed while a dot replay is already running is ignored.
function dotRepeatHandler(key: string, state: HandlerState): HandleResult<void> {
  if (key !== ".") return unhandled();
  if (state.repeatState?.isReplaying() === true) return unhandled();
  const count = state.hasCount === true ? state.repeat : undefined;
  const register = state.register;
  return effect("normal", () => state.requestDotReplay?.(count, register), {
    preservesDotRepeat: true,
  });
}

function isEscapeKey(key: string): boolean {
  return key === "escape" || key === "<escape>" || key === "ctrl-[";
}

// Leaf normal-mode actions that take no motion/object operand: the single-key
// `x`/`X`/`~`/`J`/`ctrl-a`/`ctrl-x`/`p`/`P`, and the char-input `r{char}`. Each
// applies immediately; dot-repeat/macros replay the recorded keys.
function simpleActionHandler(key: string, state: HandlerState): HandleResult<void> {
  // `r`: replace the char(s) under the cursor with the next typed char (or a
  // `ctrl-k` digraph).
  if (key === "r") {
    return handler([{ handler: replaceCharWaiter, state: deeper(state) }]);
  }
  const action = simpleActionForKey(key);
  if (action === undefined) return unhandled();
  return applySimpleActionEffect(state, action);
}

// The char after `r`: a literal replacement, or `ctrl-k` to begin a digraph.
function replaceCharWaiter(char: string, state: HandlerState): HandleResult<void> {
  if (char === "ctrl-k") {
    return handler([{ handler: digraphWaiter(replaceWith), state: deeper(state) }]);
  }
  return replaceWith(keyForInput(char), state);
}

function replaceWith(char: string, state: HandlerState): HandleResult<void> {
  return applySimpleActionEffect(state, { type: "replaceChar", char });
}

// Collect the two chars of a `ctrl-k` digraph and resolve the target char into
// [onResolved]. Shared by `r ctrl-k` (replace, normal + visual) and `f`/`t`
// `ctrl-k` (find).
export function digraphWaiter(
  onResolved: (char: string, state: HandlerState) => HandleResult<void>,
  first?: string
): Handler<void> {
  return (char, state) => {
    if (first === undefined) {
      return handler([{ handler: digraphWaiter(onResolved, keyForInput(char)), state: deeper(state) }]);
    }
    return onResolved(lookupDigraph(first, keyForInput(char)), state);
  };
}

function applySimpleActionEffect(state: HandlerState, action: SimpleAction): HandleResult<void> {
  const editor = state.editor;
  const registers = state.registers;
  if (editor === undefined || registers === undefined) return invalid();
  const register = state.register;
  const count = state.repeat;
  return effect(state.mode, () => applySimpleAction(editor, registers, register, count, action), {
    dotRepeatable: true,
  });
}

// ---------------------------------------------------------------------------
// Motions
// ---------------------------------------------------------------------------

// Key -> motion, including the count-sensitive `%` (match-pair without a count,
// go-to-percentage with one). Char-input motions (`f`/`t`), line targets
// (`G`/`gg`), and marks are resolved by their own grammar arms, not here.
export function resolveMotion(key: string, state: HandlerState): Motion | undefined {
  if (key === "%") {
    return state.hasCount === true
      ? { type: "goToPercentage", percent: state.repeat }
      : { type: "matching" };
  }
  // `|`: go to the (1-based) column given by the count (default 1). Like `%`, the
  // count is baked into the motion (idempotent) rather than applied as a repeat,
  // so it moves/extends correctly through the count-repeating visual path.
  if (key === "|") return { type: "goToColumn", column: state.repeat };
  return motionForKey(key);
}

// Linewise motions that are kept out of [resolveMotion] (so the operator
// grammar, which resolves `G` via its own `{kind:"lastLine"}` arm and would
// otherwise treat `+`/`-`/`<CR>` as charwise, is unaffected): standalone `G`
// (count-aware: line N, else the last line — keeping the column, Vim
// 'nostartofline'), and `+`/`-`/`<CR>` (count lines down/up to the first
// non-blank; `<CR>` is `+`). Shared by the normal-mode [lineMotionHandler] and
// the visual-mode `visualLineMotionHandler`. (`|` go-to-column is charwise, so it
// lives in [resolveMotion] like `%`.)
export function lineMotionForKey(key: string, state: HandlerState): Motion | undefined {
  switch (key) {
    case "G": {
      const lastLine = state.editor?.lineCount() ?? 1;
      return { type: "goToLine", line: state.hasCount === true ? state.repeat : lastLine };
    }
    case "+":
    case "enter":
      // `<CR>` is `+`: [count] lines down to the first non-blank.
      return { type: "firstNonBlankLine", direction: "down" };
    case "-":
      return { type: "firstNonBlankLine", direction: "up" };
    default:
      return undefined;
  }
}

// Standalone line motions (`G`/`+`/`-`) moving the cursor. As operator targets
// (`dG`) they are resolved by the operand grammar's own line-target arm, so this
// only runs at the root (plain movement).
function lineMotionHandler(key: string, state: HandlerState): HandleResult<void> {
  const motion = lineMotionForKey(key, state);
  if (motion === undefined) return unhandled();
  return applyResolvedMotion(state, motion);
}

// A bare cursor-motion handler, exported for reuse. Returns unhandled for any
// key that is not a motion the framework owns for plain movement.
export function movementHandler(key: string, state: HandlerState): HandleResult<void> {
  const motion = resolveMotion(key, state);
  if (motion === undefined) return unhandled();
  const result = mapHandler(
    motionHandlerForMotion(motion),
    (results, state) => {
      const editor = state.editor;
      if (editor === undefined) return;
      applyMotionResults(editor, results);
    }
  )(key, state);
  // Motions are not dot-repeatable; macros replay them via their recorded keys.
  return result;
}

// Wrap a resolved [Motion] in a [motionHandler]-style effect over the live
// selections. Unlike [motionHandler] (which re-resolves the key), this uses the
// already-resolved motion so count-sensitive keys (`%`) move correctly.
function motionHandlerForMotion(motion: Motion): Handler<readonly MotionResult[]> {
  // [motionHandler] resolves the key itself via [motionForKey]; for the
  // count-baked motions (`%` go-to-percentage, `|` go-to-column) that key
  // resolution would drop the count, so apply the motion we already computed.
  if (motion.type === "goToPercentage" || motion.type === "goToColumn") {
    return (_key, state) =>
      effect(state.mode, () => {
        const editor = state.editor;
        if (editor === undefined) return [];
        return editor.getSelections().map((selection) => {
          const start = selectionHead(selection);
          return { position: applyMotion(editor, start, motion, state.repeat), goal: undefined };
        });
      });
  }
  return motionHandler((state) => {
    const selections = state.editor?.getSelections() ?? [];
    return {
      starts: selections.map(selectionHead),
      goal: selections[0]?.goal,
    };
  });
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

type OperatorSpec = {
  key: string;
  operator: RangeOperator;
  // `c`: expand `cw` to `ce`, and (with text objects) use change-specific
  // cancellation; also enters insert mode after applying.
  forChange: boolean;
  // `gu`/`gU`/`g~`/`g?`: a `g`-prefixed operator. The whole-line doubling is the
  // full chord repeated (`gugu`), not just [key] (`guu`); [operandHandler]
  // recognizes the extra `g`-form.
  gPrefixed?: boolean;
  // `gq`/`gw`: the operator makes its motion operand linewise (Vim: "format the
  // lines that {motion} moves over"), using the raw motion target row — an
  // exclusive motion ending in column zero still includes that row (`gq}`
  // formats through the paragraph's trailing blank line).
  linewiseMotion?: boolean;
};

// Shared so the single-key aliases (`s`/`S`/`C`/`D`) reuse the exact same specs
// as the spelled-out `c`/`d` operators.
const CHANGE_OPERATOR: OperatorSpec = { key: "c", operator: { type: "change" }, forChange: true };
const DELETE_OPERATOR: OperatorSpec = { key: "d", operator: { type: "delete" }, forChange: false };
const YANK_OPERATOR: OperatorSpec = { key: "y", operator: { type: "yank" }, forChange: false };

function operatorForKey(key: string): OperatorSpec | undefined {
  switch (key) {
    case "d":
      return DELETE_OPERATOR;
    case "c":
      return CHANGE_OPERATOR;
    case "y":
      return YANK_OPERATOR;
    case ">":
      return { key, operator: { type: "indent", direction: "in" }, forChange: false };
    case "<":
      return { key, operator: { type: "indent", direction: "out" }, forChange: false };
    case "=":
      return { key, operator: { type: "indent", direction: "auto" }, forChange: false };
    default:
      return undefined;
  }
}

// `gq`/`gw`: format (reflow to 'textwidth') the operand's lines; `gw` restores
// the cursor. The effective 'textwidth' comes from the configuration at
// operator-build time.
function formatOperatorSpec(key: "q" | "w", state: HandlerState): OperatorSpec {
  return {
    key,
    operator: { type: "format", keepCursor: key === "w", textwidth: configuredTextwidth(state) },
    forChange: false,
    gPrefixed: true,
    linewiseMotion: true,
  };
}

// The `gq`/`gw` format width: an explicit `vim.textwidth` wins; otherwise the
// editor's first vertical ruler (`editor.rulers`, like VSCodeVim); otherwise 0,
// which [applyFormat] resolves to Vim's 79-column 'textwidth'=0 fallback.
export function configuredTextwidth(state: HandlerState): number {
  const configured = state.configuration?.textwidth ?? 0;
  if (configured > 0) return configured;
  const ruler = state.editor?.rulerColumns()[0];
  return ruler !== undefined && ruler > 0 ? ruler : 0;
}

// Claims an operator key from a clean state and continues into the operand
// grammar (the operand owns its own count via [prefixHandler]).
function operatorRootHandler(key: string, state: HandlerState): HandleResult<void> {
  const spec = operatorForKey(key);
  if (spec === undefined) return unhandled();
  return operandContinuation(spec, state);
}

// Begin an operator's operand grammar (motion/object/doubled-key/...) at the
// current pending depth. The caller is responsible for having claimed the
// operator's depth level.
function operandGrammar(spec: OperatorSpec, state: HandlerState): HandleResult<void> {
  return handler([{ handler: prefixHandler(operandHandler(spec)), state: cloneHandlerState(state) }]);
}

// Claim a depth level for a root operator (`d`/`c`/`y`/`>`/...) and begin its
// operand grammar. The g-prefixed convert operators claim their level at the
// `g` prefix instead (see [gChordHandler]), so they call [operandGrammar].
function operandContinuation(spec: OperatorSpec, state: HandlerState): HandleResult<void> {
  // Pending-depth: the operator's own count (typed before it) folds into the
  // operator entry rather than adding a level (`2d` is one entry). A fresh
  // operand count typed after the operator is its own entry.
  const operatorDepth = state.hasCount === true ? state.operatorDepth : state.operatorDepth + 1;
  return operandGrammar(spec, { ...cloneHandlerState(state), operatorDepth });
}

// The operand grammar after an operator: doubled key (linewise), text objects
// (`i`/`a`), forced motions (`v`/`V`), char-input find (`f`/`t`/`F`/`T`), marks
// (`` ` ``/`'`), line targets (`G`/`gg`), and plain motions. Any unrecognized
// key cancels the operator (`invalid`).
function operandHandler(spec: OperatorSpec): Handler<void> {
  return (key, state) => {
    const editor = state.editor;
    const registers = state.registers;
    if (editor === undefined || registers === undefined) return invalid();

    // Doubled operator key: linewise on [repeat] lines (`dd`/`cc`/`yy`/`>>`,
    // and `guu`/`gUU`/... where [key] is the convert key).
    if (key === spec.key) {
      return applyOperator(spec, state, { kind: "line" });
    }

    // A g-prefixed operator (`gu`/`gU`/`g~`/`g?`) also doubles via its full
    // chord (`gugu`); other `g`-operands stay motions (`gugg`, `gug_`).
    if (spec.gPrefixed === true && key === "g") {
      return handler([
        {
          handler: (key2, gState) => {
            if (key2 === spec.key) return applyOperator(spec, gState, { kind: "line" });
            const motion = gChordMotion(key2);
            return motion === undefined ? invalid() : applyOperator(spec, gState, { kind: "motion", motion });
          },
          state: deeper(state),
        },
      ]);
    }

    // Text objects: `i`/`a` then the object key.
    if (key === "i" || key === "a") {
      return handler([{ handler: objectHandler(spec, key === "a"), state: deeper(state) }]);
    }

    // Surround (`ys`/`ds`/`cs`): `s` after the operator.
    if (key === "s") {
      return startSurround(spec, state);
    }

    // Forced motions: `v` (charwise) / `V` (linewise) then a (counted) motion.
    if (key === "v" || key === "V") {
      return handler([
        {
          handler: prefixHandler(motionOperand(spec, key === "V" ? "linewise" : "charwise")),
          state: deeper(state),
        },
      ]);
    }

    // `G`: linewise to the last line (or line N with a count). It is a line
    // target rather than a `Motion`, so it is its own descriptor kind, not part
    // of the motion grammar; [resolveTarget] reads [hasCount].
    if (key === "G") {
      return applyOperator(spec, state, { kind: "lastLine" });
    }

    // Everything else is a motion: single keys (incl. `%`), char-input find
    // (`f`/`t`/`F`/`T`), marks (`` ` ``/`'`), `g`-chords (`gg`/`gM`/`ge`/...),
    // and `]`/`[` bracket motions. Unrecognized keys cancel the operator.
    return motionOperand(spec, undefined)(key, state);
  };
}

function objectHandler(spec: OperatorSpec, around: boolean): Handler<void> {
  return (key, state) => {
    const object = textObjectForKey(key);
    if (object === undefined) return invalid();
    return applyOperator(spec, state, { kind: "object", object, around });
  };
}

// Operand motion grammar for an operator, applying the operator to the motion's
// target. [forced] applies a forced-motion override (`dvj`/`dVj`).
function motionOperand(spec: OperatorSpec, forced: "charwise" | "linewise" | undefined): Handler<void> {
  return motionChordHandler((motion, state) =>
    applyOperator(spec, state, { kind: "motion", motion, forced })
  );
}

// Parses one motion — single key, char-input find, mark, `g`-chord, or `]`/`[`
// bracket motion — and hands the resolved [Motion] to [apply]. Used for both
// operator operands and forced-motion operands.
function motionChordHandler(
  apply: (motion: Motion, state: HandlerState) => HandleResult<void>
): Handler<void> {
  return (key, state) => {
    if (state.editor === undefined) return invalid();

    // Search as a motion operand (`d/`/`c/`/`y/`): the incremental prompt yields
    // a search [Motion], applied via [apply]. It is an in-graph waiter so the
    // pending operator survives (see [searchOperandHandler]).
    if (key === "/" || key === "?") {
      return searchOperandHandler(state, key === "?", apply);
    }

    // Char-input find motions (`f`/`t`/`F`/`T`) then the target char.
    const findKind = findKindForKey(key);
    if (findKind !== undefined) {
      return handler([
        {
          handler: (char, charState) =>
            char.length === 1 ? apply(findMotionForChar(findKind, char), charState) : invalid(),
          state: deeper(state),
        },
      ]);
    }

    // Marks (`` `a ``/`'a`) then the mark name.
    if (key === "`" || key === "'") {
      const line = key === "'";
      return handler([
        {
          handler: (name, markState) => {
            const editor = markState.editor;
            const motion = editor === undefined ? undefined : markState.marks?.jumpMotion(editor, name, { line });
            return motion === undefined ? invalid() : apply(motion, markState);
          },
          state: deeper(state),
        },
      ]);
    }

    // `g`-chord motions (`gg`/`g_`/`gM`/`ge`/`gE`/`gj`/`gk`) and the
    // search-selection operands `gn`/`gN` (`dgn`/`cgn`: operate on the next/prev
    // search match).
    if (key === "g") {
      return handler([
        {
          handler: (key2, gState) => {
            if (key2 === "n" || key2 === "N") return searchSelectionOperand(gState, key2 === "N", apply);
            const motion = gChordMotion(key2);
            return motion === undefined ? invalid() : apply(motion, gState);
          },
          state: deeper(state),
        },
      ]);
    }

    // `]`/`[` bracket motions (`]}`/`])`/`[{`/`[(`).
    if (key === "]" || key === "[") {
      const bracket = key;
      return handler([
        {
          handler: (key2, bracketState) => {
            const motion = bracketMotion(bracket, key2);
            return motion === undefined ? invalid() : apply(motion, bracketState);
          },
          state: deeper(state),
        },
      ]);
    }

    // Single-key motions (incl. count-sensitive `%`).
    const motion = resolveMotion(key, state);
    if (motion !== undefined) return apply(motion, state);
    return invalid();
  };
}

// `gn`/`gN` as an operator operand (`dgn`/`cgn`): the next/previous search match
// becomes the operator's target range. With no match the operator aborts without
// editing — and during a dot-repeat replay it also stops the replay so any
// recorded insert text (`cgn…<esc>`) is not run as normal-mode keys (Vim's
// behavior for a `.`-replayed `cgn` that finds nothing).
function searchSelectionOperand(
  state: HandlerState,
  reversed: boolean,
  apply: (motion: Motion, state: HandlerState) => HandleResult<void>
): HandleResult<void> {
  const editor = state.editor;
  const search = state.search;
  if (editor === undefined || search === undefined) return invalid();
  // Operator operands run in normal mode, so the current match counts
  // (`includeStart`), matching the legacy `applySearchSelection`.
  const range = search.matchRangeForSelection(editor, { reversed, count: state.repeat, includeStart: true });
  if (range === undefined) {
    const repeatState = state.repeatState;
    return effect("normal", () => repeatState?.abortCurrentReplay(), { dotRepeatable: false });
  }
  return apply({ type: "searchMatch", range }, state);
}

// `g`-chord motions usable as operator operands. Non-motion `g`-chords (convert,
// tabs, ...) are not operands and resolve to undefined (cancel).
export function gChordMotion(key: string): Motion | undefined {
  switch (key) {
    case "g":
      // `gg`: go to the first line (or line N with a count); [operatorTarget]
      // resolves [startOfDocument] linewise with the count.
      return { type: "startOfDocument" };
    case "_":
      return { type: "lastNonWhitespace" };
    case "M":
      return { type: "middleOfLine" };
    case "e":
      return { type: "previousWordEnd", bigWord: false };
    case "E":
      return { type: "previousWordEnd", bigWord: true };
    case "j":
      return { type: "down", displayLine: true };
    case "k":
      return { type: "up", displayLine: true };
    default:
      return undefined;
  }
}

// Apply an operator to a lazy [OperatorTarget] descriptor. The descriptor is
// resolved against the current editor here (via [resolveTarget]); a future
// repeatable-command replay re-resolves the same descriptor against the cursor
// as it is then. The effect's target mode drives the post-action transition
// (the executor's [onEnterMode]): `change` targets insert mode, unless the
// change is a no-op (e.g. `ci"` with no quotes), in which case it stays in
// normal mode. That condition is checked synchronously from the resolved target;
// keys dispatch synchronously, so the mode must be known before the effect runs.
function applyOperator(spec: OperatorSpec, state: HandlerState, target: OperatorTarget): HandleResult<void> {
  const editor = state.editor;
  const registers = state.registers;
  if (editor === undefined || registers === undefined) return invalid();
  const register = state.register;
  const hasCount = state.hasCount === true;
  const effectiveTarget: OperatorTarget =
    spec.linewiseMotion === true && target.kind === "motion" && target.forced === undefined
      ? { ...target, forced: "linewise" }
      : target;
  const resolved = resolveTarget(editor, effectiveTarget, state.repeat, { hasCount, forChange: spec.forChange });
  const mode = spec.forChange && changeEntersInsert(resolved) ? "insert" : state.mode;
  // Every operator but yank modifies the buffer, so only yank is not
  // dot-repeatable (`.` repeats the last *change*).
  return effect(
    mode,
    () => {
      applyOperatorToTarget(editor, registers, register, spec.operator, resolved);
    },
    { dotRepeatable: spec.operator.type !== "yank" }
  );
}

// Whether a `change` against [resolved] will enter insert mode, mirroring
// [applyChange]: a charwise change enters insert unless every target is
// cancelled (a failed motion / `cap` on a trailing blank line); a linewise
// change enters insert when it has any rows.
function changeEntersInsert(resolved: ResolvedTarget): boolean {
  switch (resolved.kind) {
    case "charwise":
      return resolved.targets.some(({ cancelled }) => cancelled !== true);
    case "linewise":
      return resolved.rows.length > 0;
  }
}

// ---------------------------------------------------------------------------
// Surround (vim-surround: `ys`/`ds`/`cs`)
// ---------------------------------------------------------------------------

type SurroundTarget = { ranges: readonly TextRange[]; linewise: boolean };

// `s` after an operator: add (`ys`), delete (`ds`), or change (`cs`) surrounds.
function startSurround(spec: OperatorSpec, state: HandlerState): HandleResult<void> {
  switch (spec.operator.type) {
    case "yank":
      // `ys`: capture a range (motion/object/`yss` line), then the pair char.
      return handler([{ handler: prefixHandler(addSurroundRangeHandler()), state: deeper(state) }]);
    case "delete":
      // `ds{char}`: delete the surrounding pair named by the next char.
      return handler([
        { handler: deleteSurroundHandler(), state: deeper(state) },
      ]);
    case "change":
      // `cs{from}{to}`: change the `from` pair to the `to` pair.
      return handler([
        { handler: changeSurroundHandler(undefined), state: deeper(state) },
      ]);
    default:
      return invalid();
  }
}

// `ys` range capture: a motion, a text object (`ysiw`), or doubling `s` for the
// trimmed current line (`yss`). Resolves to the pair-char waiter.
function addSurroundRangeHandler(): Handler<void> {
  return (key, state) => {
    const editor = state.editor;
    if (editor === undefined) return invalid();
    // `yss`: trimmed current line(s).
    if (key === "s") {
      const ranges = editor.getSelections().map((selection) =>
        trimmedLineRange(editor, selectionHead(selection).row, state.repeat)
      );
      return surroundPairWaiter(state, { ranges, linewise: false });
    }
    // `ysiw` / `ysaw` etc.: text object range.
    if (key === "i" || key === "a") {
      return handler([{ handler: addSurroundObjectHandler(key === "a"), state: deeper(state) }]);
    }
    // `ysw` etc.: motion range.
    const motion = resolveMotion(key, state);
    if (motion !== undefined) {
      const ranges = surroundRangesForTarget(
        editor,
        resolveTarget(editor, { kind: "motion", motion }, state.repeat)
      );
      return surroundPairWaiter(state, ranges);
    }
    return invalid();
  };
}

function addSurroundObjectHandler(around: boolean): Handler<void> {
  return (key, state) => {
    const editor = state.editor;
    if (editor === undefined) return invalid();
    const object = textObjectForKey(key);
    if (object === undefined) return invalid();
    const ranges = editor.getSelections().map((selection) =>
      textObjectRange(editor, selectionHead(selection), object, { around, count: state.repeat })
    );
    return surroundPairWaiter(state, { ranges, linewise: false });
  };
}

// Pending continuation that consumes the pair character and applies the add.
// `t` and `<` enter tag-entry mode instead (vim-surround: type the tag body,
// finish with `>` or enter).
function surroundPairWaiter(state: HandlerState, target: SurroundTarget): HandleResult<void> {
  return handler([
    {
      handler: (key, state) => {
        const editor = state.editor;
        if (editor === undefined) return invalid();
        if (key === "t" || key === "<") {
          return tagEntryWaiter(state, "", (tagBody, entryState) =>
            effect(entryState.mode, () =>
              addTagSurrounds(editor, target.ranges, tagBody, { linewise: target.linewise })
            )
          );
        }
        return effect(state.mode, () =>
          addSurrounds(editor, target.ranges, keyForInput(key), { linewise: target.linewise })
        );
      },
      state: deeper(state),
    },
  ]);
}

// vim-surround tag entry: after a `t`/`<` target, collect the tag body until
// `>` or enter finishes it (escape cancels, backspace edits). [onDone] gets
// the body and whether enter (vs `>`) finished it — `cst` + enter preserves
// the old tag's attributes.
function tagEntryWaiter(
  state: HandlerState,
  collected: string,
  onDone: (tagBody: string, state: HandlerState, finishedWithEnter: boolean) => HandleResult<void>
): HandleResult<void> {
  return handler([
    {
      handler: (key, entryState) => {
        if (isEscapeKey(key)) return invalid();
        if (key === ">") return onDone(collected, entryState, false);
        if (key === "enter") return onDone(collected, entryState, true);
        if (key === "backspace") {
          return tagEntryWaiter(entryState, collected.slice(0, -1), onDone);
        }
        const char = keyForInput(key);
        if (char.length !== 1) return invalid();
        return tagEntryWaiter(entryState, collected + char, onDone);
      },
      state: cloneHandlerState(state),
    },
  ]);
}

function deleteSurroundHandler(): Handler<void> {
  return (key, state) => {
    const editor = state.editor;
    if (editor === undefined) return invalid();
    return effect(state.mode, () => deleteSurrounds(editor, keyForInput(key)));
  };
}

function changeSurroundHandler(fromKey: string | undefined): Handler<void> {
  return (key, state) => {
    const editor = state.editor;
    if (editor === undefined) return invalid();
    if (fromKey === undefined) {
      return handler([
        {
          handler: changeSurroundHandler(keyForInput(key)),
          state: deeper(state),
        },
      ]);
    }
    const from = fromKey;
    if (key === "t" || key === "<") {
      return tagEntryWaiter(state, "", (tagBody, entryState, finishedWithEnter) =>
        effect(entryState.mode, () =>
          changeSurroundsToTag(editor, from, tagBody, { preserveAttributes: finishedWithEnter })
        )
      );
    }
    return effect(state.mode, () => changeSurrounds(editor, from, keyForInput(key)));
  };
}

function surroundRangesForTarget(editor: VimEditorCapabilities, target: ResolvedTarget): SurroundTarget {
  switch (target.kind) {
    case "charwise":
      return { ranges: target.targets.map(({ range }) => range), linewise: false };
    case "linewise":
      return {
        ranges: target.rows.map(({ startRow, endRow }) => ({
          start: { row: startRow, column: 0 },
          end: { row: endRow, column: editor.lineLength(endRow) },
        })),
        linewise: true,
      };
  }
}

function trimmedLineRange(editor: VimEditorCapabilities, row: number, count: number): TextRange {
  const range = lineRange(editor, row, count);
  if (range.start.row !== range.end.row) return range;
  const line = editor.line(row);
  const first = line.search(/\S/);
  if (first < 0) return range;
  const last = line.search(/\s*$/);
  return { start: { row, column: first }, end: { row, column: last } };
}

export function keyForInput(key: string): string {
  return key === "space" ? " " : key;
}

// ---------------------------------------------------------------------------
// Find motions (char input)
// ---------------------------------------------------------------------------

type FindKind = "findForward" | "tillForward" | "findBackward" | "tillBackward";

function findKindForKey(key: string): FindKind | undefined {
  switch (key) {
    case "f":
      return "findForward";
    case "t":
      return "tillForward";
    case "F":
      return "findBackward";
    case "T":
      return "tillBackward";
    default:
      return undefined;
  }
}

function findMotionForChar(kind: FindKind, char: string): FindMotion {
  switch (kind) {
    case "findForward":
      return { type: "findForward", before: false, char };
    case "tillForward":
      return { type: "findForward", before: true, char };
    case "findBackward":
      return { type: "findBackward", after: false, char };
    case "tillBackward":
      return { type: "findBackward", after: true, char };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deeper(state: HandlerState): HandlerState {
  return { ...cloneHandlerState(state), operatorDepth: state.operatorDepth + 1 };
}
