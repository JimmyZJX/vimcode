// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/command.rs
// - translated concepts: a small Ex command parser with ranges, goto, join,
//   delete, sort, and substitute commands
// - intentional differences: this is a deliberately small model-buffer command
//   executor. Zed integrates with the command palette, workspace actions, shell
//   commands, marks, regex conversion, and async UI completion.

import { VimEditorCapabilities } from "./editor.js";
import { indentRanges } from "./normal/indent.js";
import { HistoryNavigation, PromptHistory, historyNavigationKey } from "./prompt_history.js";
import { RegisterName, Registers, parseRegisterName } from "./registers.js";
import { translateVimRegex } from "./search.js";
import { SingleLineEditor } from "./single_line_editor.js";
import { TextEdit, TextRange, charwiseSelection, selectionHead } from "./state.js";

// The in-flight `:` command-line input, held while in `command` mode. The
// same [SingleLineEditor] mini-buffer as the `/`?` search prompt: typed keys
// insert at the cursor, `<Left>`/`<Right>`/`<Home>`/`<End>` move it, and
// `backspace`/`delete` (and the ctrl word variants) edit around it. Owned by
// [Vim] (mode entry constructs it, prefilling `'<,'>` from a visual
// selection) and injected live into the pure command-mode grammar. [history]
// is the global command history; `<Up>`/`<C-p>` recall through it (see
// [PromptHistory]).
export class CommandLine {
  private readonly input: SingleLineEditor;
  private nav: HistoryNavigation | undefined;

  constructor(initial = "", private readonly history: PromptHistory = new PromptHistory()) {
    this.input = new SingleLineEditor(initial);
  }

  value(): string {
    return this.input.value();
  }

  cursorPosition(): number {
    return this.input.cursorPosition();
  }

  insert(key: string): void {
    this.input.insert(key === "space" ? " " : key);
    this.nav = undefined;
  }

  // An editing key (cursor movement, deletes); false for keys the mini-buffer
  // does not understand — the grammar swallows those.
  tryKey(key: string): boolean {
    if (!this.input.tryKey(key)) return false;
    this.nav = undefined;
    return true;
  }

  // `<Up>`/`<Down>`/`<C-p>`/`<C-n>`: recall through the command history.
  // Returns false for other keys.
  historyKey(key: string): boolean {
    const step = historyNavigationKey(key);
    if (step === undefined) return false;
    if (this.nav === undefined) this.nav = { prefix: this.input.value(), index: undefined };
    const recalled = this.history.navigate(this.nav, step);
    if (recalled !== undefined) this.input.reset(recalled);
    return true;
  }
}

export type CommandOptions = {
  runNormalKeys?: (keys: readonly string[], range: LineRange | undefined) => void;
  /** Register access for `:pu[t]`. */
  registers?: Registers;
  exOptions?: { gdefault: boolean };
  /** Resolves `'x` mark addresses (`:'<,'>s/...`) to a row. */
  markLine?: (name: string) => number | undefined;
  /** Vim's shared "last search pattern" (`:h quote/`): an empty `:g`/`:s`
      pattern reuses it, and explicit patterns set it (even when nothing
      matches), so a later `n` follows the ex-command's pattern. */
  lastSearchPattern?: {
    read(): string | undefined;
    write(pattern: string): void;
  };
  /** Ex-command feedback for the host status bar: Vim's `:h 'report'`-gated
      messages ("3 fewer lines", "4 substitutions on 3 lines", "5 lines
      yanked") and errors (E486 "Pattern not found", E35). */
  report?: (report: CommandStatusReport) => void;
};

export type CommandStatusReport = { kind: "info" | "error"; message: string };

// Vim `:h 'report'` (default 2): line-change messages appear only when more
// lines than this are affected.
const reportedLinesThreshold = 2;

// Vim `do_sub` keeps running totals that the root command flushes once, so
// `:g/a/s/b/c/` reports a single aggregated message (Neovim: "3 substitutions
// on 3 lines"), and a substitute that never matched reports E486.
let substitutionTally:
  | { pattern: string; substitutions: number; lines: number; countOnly: boolean; suppressNotFound: boolean }
  | undefined;

function reportError(options: CommandOptions, message: string): void {
  if (!executingGlobalCommand) options.report?.({ kind: "error", message });
}

function reportInfo(options: CommandOptions, message: string): void {
  if (!executingGlobalCommand) options.report?.({ kind: "info", message });
}

function countText(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// The one outcome message of a root ex command (Neovim-pinned): substitution
// totals win over the buffer line delta (`:h 'report'` gates both).
function reportCommandOutcome(editor: VimEditorCapabilities, options: CommandOptions, linesBefore: number): void {
  const report = options.report;
  if (report === undefined) return;
  const tally = substitutionTally;
  if (tally !== undefined) {
    if (tally.substitutions === 0) {
      if (!tally.suppressNotFound) report({ kind: "error", message: `Pattern not found: ${tally.pattern}` });
    } else if (tally.countOnly) {
      report({
        kind: "info",
        message: `${countText(tally.substitutions, "match", "matches")} on ${countText(tally.lines, "line", "lines")}`,
      });
    } else if (tally.substitutions > reportedLinesThreshold) {
      report({
        kind: "info",
        message: `${tally.substitutions} substitutions on ${countText(tally.lines, "line", "lines")}`,
      });
    }
    return;
  }
  const delta = editor.lineCount() - linesBefore;
  if (delta > reportedLinesThreshold) report({ kind: "info", message: `${delta} more lines` });
  else if (-delta > reportedLinesThreshold) report({ kind: "info", message: `${-delta} fewer lines` });
}

type VimCommandAbbreviation = readonly [required: string, optional: string];

type SimpleCommandContext = {
  editor: VimEditorCapabilities;
  range: LineRange | undefined;
};

type SimpleCommandSpec = {
  name: VimCommandAbbreviation;
  run: (context: SimpleCommandContext) => void;
  bang?: (context: SimpleCommandContext) => void;
};

type ParsedSimpleCommand = {
  name: string;
  bang: boolean;
};

// Zed's command registry encodes Vim abbreviations as a required prefix plus
// optional suffix, e.g. [("q", "uit")] accepts [:q], [:qu], [:qui], and [:quit].
const simpleCommands: readonly SimpleCommandSpec[] = [
  {
    name: ["noh", "lsearch"],
    run: ({ editor }) => editor.clearSearchHighlights(),
  },
  {
    name: ["w", "rite"],
    // Background: a save with slow participants (format-on-save, remote FS)
    // must not freeze typing; Vim state reconciles when the save resolves.
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.files.save", [], { backgroundSync: true }),
  },
  {
    name: ["q", "uit"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.closeActiveEditor"),
    bang: ({ editor }) => editor.executeNativeCommand("workbench.action.revertAndCloseActiveEditor"),
  },
  {
    name: ["qa", "ll"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.closeAllEditors"),
    bang: ({ editor }) => editor.executeNativeCommand("workbench.action.closeAllEditors"),
  },
  {
    name: ["quita", "ll"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.closeAllEditors"),
    bang: ({ editor }) => editor.executeNativeCommand("workbench.action.closeAllEditors"),
  },
  {
    name: ["wq", ""],
    run: ({ editor }) => saveAndClose(editor),
    bang: ({ editor }) => saveAndClose(editor),
  },
  {
    name: ["x", "it"],
    run: ({ editor }) => saveAndClose(editor),
    bang: ({ editor }) => saveAndClose(editor),
  },
  {
    name: ["wa", "ll"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.files.saveAll"),
  },
  {
    name: ["wqa", "ll"],
    run: ({ editor }) => saveAllAndClose(editor),
    bang: ({ editor }) => saveAllAndClose(editor),
  },
  {
    name: ["xa", "ll"],
    run: ({ editor }) => saveAllAndClose(editor),
    bang: ({ editor }) => saveAllAndClose(editor),
  },
  {
    name: ["e", "dit"],
    run: () => {},
    bang: ({ editor }) => editor.executeNativeCommand("workbench.action.files.revert"),
  },
  {
    name: ["ex", ""],
    run: () => {},
    bang: ({ editor }) => editor.executeNativeCommand("workbench.action.files.revert"),
  },
  {
    name: ["ene", "w"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.files.newUntitledFile"),
    bang: ({ editor }) => editor.executeNativeCommand("workbench.action.files.newUntitledFile"),
  },
  {
    name: ["clo", "se"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.closeActiveEditor"),
    bang: ({ editor }) => editor.executeNativeCommand("workbench.action.revertAndCloseActiveEditor"),
  },
  {
    name: ["on", "ly"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.maximizeEditor"),
  },
  {
    name: ["ter", "minal"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.createTerminalEditor"),
  },
  {
    name: ["ccl", "ose"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.closePanel"),
  },
  {
    name: ["lcl", "ose"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.closePanel"),
  },
  {
    name: ["cope", "n"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.panel.markers.view.focus"),
  },
  {
    name: ["cw", "indow"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.panel.markers.view.focus"),
  },
  {
    name: ["lope", "n"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.focusCommentsPanel"),
  },
  {
    name: ["lw", "indow"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.focusCommentsPanel"),
  },
  {
    name: ["cn", "ext"],
    run: ({ editor }) => editor.executeNativeCommand("editor.action.marker.nextInFiles"),
  },
  {
    name: ["cnf", "ile"],
    run: ({ editor }) => editor.executeNativeCommand("editor.action.marker.nextInFiles"),
  },
  {
    name: ["cp", "revious"],
    run: ({ editor }) => editor.executeNativeCommand("editor.action.marker.prevInFiles"),
  },
  {
    name: ["cpf", "ile"],
    run: ({ editor }) => editor.executeNativeCommand("editor.action.marker.prevInFiles"),
  },
  {
    name: ["lne", "xt"],
    run: ({ editor }) => editor.executeNativeCommand("editor.action.nextCommentThreadAction"),
  },
  {
    name: ["lp", "revious"],
    run: ({ editor }) => editor.executeNativeCommand("editor.action.previousCommentThreadAction"),
  },
  {
    name: ["ls", ""],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.quickOpenLeastRecentlyUsedEditorInGroup"),
  },
  {
    name: ["u", "ndo"],
    run: ({ editor }) => editor.executeHostCommand("undo"),
  },
  {
    name: ["red", "o"],
    run: ({ editor }) => editor.executeHostCommand("redo"),
  },
  {
    name: ["sp", "lit"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.splitEditorOrthogonal"),
  },
  {
    name: ["vs", "plit"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.splitEditor"),
  },
  {
    name: ["new", ""],
    run: ({ editor }) => newSplit(editor, "workbench.action.splitEditorOrthogonal"),
  },
  {
    name: ["vne", "w"],
    run: ({ editor }) => newSplit(editor, "workbench.action.splitEditor"),
  },
  {
    name: ["bn", "ext"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.nextEditorInGroup"),
  },
  {
    name: ["bN", "ext"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.previousEditorInGroup"),
  },
  {
    name: ["bp", "revious"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.previousEditorInGroup"),
  },
  {
    name: ["bf", "irst"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.firstEditorInGroup"),
  },
  {
    name: ["br", "ewind"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.firstEditorInGroup"),
  },
  {
    name: ["bl", "ast"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.lastEditorInGroup"),
  },
  {
    name: ["tabn", "ext"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.nextEditorInGroup"),
  },
  {
    name: ["tabN", "ext"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.previousEditorInGroup"),
  },
  {
    name: ["tabp", "revious"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.previousEditorInGroup"),
  },
  {
    name: ["tabfir", "st"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.firstEditorInGroup"),
  },
  {
    name: ["tabr", "ewind"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.firstEditorInGroup"),
  },
  {
    name: ["tabl", "ast"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.lastEditorInGroup"),
  },
  {
    name: ["tabnew", ""],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.files.newUntitledFile"),
  },
  {
    name: ["tabe", "dit"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.files.newUntitledFile"),
  },
  {
    name: ["tabc", "lose"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.closeActiveEditor"),
    bang: ({ editor }) => editor.executeNativeCommand("workbench.action.revertAndCloseActiveEditor"),
  },
  {
    name: ["tabo", "nly"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.closeOtherEditors"),
  },
  {
    name: ["bd", "elete"],
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.closeActiveEditor"),
    bang: ({ editor }) => editor.executeNativeCommand("workbench.action.revertAndCloseActiveEditor"),
  },
  {
    name: ["j", "oin"],
    run: ({ editor, range }) => joinRange(editor, range ?? currentLineRange(editor, 2)),
  },
  {
    name: ["sor", "t"],
    run: ({ editor, range }) => sortRange(editor, range ?? wholeBufferRange(editor)),
  },
];

// `:wq`/`:x`: the close must wait for the save to *complete* — fired
// back-to-back the close races the in-flight save, and VSCode still sees a
// dirty editor and asks for confirmation.
function saveAndClose(editor: VimEditorCapabilities): void {
  editor.executeNativeCommand("workbench.action.files.save", [], {
    onResolved: () => editor.executeNativeCommand("workbench.action.closeActiveEditor"),
  });
}

function saveAllAndClose(editor: VimEditorCapabilities): void {
  editor.executeNativeCommand("workbench.action.files.saveAll", [], {
    onResolved: () => editor.executeNativeCommand("workbench.action.closeAllEditors"),
  });
}

function newSplit(editor: VimEditorCapabilities, splitCommand: string): void {
  editor.executeNativeCommand(splitCommand, [], {
    // The untitled file must open in the group the split just created.
    onResolved: () => editor.executeNativeCommand("workbench.action.files.newUntitledFile"),
  });
}

export function commandRunsNormalKeys(command: string): boolean {
  return /^norm(?:al)?!?(\s|$)/.test(command)
    || /^[gv].*\bnorm(?:al)?!?(\s|$)/.test(command);
}

export function commandRegisterToRead(
  editor: VimEditorCapabilities,
  rawCommand: string,
  options: CommandOptions = {}
): { registerName: RegisterName | undefined } | undefined {
  const command = rawCommand.trimStart();
  if (command.length === 0) return undefined;
  const { rest } = parseRange(editor, command, options);
  const trimmedRest = rest.trim();
  const put = parsePut(trimmedRest);
  if (put !== undefined) {
    return { registerName: put.registerKey === undefined ? undefined : parseRegisterName(put.registerKey) };
  }
  // A `:g` sub-command may itself read a register (`:g/x/pu`).
  const matching = parseMatchingLines(trimmedRest);
  if (matching !== undefined && matching.command.length > 0) {
    return commandRegisterToRead(editor, matching.command, options);
  }
  // `:normal` and `:global ... normal` re-enter the key pipeline and may read
  // any clipboard-backed register. Refresh once for the root Ex command; the
  // transaction then supplies that snapshot to all nested keys.
  if (commandRunsNormalKeys(trimmedRest)) return { registerName: "+" };
  return undefined;
}

export function executeCommand(editor: VimEditorCapabilities, rawCommand: string, options: CommandOptions = {}): void {
  // A `:g` sub-command execution: substitution tallies and the outcome
  // message belong to the root command.
  if (executingGlobalCommand) {
    executeCommandCore(editor, rawCommand, options);
    return;
  }
  substitutionTally = undefined;
  const linesBefore = editor.lineCount();
  try {
    executeCommandCore(editor, rawCommand, options);
  } finally {
    reportCommandOutcome(editor, options, linesBefore);
    substitutionTally = undefined;
  }
}

function executeCommandCore(editor: VimEditorCapabilities, rawCommand: string, options: CommandOptions): void {
  const command = rawCommand.trimStart();
  if (command.length === 0) return;

  if (command.startsWith("/") || command.startsWith("?")) {
    commandSearch(editor, command);
    return;
  }

  const gotoLine = parseGotoLine(command);
  if (gotoLine !== undefined) {
    moveToLine(editor, gotoLine - 1);
    return;
  }

  const { range, rawEndRow, rest } = parseRange(editor, command, options);
  const trimmedRest = rest.trim();
  if (trimmedRest.length === 0) {
    if (range !== undefined) moveToLine(editor, range.endRowInclusive);
    return;
  }

  const vscodeCommand = parseVSCodeCommand(trimmedRest);
  if (vscodeCommand !== undefined) {
    editor.executeNativeCommand(vscodeCommand);
    return;
  }

  if (dispatchSimpleCommand({ editor, range }, trimmedRest)) return;

  // `:b[uffer][!] {N|#|name}`: switch tabs in the active editor group.
  const buffer = parseBufferCommand(trimmedRest);
  if (buffer !== undefined) {
    runBufferCommand(editor, buffer.argument, options);
    return;
  }

  // `:[range]d[elete] [reg] [count]` / `:[range]y[ank] [reg] [count]`.
  const deleteYank = parseDeleteYank(trimmedRest);
  if (deleteYank !== undefined) {
    runDeleteYank(editor, range, deleteYank, options);
    return;
  }

  // `:[range]>[>...] [count]` / `:[range]<[<...] [count]`.
  const indent = parseIndentCommand(trimmedRest);
  if (indent !== undefined) {
    indentLines(editor, range, indent, options);
    return;
  }

  // `:[range]m {addr}` / `:[range]t {addr}` (`:co`): move/copy lines to after
  // the destination address (`0` = above the first line).
  const moveCopy = parseMoveCopy(trimmedRest);
  if (moveCopy !== undefined) {
    const destination = parseAddress(editor, moveCopy.addressText, 0, options);
    if (destination !== undefined && destination.nextIndex === moveCopy.addressText.length) {
      moveCopyLines(editor, range ?? currentLineRange(editor, 1), destination.row, moveCopy.kind);
    }
    return;
  }

  // `:[line]pu[t] [!] [reg]`: put a register linewise below [line] (above with
  // `!`); `:0pu` puts above the first line.
  const put = parsePut(trimmedRest);
  if (put !== undefined) {
    putLines(editor, rawEndRow ?? selectionHead(editor.getSelections()[0]).row, put, options);
    return;
  }

  const setOption = parseSetCommand(trimmedRest);
  if (setOption !== undefined) {
    if (options.exOptions !== undefined && (setOption.name === "gdefault" || setOption.name === "gd")) {
      options.exOptions.gdefault = setOption.value;
    }
    return;
  }

  if (trimmedRest.startsWith("g") || trimmedRest.startsWith("v")) {
    matchingLines(editor, range ?? wholeBufferRange(editor), trimmedRest, options);
    return;
  }

  if (trimmedRest.startsWith("norm")) {
    normalCommand(editor, range, rest.trimStart(), options);
    return;
  }

  if (trimmedRest.startsWith("s")) {
    substitute(editor, range ?? currentLineRange(editor, 1), trimmedRest, options);
  }
}

// VSCodeVim `:vsc[ode]`: run a VSCode command by id.
function parseVSCodeCommand(command: string): string | undefined {
  const match = /^(\S+)\s+(.+)$/.exec(command);
  if (match === null) return undefined;
  const [, name, commandId] = match;
  return matchesVimCommandAbbreviation(name, ["vsc", "ode"]) ? commandId.trim() : undefined;
}

// Vim `:h :set`: the tiny subset of boolean options the core understands.
function parseSetCommand(command: string): { name: string; value: boolean } | undefined {
  const match = /^se(?:t)?\s+(no)?([a-z]+)$/.exec(command);
  if (match === null) return undefined;
  return { name: match[2], value: match[1] === undefined };
}

export type LineRange = { startRow: number; endRowInclusive: number };

function dispatchSimpleCommand(context: SimpleCommandContext, command: string): boolean {
  const parsed = parseSimpleCommand(command);
  const spec = simpleCommands.find(spec => matchesVimCommandAbbreviation(parsed.name, spec.name));
  if (spec === undefined) return false;
  if (parsed.bang) {
    if (spec.bang === undefined) return false;
    spec.bang(context);
    return true;
  }
  spec.run(context);
  return true;
}

function parseSimpleCommand(command: string): ParsedSimpleCommand {
  return command.endsWith("!")
    ? { name: command.slice(0, -1), bang: true }
    : { name: command, bang: false };
}

function matchesVimCommandAbbreviation(command: string, [required, optional]: VimCommandAbbreviation): boolean {
  const fullName = `${required}${optional}`;
  return command.length >= required.length
    && command.length <= fullName.length
    && command.startsWith(required)
    && fullName.startsWith(command);
}

// Vim `:h :buffer`: `:b[uffer][!] {N|#|name}`. Buffer numbers map to tab
// positions in the active editor group (`:b1` is the first tab, like Vim
// buffer numbers in a freshly opened session), `#` is the alternate (most
// recently used) tab, and a name argument opens quick-open prefiltered by the
// name — the core has no tab list to match a name against directly. The bang
// is accepted and ignored: switching tabs never abandons changes in VSCode.
// The digits must be attached or space-separated (`:b1`, `:b 1`) but a name
// needs the space (`:bnext` is `:bn`, not `:b next`), which the command-word
// split below gets right because the word is greedy over letters.
function parseBufferCommand(command: string): { argument: string } | undefined {
  const match = /^([a-zA-Z]+)!?\s*(.*)$/.exec(command);
  if (match === null) return undefined;
  const [, name, argument] = match;
  if (!matchesVimCommandAbbreviation(name, ["b", "uffer"])) return undefined;
  return { argument: argument.trim() };
}

function runBufferCommand(editor: VimEditorCapabilities, argument: string, options: CommandOptions): void {
  // Vim: `:b` without an argument re-edits the current buffer.
  if (argument.length === 0) return;
  if (argument === "#") {
    editor.executeNativeCommand("workbench.action.openPreviousRecentlyUsedEditorInGroup");
    return;
  }
  if (/^\d+$/.test(argument)) {
    const bufferNumber = Number.parseInt(argument, 10);
    if (bufferNumber === 0) {
      reportError(options, "E939: Positive count required");
      return;
    }
    // 0-based tab index within the active group; out-of-range indexes are a
    // no-op in the VSCode handler (Vim's E86 needs the tab list to detect).
    editor.executeNativeCommand("workbench.action.openEditorAtIndex", [bufferNumber - 1]);
    return;
  }
  editor.executeNativeCommand("workbench.action.quickOpen", [argument]);
}

function commandSearch(editor: VimEditorCapabilities, command: string): void {
  const backwards = command.startsWith("?");
  const query = command.slice(1);
  if (query.length === 0) return;
  const start = selectionHead(editor.getSelections()[0]);
  const found = backwards ? searchBackward(editor, start, query) : searchForward(editor, start, query);
  if (found !== undefined) editor.setSelections([charwiseSelection(found)]);
}

function parseMoveCopy(command: string): { kind: "move" | "copy"; addressText: string } | undefined {
  const match = /^(move|mov|mo|m|copy|cop|co|t)(\s*)(.+)$/.exec(command);
  if (match === null) return undefined;
  return {
    kind: match[1] === "t" || match[1].startsWith("c") ? "copy" : "move",
    addressText: match[3].trim(),
  };
}

function moveCopyLines(
  editor: VimEditorCapabilities,
  range: LineRange,
  destinationRow: number,
  kind: "move" | "copy"
): void {
  const lines: string[] = [];
  for (let row = range.startRow; row <= range.endRowInclusive; row++) lines.push(editor.line(row));
  const count = lines.length;

  // Vim E134: cannot move lines into themselves.
  if (kind === "move" && destinationRow >= range.startRow - 1 && destinationRow <= range.endRowInclusive) return;

  const edits: TextEdit[] = [];
  if (kind === "move") edits.push({ range: rangeToFullLines(editor, range), text: "" });
  edits.push(lineInsertionEdit(editor, destinationRow, lines));

  // Vim: the cursor lands on the last moved/copied line, first non-blank.
  const cursorRow =
    kind === "copy" || destinationRow > range.endRowInclusive ? destinationRow + (kind === "copy" ? count : 0) : destinationRow + count;
  editor.applyEdits(edits, [
    charwiseSelection({ row: cursorRow, column: firstNonWhitespace(lines[lines.length - 1] ?? "") }),
  ]);
}

// An edit inserting [lines] after [afterRow] (-1 = above the first line),
// expressed in pre-edit coordinates.
function lineInsertionEdit(editor: VimEditorCapabilities, afterRow: number, lines: readonly string[]): TextEdit {
  const lastRow = editor.lineCount() - 1;
  if (afterRow >= lastRow) {
    const at = { row: lastRow, column: editor.lineLength(lastRow) };
    return { range: { start: at, end: at }, text: `\n${lines.join("\n")}` };
  }
  const at = { row: Math.max(0, afterRow + 1), column: 0 };
  return { range: { start: at, end: at }, text: `${lines.join("\n")}\n` };
}

function parsePut(command: string): { before: boolean; registerKey: string | undefined } | undefined {
  const match = /^pu(?:t)?(!)?(?:\s+(\S))?$/.exec(command);
  if (match === null) return undefined;
  return { before: match[1] === "!", registerKey: match[2] };
}

function putLines(
  editor: VimEditorCapabilities,
  addressedRow: number,
  { before, registerKey }: { before: boolean; registerKey: string | undefined },
  options: CommandOptions
): void {
  const registers = options.registers;
  if (registers === undefined) return;
  const content = registers.readContent(registerKey === undefined ? undefined : parseRegisterName(registerKey));
  if (content.text.length === 0) return;
  const text = content.text.endsWith("\n") ? content.text.slice(0, -1) : content.text;
  const lines = text.split("\n");
  // `:pu` inserts below the addressed line, `:pu!` above it; `:0pu` addresses
  // the row above line 1.
  const afterRow = before ? addressedRow - 1 : addressedRow;
  const edit = lineInsertionEdit(editor, afterRow, lines);
  const lastRow = editor.lineCount() - 1;
  const firstInsertedRow = afterRow >= lastRow ? lastRow + 1 : Math.max(0, afterRow + 1);
  editor.applyEdits([edit], [
    charwiseSelection({
      row: firstInsertedRow + lines.length - 1,
      column: firstNonWhitespace(lines[lines.length - 1] ?? ""),
    }),
  ]);
}

function parseGotoLine(command: string): number | undefined {
  return /^\d+$/.test(command) ? Number(command) : undefined;
}

function parseRange(editor: VimEditorCapabilities, command: string, options: CommandOptions): { range: LineRange | undefined; rawEndRow?: number; rest: string } {
  if (command.startsWith("%") && command.length > 1 && command[1] !== "+" && command[1] !== "-" && command[1] !== "," && command[1] !== ";") {
    return { range: wholeBufferRange(editor), rawEndRow: editor.lineCount() - 1, rest: command.slice(1) };
  }

  const first = parseAddress(editor, command, 0, options);
  if (first === undefined) return { range: undefined, rest: command };

  let nextIndex = first.nextIndex;
  let endRow = first.row;
  if (command[nextIndex] === "," || command[nextIndex] === ";") {
    const second = parseAddress(editor, command, nextIndex + 1, options);
    if (second !== undefined) {
      endRow = second.row;
      nextIndex = second.nextIndex;
    }
  }

  return {
    range: normalizeLineRange(editor, first.row, endRow),
    // The unclipped end row: `:0pu` addresses the row *above* line 1, which
    // the normalized range cannot represent.
    rawEndRow: endRow,
    rest: command.slice(nextIndex),
  };
}

function parseAddress(editor: VimEditorCapabilities, command: string, startIndex: number, options: CommandOptions): { row: number; nextIndex: number } | undefined {
  let index = startIndex;
  let row: number;
  if (command[index] === "%") {
    row = editor.lineCount() - 1;
    index++;
  } else if (command[index] === ".") {
    row = selectionHead(editor.getSelections()[0]).row;
    index++;
  } else if (command[index] === "$") {
    row = editor.lineCount() - 1;
    index++;
  } else if (command[index] === "'" && command[index + 1] !== undefined) {
    // Vim `:h :range`: `'x` addresses the line holding mark x (`:'<,'>`).
    const markRow = options.markLine?.(command[index + 1]);
    if (markRow === undefined) return undefined;
    row = markRow;
    index += 2;
  } else {
    const match = /^\d+/.exec(command.slice(index));
    if (match !== null) {
      row = Number(match[0]) - 1;
      index += match[0].length;
    } else if (command[index] === "+" || command[index] === "-") {
      row = selectionHead(editor.getSelections()[0]).row;
    } else {
      return undefined;
    }
  }

  while (command[index] === "+" || command[index] === "-") {
    const sign = command[index] === "+" ? 1 : -1;
    index++;
    const match = /^\d+/.exec(command.slice(index));
    const offset = match === null ? 1 : Number(match[0]);
    if (match !== null) index += match[0].length;
    row += sign * offset;
  }

  return { row, nextIndex: index };
}

function currentLineRange(editor: VimEditorCapabilities, count: number): LineRange {
  const row = selectionHead(editor.getSelections()[0]).row;
  return normalizeLineRange(editor, row, row + count - 1);
}

function wholeBufferRange(editor: VimEditorCapabilities): LineRange {
  return { startRow: 0, endRowInclusive: Math.max(0, editor.lineCount() - 1) };
}

function normalizeLineRange(editor: VimEditorCapabilities, startRow: number, endRow: number): LineRange {
  const clippedStart = Math.max(0, Math.min(startRow, editor.lineCount() - 1));
  const clippedEnd = Math.max(0, Math.min(endRow, editor.lineCount() - 1));
  return {
    startRow: Math.min(clippedStart, clippedEnd),
    endRowInclusive: Math.max(clippedStart, clippedEnd),
  };
}

function moveToLine(editor: VimEditorCapabilities, row: number): void {
  const targetRow = Math.max(0, Math.min(row, editor.lineCount() - 1));
  editor.setSelections([charwiseSelection({ row: targetRow, column: firstNonWhitespace(editor.line(targetRow)) })]);
}

function joinRange(editor: VimEditorCapabilities, range: LineRange): void {
  const endRow = Math.min(range.endRowInclusive, editor.lineCount() - 1);
  if (endRow <= range.startRow) return;
  const lines: string[] = [];
  for (let row = range.startRow; row <= endRow; row++) lines.push(editor.line(row).trim());
  const text = lines.join(" ") + trailingNewlineForRange(editor, { startRow: range.startRow, endRowInclusive: endRow });
  const editRange = rangeToFullLines(editor, { startRow: range.startRow, endRowInclusive: endRow });
  editor.applyEdits([{ range: editRange, text }], [charwiseSelection({ row: range.startRow, column: 0 })]);
}

type DeleteYankCommand = {
  kind: "delete" | "yank";
  registerKey: string | undefined;
  count: number | undefined;
};

// Vim `:h :d` / `:h :y`: `[reg]` is a single register name and `[count]`
// (all-digit token) addresses [count] lines starting at the range's last line.
function parseDeleteYank(command: string): DeleteYankCommand | undefined {
  const match = /^([a-z]+)((?:\s+\S+)*)$/.exec(command);
  if (match === null) return undefined;
  const [, name, argsText] = match;
  let kind: "delete" | "yank";
  if (matchesVimCommandAbbreviation(name, ["d", "elete"])) kind = "delete";
  else if (matchesVimCommandAbbreviation(name, ["y", "ank"])) kind = "yank";
  else return undefined;
  let registerKey: string | undefined;
  let count: number | undefined;
  for (const arg of argsText.split(/\s+/).filter(arg => arg.length > 0)) {
    if (/^\d+$/.test(arg) && count === undefined) count = Number(arg);
    else if (arg.length === 1 && registerKey === undefined && count === undefined) registerKey = arg;
    else return undefined;
  }
  return { kind, registerKey, count };
}

function runDeleteYank(
  editor: VimEditorCapabilities,
  range: LineRange | undefined,
  { kind, registerKey, count }: DeleteYankCommand,
  options: CommandOptions
): void {
  const base = range ?? currentLineRange(editor, 1);
  const target = count === undefined
    ? base
    : normalizeLineRange(editor, base.endRowInclusive, base.endRowInclusive + count - 1);
  const registerName = registerKey === undefined ? undefined : parseRegisterName(registerKey);
  if (registerKey !== undefined && registerName === undefined) return;
  const lines: string[] = [];
  for (let row = target.startRow; row <= target.endRowInclusive; row++) lines.push(editor.line(row));
  const text = lines.join("\n") + "\n";
  if (kind === "yank") {
    // The cursor does not move.
    options.registers?.writeYank(registerName, text, "linewise");
    if (lines.length > reportedLinesThreshold) {
      reportInfo(options, `${lines.length} lines yanked`);
    }
    return;
  }
  options.registers?.writeDelete(registerName, text, "linewise");
  deleteRange(editor, target);
}

// Vim `:h :>`: shift the range right (left for `<`) once per repeated
// character; the cursor lands on the last line's first non-blank.
function parseIndentCommand(command: string): { direction: "in" | "out"; repetitions: number; count: number | undefined } | undefined {
  const match = /^(>+|<+)(?:\s+(\d+))?$/.exec(command);
  if (match === null) return undefined;
  return {
    direction: match[1][0] === ">" ? "in" : "out",
    repetitions: match[1].length,
    count: match[2] === undefined ? undefined : Number(match[2]),
  };
}

function indentLines(
  editor: VimEditorCapabilities,
  range: LineRange | undefined,
  { direction, repetitions, count }: { direction: "in" | "out"; repetitions: number; count: number | undefined },
  _options: CommandOptions
): void {
  const base = range ?? currentLineRange(editor, 1);
  const target = count === undefined
    ? base
    : normalizeLineRange(editor, base.endRowInclusive, base.endRowInclusive + count - 1);
  indentRanges(
    editor,
    [{
      start: { row: target.startRow, column: 0 },
      end: { row: target.endRowInclusive, column: editor.lineLength(target.endRowInclusive) },
    }],
    direction,
    repetitions
  );
  const lastRow = target.endRowInclusive;
  editor.setSelections([charwiseSelection({ row: lastRow, column: firstNonWhitespace(editor.line(lastRow)) })]);
}

function deleteRange(editor: VimEditorCapabilities, range: LineRange): void {
  const editRange = rangeToFullLines(editor, range);
  const nextRow = range.endRowInclusive + 1 < editor.lineCount()
    ? range.startRow
    : Math.max(0, range.startRow - 1);
  editor.applyEdits([{ range: editRange, text: "" }], [charwiseSelection({ row: nextRow, column: 0 })]);
}

function sortRange(editor: VimEditorCapabilities, range: LineRange): void {
  const lines: string[] = [];
  for (let row = range.startRow; row <= range.endRowInclusive; row++) lines.push(editor.line(row));
  lines.sort();
  editor.applyEdits(
    [{ range: rangeToFullLines(editor, range), text: lines.join("\n") + trailingNewlineForRange(editor, range) }],
    [charwiseSelection({ row: range.startRow, column: 0 })]
  );
}

// Vim `global_busy`: a nested `:g` — whether in the sub-command or reached
// through `:g/pat/normal` re-entering the command line — is not executed.
let executingGlobalCommand = false;

function matchingLines(editor: VimEditorCapabilities, range: LineRange, command: string, options: CommandOptions): void {
  if (executingGlobalCommand) return;
  const parsed = parseMatchingLines(command);
  if (parsed === undefined) return;
  // Vim: `:g//` reuses the last search pattern (E35 without one), and an
  // explicit pattern becomes the last search pattern even before matching.
  const pattern = parsed.pattern.length > 0 ? parsed.pattern : options.lastSearchPattern?.read();
  if (pattern === undefined || pattern.length === 0) {
    reportError(options, "No previous regular expression");
    return;
  }
  if (parsed.pattern.length > 0) options.lastSearchPattern?.write(parsed.pattern);
  const translated = translateVimRegex(pattern);
  const regexp = new RegExp(translated.source, translated.forceCase === "ignore" ? "i" : "");
  const rows: number[] = [];
  for (let row = range.startRow; row <= range.endRowInclusive; row++) {
    if (regexp.test(editor.line(row)) !== parsed.invert) rows.push(row);
  }
  if (rows.length === 0) {
    reportError(options, `Pattern not found: ${pattern}`);
    return;
  }

  // Vim's default sub-command is `:p`: no edits, and the cursor lands on the
  // last matched line.
  if (parsed.command.length === 0) {
    moveToLine(editor, rows[rows.length - 1]);
    return;
  }

  // A `:d[elete] [reg]` tail batches into one edit instead of a per-mark
  // pass. The registers still see one delete per mark in order, like Vim
  // (`:g/a/d` leaves the last match in `"1`, earlier ones in `"2`…; an
  // uppercase register accumulates).
  const deleteTail = parseDeleteYank(parsed.command);
  if (deleteTail !== undefined && deleteTail.kind === "delete" && deleteTail.count === undefined) {
    const registerName = deleteTail.registerKey === undefined ? undefined : parseRegisterName(deleteTail.registerKey);
    if (deleteTail.registerKey !== undefined && registerName === undefined) return;
    for (const row of rows) {
      options.registers?.writeDelete(registerName, editor.line(row) + "\n", "linewise");
    }
    deleteMatchingRows(editor, rows);
    return;
  }

  executingGlobalCommand = true;
  try {
    // Vim `:g/pat/normal {keys}`: run the normal command on every matched
    // line. The matched rows are marks that track earlier iterations' edits.
    if (/^norm(?:al)?!?(\s|$)/.test(parsed.command)) {
      runNormalKeysOnRows(editor, rows, normalCommandKeysText(parsed.command), options, { trackRows: true });
      return;
    }
    // Pass 2 for every other sub-command: execute it as a full ex command per
    // marked line with the cursor on the mark, so the default range is that
    // line and `.`-relative addresses resolve per match (`:g/x/.,+1d`).
    runOnRows(editor, rows, { trackRows: true }, row => {
      editor.setSelections([charwiseSelection({ row, column: 0 })]);
      executeCommand(editor, parsed.command, options);
    });
  } finally {
    executingGlobalCommand = false;
  }
}

// Vim `:h :global`: `:g[lobal]/pat/cmd` (`:g!` inverts) and `:v[global]`
// (inverted, no `!` allowed — E477). The delimiter may be any character except
// alphanumerics, whitespace, `\`, `"`, `|` and `!`.
function parseMatchingLines(command: string): { invert: boolean; pattern: string; command: string } | undefined {
  const nameMatch = /^([a-z]+)(!?)/.exec(command);
  if (nameMatch === null) return undefined;
  const [full, name, bang] = nameMatch;
  let invert: boolean;
  if (matchesVimCommandAbbreviation(name, ["g", "lobal"])) {
    invert = bang === "!";
  } else if (matchesVimCommandAbbreviation(name, ["v", "global"])) {
    if (bang === "!") return undefined;
    invert = true;
  } else {
    return undefined;
  }
  const rest = command.slice(full.length);
  const delimiter = rest[0];
  if (delimiter === undefined || /[A-Za-z0-9\s\\"|!]/.test(delimiter)) return undefined;
  // The pattern may be unterminated: `:g/pat` runs the default sub-command.
  const pattern = readUntilDelimiter(rest, delimiter, 1, { requireDelimiter: false });
  if (pattern === undefined) return undefined;
  return { invert, pattern: pattern.value, command: rest.slice(pattern.nextIndex).trim() };
}

function deleteMatchingRows(editor: VimEditorCapabilities, rows: readonly number[]): void {
  const edits: TextEdit[] = [];
  for (const row of [...rows].sort((a, b) => b - a)) {
    edits.push({ range: rangeToFullLines(editor, { startRow: row, endRowInclusive: row }), text: "" });
  }
  const lastDeletedRow = rows[rows.length - 1] ?? 0;
  const nextRow = Math.min(
    Math.max(0, lastDeletedRow - rows.length + 1),
    Math.max(0, editor.lineCount() - rows.length - 1)
  );
  if (edits.length > 0) editor.applyEdits(edits, [charwiseSelection({ row: nextRow, column: 0 })]);
}

// Vim `:[range]normal` iterates fixed line numbers (unlike `:g`, which marks
// the lines first): `:1,2norm oX` re-processes an inserted line at row 2.
function normalCommand(editor: VimEditorCapabilities, range: LineRange | undefined, command: string, options: CommandOptions): void {
  const targetRange = range ?? currentLineRange(editor, 1);
  const rows: number[] = [];
  for (let row = targetRange.startRow; row <= targetRange.endRowInclusive; row++) rows.push(row);
  runNormalKeysOnRows(editor, rows, normalCommandKeysText(command), options, { trackRows: false });
}

function normalCommandKeysText(command: string): string {
  return command.replace(/^norm(?:al)?!?\s?/, "");
}

// Vim `:h :normal`: replay the keys with the cursor at the start of each
// line. `I`/`A` prefixes batch into one edit; the general path replays per
// row inside one undo transaction, so either way the whole ranged command is
// a single undo step and undo restores the cursor to the first executed line.
// [trackRows]: `:g` rows are marks that follow edits; `:[range]norm` rows are
// fixed line numbers.
function runNormalKeysOnRows(
  editor: VimEditorCapabilities,
  rows: readonly number[],
  keysText: string,
  options: CommandOptions,
  { trackRows }: { trackRows: boolean }
): void {
  if (rows.length === 0 || keysText.length === 0) return;
  if (keysText.startsWith("I")) {
    prependToRows(editor, rows, keysText.slice(1));
    return;
  }
  if (keysText.startsWith("A")) {
    appendToRows(editor, rows, keysText.slice(1));
    return;
  }
  const keys = keysText.split("").map(key => key === " " ? "space" : key);
  runOnRows(editor, rows, { trackRows }, row => {
    options.runNormalKeys?.(keys, { startRow: row, endRowInclusive: row });
  });
}

// The per-row execution scaffold shared by `:g/pat/{cmd}` and `:[range]norm`:
// one undo step over all rows, with the undo cursor on the first executed
// line. Tracked rows are `:g` marks that follow edits; fixed rows beyond a
// shrunk buffer clamp to the last line (Vim replays `:1,3norm dd` on a 3-line
// buffer down to an empty buffer) — the callee's cursor placement clamps.
function runOnRows(
  editor: VimEditorCapabilities,
  rows: readonly number[],
  { trackRows }: { trackRows: boolean },
  run: (row: number) => void
): void {
  editor.setSelections([charwiseSelection({ row: rows[0], column: 0 })]);
  const transaction = editor.beginUndoTransaction(editor.getSelections());
  const tracked = trackRows ? editor.trackLines(rows) : undefined;
  try {
    for (let index = 0; index < rows.length; index++) {
      const row = tracked === undefined ? rows[index] : tracked.currentRow(index);
      if (row === undefined) continue;
      run(row);
    }
  } finally {
    tracked?.dispose();
    transaction.finish(editor.getSelections());
  }
}

function prependToRows(editor: VimEditorCapabilities, rows: readonly number[], text: string): void {
  if (text.length === 0) return;
  // The first insertion point becomes the undo-state cursor (Vim restores it
  // when the batched command is undone).
  editor.setSelections([charwiseSelection({ row: rows[0], column: 0 })]);
  const edits: TextEdit[] = rows.map(row => ({
    range: { start: { row, column: 0 }, end: { row, column: 0 } },
    text,
  }));
  editor.applyEdits(edits, [charwiseSelection({ row: rows[0], column: Math.max(0, text.length - 1) })]);
}

function appendToRows(editor: VimEditorCapabilities, rows: readonly number[], text: string): void {
  if (text.length === 0) return;
  // The first insertion point becomes the undo-state cursor (Vim restores it
  // when the batched command is undone, clamped to the line's last cell).
  editor.setSelections([charwiseSelection({ row: rows[0], column: editor.lineLength(rows[0]) })]);
  const edits: TextEdit[] = rows.map(row => {
    const column = editor.lineLength(row);
    return { range: { start: { row, column }, end: { row, column } }, text };
  });
  const lastRow = rows[rows.length - 1];
  // Vim: the cursor ends on the last appended character of the last line.
  const cursor = { row: lastRow, column: editor.lineLength(lastRow) + text.length - 1 };
  editor.applyEdits(edits, [charwiseSelection(cursor)]);
}

function substitute(editor: VimEditorCapabilities, range: LineRange, command: string, options: CommandOptions): void {
  const parsed = parseSubstitute(command);
  if (parsed === undefined) return;
  // Vim: `:s//repl/` reuses the last search pattern (E35 without one), and an
  // explicit pattern becomes the last search pattern even when nothing matches.
  const pattern = parsed.pattern.length > 0 ? parsed.pattern : options.lastSearchPattern?.read();
  if (pattern === undefined || pattern.length === 0) {
    reportError(options, "No previous regular expression");
    return;
  }
  if (parsed.pattern.length > 0) options.lastSearchPattern?.write(parsed.pattern);
  const countOnly = parsed.flags.includes("n");

  const global = substituteIsGlobal(parsed.flags, options.exOptions?.gdefault ?? false);
  const translated = translateVimRegex(pattern);
  const flags = translated.forceCase === "ignore" ? "i" : "";
  const regexp = new RegExp(translated.source, `${global ? "g" : ""}${flags}`);
  // The counting walker is always global: without the `g` flag only the first
  // match per line counts.
  const walker = new RegExp(translated.source, `g${flags}`);

  let substitutions = 0;
  let changedLines = 0;
  const edits: TextEdit[] = [];
  for (let row = range.startRow; row <= range.endRowInclusive; row++) {
    const line = editor.line(row);
    const matches = countMatchesInLine(line, walker, global);
    if (matches === 0) continue;
    substitutions += matches;
    changedLines++;
    if (countOnly) continue;
    const replaced = substituteLine(line, regexp, parsed.replacement);
    if (replaced !== line) {
      edits.push({ range: { start: { row, column: 0 }, end: { row, column: editor.lineLength(row) } }, text: replaced });
    }
  }

  // Aggregated across a `:g` run and flushed by the root command
  // ([reportCommandOutcome]): totals, or E486 when nothing ever matched.
  const tally = substitutionTally
    ?? { pattern, substitutions: 0, lines: 0, countOnly, suppressNotFound: false };
  tally.pattern = pattern;
  tally.substitutions += substitutions;
  tally.lines += changedLines;
  tally.countOnly = countOnly;
  tally.suppressNotFound = tally.suppressNotFound || parsed.flags.includes("e");
  substitutionTally = tally;

  if (edits.length > 0) {
    // Vim: the cursor lands on the last substituted line, first non-blank. A
    // `\r` replacement inserts line breaks, so count the rows added by the
    // edits above and within the last edit's own text.
    const lastEdit = edits[edits.length - 1];
    let addedRows = 0;
    for (const edit of edits.slice(0, -1)) addedRows += edit.text.split("\n").length - 1;
    const lastEditLines = lastEdit.text.split("\n");
    const lastLine = lastEditLines[lastEditLines.length - 1];
    editor.applyEdits(edits, [
      charwiseSelection({
        row: lastEdit.range.start.row + addedRows + lastEditLines.length - 1,
        column: firstNonWhitespace(lastLine),
      }),
    ]);
  }
}

export type SubstitutePreview = {
  /** The matched text the substitute would replace. */
  range: TextRange;
  /** The resolved replacement for this match; undefined while the command
      line has no replacement section yet (`:s/foo`) or with the `n`
      (count-only) flag, where only the matches are highlighted. */
  replacement: string | undefined;
};

// Live highlights get expensive on huge files, so the preview is best-effort
// (the substitute itself is unaffected):
// - at most this many matches are decorated — a degenerate pattern like
//   `:%s/./…` would otherwise decorate every character (VSCode's own find
//   widget caps matches the same way, see its MATCHES_LIMIT);
const substitutePreviewCap = 200;
// - at most this much text is scanned per keystroke — a *rare* pattern never
//   hits the match cap, and without a scan budget each prompt key would
//   regex-walk the whole buffer.
const substitutePreviewScanBudgetChars = 1_000_000;

// Live `:s` preview (Neovim 'inccommand', VSCodeVim's substitute preview):
// leniently parse the in-flight `:` line and return the matches the
// substitute would touch, with their resolved replacement texts. Undefined
// when the line is not a substitute command, or its pattern is empty or (still)
// an invalid regex — e.g. half-typed `[` — so the host shows nothing.
export function substitutePreviews(
  editor: VimEditorCapabilities,
  rawCommand: string,
  options: CommandOptions = {}
): readonly SubstitutePreview[] | undefined {
  const command = rawCommand.trimStart();
  if (command.length === 0) return undefined;
  const { range, rest } = parseRange(editor, command, options);
  const trimmedRest = rest.trim();
  if (trimmedRest.startsWith("g") || trimmedRest.startsWith("v")) {
    const matching = parseMatchingLines(trimmedRest);
    if (matching !== undefined) {
      return matchingLinesPreviews(editor, range ?? wholeBufferRange(editor), matching, options);
    }
  }
  const parsed = parseSubstituteLoose(trimmedRest);
  if (parsed === undefined) return undefined;
  // A (still-)empty pattern previews the last search pattern (`:s//repl/`),
  // read-only — only committing the command updates it.
  const pattern = parsed.pattern.length > 0 ? parsed.pattern : options.lastSearchPattern?.read();
  if (pattern === undefined || pattern.length === 0) return undefined;
  const lineRange = range ?? currentLineRange(editor, 1);
  const rows: number[] = [];
  const endRow = Math.min(lineRange.endRowInclusive, editor.lineCount() - 1);
  for (let row = lineRange.startRow; row <= endRow; row++) rows.push(row);
  return substitutePreviewsOnRows(editor, rows, parsed, pattern, options);
}

// The `:s` preview matches on [rows] — the addressed range, or a `:g` tail's
// matched lines.
function substitutePreviewsOnRows(
  editor: VimEditorCapabilities,
  rows: readonly number[],
  parsed: { replacement: string | undefined; flags: string },
  pattern: string,
  options: CommandOptions
): readonly SubstitutePreview[] | undefined {
  let regexp: RegExp;
  try {
    const translated = translateVimRegex(pattern);
    // Always global: the exec loop below walks every match and applies the
    // g-parity itself (first match per line when not global).
    regexp = new RegExp(translated.source, `g${translated.forceCase === "ignore" ? "i" : ""}`);
  } catch {
    return undefined;
  }
  const global = substituteIsGlobal(parsed.flags, options.exOptions?.gdefault ?? false);
  const countOnly = parsed.flags.includes("n");

  const previews: SubstitutePreview[] = [];
  let scannedChars = 0;
  for (const row of rows) {
    const line = editor.line(row);
    scannedChars += line.length;
    if (scannedChars > substitutePreviewScanBudgetChars) break;
    regexp.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regexp.exec(line)) !== null) {
      const replacement =
        parsed.replacement === undefined || countOnly
          ? undefined
          : expandReplacement(parsed.replacement, match[0], match.slice(1));
      previews.push({
        range: { start: { row, column: match.index }, end: { row, column: match.index + match[0].length } },
        replacement,
      });
      if (previews.length >= substitutePreviewCap) return previews;
      if (!global) break;
      // A zero-length match (e.g. `x*`) never advances [lastIndex] on its own.
      if (match[0].length === 0) regexp.lastIndex++;
    }
  }
  return previews;
}

// Live `:g` preview: highlight what pass 1 would mark — the match on every
// matching line (`:v`: the whole non-matching line). A substitute tail
// previews its replacements on exactly those lines (an empty tail pattern
// resolves to the `:g` pattern, like the command itself), and a `:d` tail
// previews the deletion of each marked line.
function matchingLinesPreviews(
  editor: VimEditorCapabilities,
  range: LineRange,
  matching: { invert: boolean; pattern: string; command: string },
  options: CommandOptions
): readonly SubstitutePreview[] | undefined {
  const pattern = matching.pattern.length > 0 ? matching.pattern : options.lastSearchPattern?.read();
  if (pattern === undefined || pattern.length === 0) return undefined;
  let regexp: RegExp;
  try {
    const translated = translateVimRegex(pattern);
    regexp = new RegExp(translated.source, translated.forceCase === "ignore" ? "i" : "");
  } catch {
    return undefined;
  }

  const matchedRows: number[] = [];
  const highlights: SubstitutePreview[] = [];
  const deleteTail = parseDeleteYank(matching.command);
  const previewsDeletion = deleteTail !== undefined && deleteTail.kind === "delete" && deleteTail.count === undefined;
  let scannedChars = 0;
  const endRow = Math.min(range.endRowInclusive, editor.lineCount() - 1);
  for (let row = range.startRow; row <= endRow; row++) {
    const line = editor.line(row);
    scannedChars += line.length;
    if (scannedChars > substitutePreviewScanBudgetChars) break;
    const match = regexp.exec(line);
    if ((match !== null) === matching.invert) continue;
    matchedRows.push(row);
    // `:v` marks lines without a match, so the whole line is the highlight.
    const range_ = match !== null && !matching.invert
      ? { start: { row, column: match.index }, end: { row, column: match.index + match[0].length } }
      : { start: { row, column: 0 }, end: { row, column: line.length } };
    highlights.push({
      range: previewsDeletion ? { start: { row, column: 0 }, end: { row, column: line.length } } : range_,
      replacement: previewsDeletion ? "" : undefined,
    });
    if (highlights.length >= substitutePreviewCap) break;
  }

  if (matching.command.startsWith("s")) {
    const subParsed = parseSubstituteLoose(matching.command);
    if (subParsed !== undefined) {
      // The tail's empty pattern means the `:g` pattern (probe-pinned:
      // `:g/foo/s//FOO/`).
      const subPattern = subParsed.pattern.length > 0 ? subParsed.pattern : pattern;
      return substitutePreviewsOnRows(editor, matchedRows, subParsed, subPattern, options);
    }
  }
  return highlights;
}

// Vim `:h gdefault` / `:h :s_g`: every `g` flag toggles whole-line
// replacement; `gdefault` flips the starting state.
function substituteIsGlobal(flags: string, gdefault: boolean): boolean {
  const gParity = [...flags].filter(flag => flag === "g").length % 2 === 1;
  return gdefault ? !gParity : gParity;
}

// The lenient counterpart of [parseSubstitute] for the live preview: the
// pattern may still be unterminated (`:s/foo`), and [replacement] is undefined
// until its section exists (the second delimiter was typed).
function parseSubstituteLoose(command: string): { pattern: string; replacement: string | undefined; flags: string } | undefined {
  if (!command.startsWith("s")) return undefined;
  const delimiter = command[1];
  if (delimiter === undefined || /[A-Za-z0-9\s]/.test(delimiter)) return undefined;
  const pattern = readSectionLoose(command, delimiter, 2);
  if (!pattern.closed) return { pattern: pattern.value, replacement: undefined, flags: "" };
  const replacement = readSectionLoose(command, delimiter, pattern.nextIndex);
  return { pattern: pattern.value, replacement: replacement.value, flags: command.slice(replacement.nextIndex) };
}

function readSectionLoose(
  command: string,
  delimiter: string,
  start: number
): { value: string; nextIndex: number; closed: boolean } {
  let value = "";
  let escaped = false;
  for (let index = start; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      value += `\\${char}`;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === delimiter) {
      return { value, nextIndex: index + 1, closed: true };
    } else {
      value += char;
    }
  }
  if (escaped) value += "\\";
  return { value, nextIndex: command.length, closed: false };
}

function parseSubstitute(command: string): { pattern: string; replacement: string; flags: string } | undefined {
  if (!command.startsWith("s")) return undefined;
  const delimiter = command[1];
  if (delimiter === undefined || /[A-Za-z0-9\s]/.test(delimiter)) return undefined;
  const pattern = readUntilDelimiter(command, delimiter, 2, { requireDelimiter: true });
  if (pattern === undefined) return undefined;
  const replacement = readUntilDelimiter(command, delimiter, pattern.nextIndex, { requireDelimiter: false });
  if (replacement === undefined) return undefined;
  return { pattern: pattern.value, replacement: replacement.value, flags: command.slice(replacement.nextIndex) };
}

function readUntilDelimiter(
  command: string,
  delimiter: string,
  start: number,
  { requireDelimiter }: { requireDelimiter: boolean }
): { value: string; nextIndex: number } | undefined {
  let value = "";
  let escaped = false;
  for (let index = start; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      value += `\\${char}`;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === delimiter) {
      return { value, nextIndex: index + 1 };
    } else {
      value += char;
    }
  }
  return requireDelimiter ? undefined : { value, nextIndex: command.length };
}

// The number of substitutions `:s` would make on [line]: every match with the
// `g` flag, at most one without. [walker] must be a `g`-flagged regexp.
function countMatchesInLine(line: string, walker: RegExp, global: boolean): number {
  walker.lastIndex = 0;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = walker.exec(line)) !== null) {
    count++;
    if (!global) break;
    // A zero-length match (e.g. `x*`) never advances [lastIndex] on its own.
    if (match[0].length === 0) walker.lastIndex++;
  }
  return count;
}

function substituteLine(line: string, regexp: RegExp, replacement: string): string {
  return line.replace(regexp, (...args) => {
    // replace() callback args: match, ...captureGroups, offset, line
    // (+ named-group object when present); the capture groups are everything
    // before the first number.
    const offsetIndex = args.findIndex(arg => typeof arg === "number");
    const groups = args.slice(1, offsetIndex) as (string | undefined)[];
    return expandReplacement(replacement, args[0] as string, groups);
  });
}

// Vim replacement metacharacters (`:h sub-replace-special`, the commonly used
// subset): `&` and `\0` insert the whole match, `\1`–`\9` insert capture
// groups (empty when unmatched), `\&` a literal ampersand, `\r` a line break,
// `\t` a tab, `\\` a backslash. Any other escaped character is inserted
// literally (e.g. an escaped delimiter, `\/`). Case modifiers (`\u`/`\U`/…)
// are not supported.
function expandReplacement(replacement: string, match: string, groups: readonly (string | undefined)[]): string {
  let out = "";
  for (let index = 0; index < replacement.length; index++) {
    const char = replacement[index];
    if (char === "&") {
      out += match;
      continue;
    }
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = replacement[index + 1];
    index++;
    if (next === undefined) {
      out += "\\";
    } else if (next === "0") {
      out += match;
    } else if (next >= "1" && next <= "9") {
      out += groups[Number(next) - 1] ?? "";
    } else if (next === "&") {
      out += "&";
    } else if (next === "r") {
      out += "\n";
    } else if (next === "t") {
      out += "\t";
    } else {
      out += next;
    }
  }
  return out;
}

function rangeToFullLines(editor: VimEditorCapabilities, range: LineRange): TextRange {
  if (range.endRowInclusive + 1 < editor.lineCount()) {
    return { start: { row: range.startRow, column: 0 }, end: { row: range.endRowInclusive + 1, column: 0 } };
  }
  // Deleting through the last line consumes the preceding newline, so an
  // empty trailing line does not survive as a leftover (`:v/a/d`).
  if (range.startRow > 0) {
    return {
      start: { row: range.startRow - 1, column: editor.lineLength(range.startRow - 1) },
      end: { row: range.endRowInclusive, column: editor.lineLength(range.endRowInclusive) },
    };
  }
  return {
    start: { row: range.startRow, column: 0 },
    end: { row: range.endRowInclusive, column: editor.lineLength(range.endRowInclusive) },
  };
}

function trailingNewlineForRange(editor: VimEditorCapabilities, range: LineRange): string {
  return range.endRowInclusive + 1 < editor.lineCount() ? "\n" : "";
}

function searchForward(editor: VimEditorCapabilities, start: ReturnType<typeof selectionHead>, query: string): ReturnType<typeof selectionHead> | undefined {
  const text = documentText(editor);
  const found = findWithWrap(text, query, offsetOfPosition(editor, start) + 1);
  return found === undefined ? undefined : positionOfOffset(editor, found);
}

function searchBackward(editor: VimEditorCapabilities, start: ReturnType<typeof selectionHead>, query: string): ReturnType<typeof selectionHead> | undefined {
  const text = documentText(editor);
  const startOffset = Math.max(0, offsetOfPosition(editor, start) - 1);
  const before = text.lastIndexOf(query, startOffset);
  if (before >= 0) return positionOfOffset(editor, before);
  const wrapped = text.lastIndexOf(query, text.length - 1);
  return wrapped >= 0 ? positionOfOffset(editor, wrapped) : undefined;
}

function documentText(editor: VimEditorCapabilities): string {
  const lines: string[] = [];
  for (let row = 0; row < editor.lineCount(); row++) lines.push(editor.line(row));
  return lines.join("\n");
}

function findWithWrap(text: string, query: string, startOffset: number): number | undefined {
  const found = text.indexOf(query, startOffset);
  if (found >= 0) return found;
  const wrapped = text.indexOf(query, 0);
  return wrapped >= 0 ? wrapped : undefined;
}

function offsetOfPosition(editor: VimEditorCapabilities, position: ReturnType<typeof selectionHead>): number {
  let offset = 0;
  for (let row = 0; row < position.row; row++) offset += editor.lineLength(row) + 1;
  return offset + position.column;
}

function positionOfOffset(editor: VimEditorCapabilities, offset: number): ReturnType<typeof selectionHead> {
  let remaining = offset;
  for (let row = 0; row < editor.lineCount(); row++) {
    const lineLength = editor.lineLength(row);
    if (remaining <= lineLength) return { row, column: remaining };
    remaining -= lineLength + 1;
  }
  const row = editor.lineCount() - 1;
  return { row, column: Math.max(0, editor.lineLength(row) - 1) };
}

function firstNonWhitespace(line: string): number {
  const first = line.search(/\S/);
  return first < 0 ? 0 : first;
}
