// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/command.rs
// - translated concepts: a small Ex command parser with ranges, goto, join,
//   delete, sort, and substitute commands
// - intentional differences: this is a deliberately small model-buffer command
//   executor. Zed integrates with the command palette, workspace actions, shell
//   commands, marks, regex conversion, and async UI completion.

import { VimEditorCapabilities } from "./editor.js";
import { HistoryNavigation, PromptHistory, historyNavigationKey } from "./prompt_history.js";
import { Registers, parseRegisterName } from "./registers.js";
import { translateVimRegex } from "./search.js";
import { TextEdit, TextRange, charwiseSelection, selectionHead } from "./state.js";

// The in-flight `:` command-line input, held while in `command` mode. A small
// string accumulator (append typed keys, `backspace` removes the last char,
// `space` inserts a space), mirroring the legacy command line; unlike the search
// prompt it has no cursor navigation. Owned by [Vim] (mode entry constructs it,
// prefilling `'<,'>` from a visual selection) and injected live into the pure
// command-mode grammar. [history] is the global command history; `<Up>`/`<C-p>`
// recall through it (see [PromptHistory]).
export class CommandLine {
  private text: string;
  private nav: HistoryNavigation | undefined;

  constructor(initial = "", private readonly history: PromptHistory = new PromptHistory()) {
    this.text = initial;
  }

  value(): string {
    return this.text;
  }

  append(key: string): void {
    this.text += key === "space" ? " " : key;
    this.nav = undefined;
  }

  backspace(): void {
    this.text = this.text.slice(0, -1);
    this.nav = undefined;
  }

  // `<Up>`/`<Down>`/`<C-p>`/`<C-n>`: recall through the command history.
  // Returns false for other keys.
  historyKey(key: string): boolean {
    const step = historyNavigationKey(key);
    if (step === undefined) return false;
    if (this.nav === undefined) this.nav = { prefix: this.text, index: undefined };
    const recalled = this.history.navigate(this.nav, step);
    if (recalled !== undefined) this.text = recalled;
    return true;
  }
}

// Keys the `:` command line consumes: printable characters, space, enter,
// backspace, and escape (which cancels via the central escape handling). Used by
// [Vim.keyOwnership] so VSCode does not intercept them while the prompt is open, and
// by the command-mode grammar to bound the keys it accepts.
export function isCommandInputKey(key: string): boolean {
  return (
    key.length === 1 ||
    key === "space" ||
    key === "enter" ||
    key === "backspace" ||
    key === "<escape>" ||
    key === "escape" ||
    key === "ctrl-[" ||
    historyNavigationKey(key) !== undefined
  );
}

export type CommandOptions = {
  runNormalKeys?: (keys: readonly string[], range: LineRange | undefined) => void;
  /** Register access for `:pu[t]`. */
  registers?: Registers;
  exOptions?: { gdefault: boolean };
  /** Resolves `'x` mark addresses (`:'<,'>s/...`) to a row. */
  markLine?: (name: string) => number | undefined;
};

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
    run: ({ editor }) => editor.executeNativeCommand("workbench.action.files.save", [], { syncSelectionAfter: true }),
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
    name: ["d", "elete"],
    run: ({ editor, range }) => deleteRange(editor, range ?? currentLineRange(editor, 1)),
  },
  {
    name: ["sor", "t"],
    run: ({ editor, range }) => sortRange(editor, range ?? wholeBufferRange(editor)),
  },
];

function saveAndClose(editor: VimEditorCapabilities): void {
  editor.executeNativeCommand("workbench.action.files.save");
  editor.executeNativeCommand("workbench.action.closeActiveEditor");
}

function saveAllAndClose(editor: VimEditorCapabilities): void {
  editor.executeNativeCommand("workbench.action.files.saveAll");
  editor.executeNativeCommand("workbench.action.closeAllEditors");
}

function newSplit(editor: VimEditorCapabilities, splitCommand: string): void {
  editor.executeNativeCommand(splitCommand);
  editor.executeNativeCommand("workbench.action.files.newUntitledFile");
}

export function executeCommand(editor: VimEditorCapabilities, rawCommand: string, options: CommandOptions = {}): void {
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
    substitute(editor, range ?? currentLineRange(editor, 1), trimmedRest, options.exOptions?.gdefault ?? false);
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

function matchingLines(editor: VimEditorCapabilities, range: LineRange, command: string, options: CommandOptions): void {
  const parsed = parseMatchingLines(command);
  if (parsed === undefined) return;
  const translated = translateVimRegex(parsed.pattern);
  const regexp = new RegExp(translated.source, translated.forceCase === "ignore" ? "i" : "");
  const rows: number[] = [];
  for (let row = range.startRow; row <= range.endRowInclusive; row++) {
    if (regexp.test(editor.line(row)) !== parsed.invert) rows.push(row);
  }
  if (parsed.command === "d" || parsed.command === "delete") {
    deleteMatchingRows(editor, rows);
    return;
  }
  // Vim `:g/pat/normal {keys}`: run the normal command on every matched line.
  if (/^norm(?:al)?!?(\s|$)/.test(parsed.command)) {
    runNormalKeysOnRows(editor, rows, normalCommandKeysText(parsed.command), options);
  }
}

function parseMatchingLines(command: string): { invert: boolean; pattern: string; command: string } | undefined {
  const invert = command.startsWith("v");
  const rest = command.slice(1);
  const delimiter = rest[0];
  if (delimiter === undefined) return undefined;
  const pattern = readUntilDelimiter(rest, delimiter, 1, { requireDelimiter: true });
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

function normalCommand(editor: VimEditorCapabilities, range: LineRange | undefined, command: string, options: CommandOptions): void {
  const targetRange = range ?? currentLineRange(editor, 1);
  const rows: number[] = [];
  for (let row = targetRange.startRow; row <= targetRange.endRowInclusive; row++) rows.push(row);
  runNormalKeysOnRows(editor, rows, normalCommandKeysText(command), options);
}

function normalCommandKeysText(command: string): string {
  return command.replace(/^norm(?:al)?!?\s?/, "");
}

// Vim `:h :normal`: replay the keys with the cursor at the start of each
// line. `I`/`A` prefixes batch into one edit so the whole ranged command is a
// single undo step (`:g/pat/norm Abar` then `u` restores every line).
function runNormalKeysOnRows(editor: VimEditorCapabilities, rows: readonly number[], keysText: string, options: CommandOptions): void {
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
  for (const row of rows) {
    options.runNormalKeys?.(keys, { startRow: row, endRowInclusive: row });
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

function substitute(editor: VimEditorCapabilities, range: LineRange, command: string, gdefault: boolean): void {
  const parsed = parseSubstitute(command);
  if (parsed === undefined) return;
  if (parsed.flags.includes("n")) return;

  // Vim `:h gdefault` / `:h :s_g`: every `g` flag toggles whole-line
  // replacement; `gdefault` flips the starting state.
  const gParity = [...parsed.flags].filter(flag => flag === "g").length % 2 === 1;
  const global = gdefault ? !gParity : gParity;

  const edits: TextEdit[] = [];
  for (let row = range.startRow; row <= range.endRowInclusive; row++) {
    const line = editor.line(row);
    const replaced = substituteLine(line, parsed.pattern, parsed.replacement, global);
    if (replaced !== line) {
      edits.push({ range: { start: { row, column: 0 }, end: { row, column: editor.lineLength(row) } }, text: replaced });
    }
  }
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

function substituteLine(line: string, pattern: string, replacement: string, global: boolean): string {
  const translated = translateVimRegex(pattern);
  const regexp = new RegExp(translated.source, `${global ? "g" : ""}${translated.forceCase === "ignore" ? "i" : ""}`);
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
