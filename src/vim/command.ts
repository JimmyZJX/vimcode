// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/command.rs
// - translated concepts: a small Ex command parser with ranges, goto, join,
//   delete, sort, and substitute commands
// - intentional differences: this is a deliberately small model-buffer command
//   executor. Zed integrates with the command palette, workspace actions, shell
//   commands, marks, regex conversion, and async UI completion.

import { VimEditorCapabilities } from "./editor.js";
import { TextEdit, TextRange, charwiseSelection, selectionHead } from "./state.js";

export type CommandOptions = {
  runNormalKeys?: (keys: readonly string[], range: LineRange | undefined) => void;
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

  const { range, rest } = parseRange(editor, command);
  const trimmedRest = rest.trim();
  if (trimmedRest.length === 0) {
    if (range !== undefined) moveToLine(editor, range.endRowInclusive);
    return;
  }

  if (dispatchSimpleCommand({ editor, range }, trimmedRest)) return;

  if (trimmedRest.startsWith("g") || trimmedRest.startsWith("v")) {
    matchingLines(editor, range ?? wholeBufferRange(editor), trimmedRest);
    return;
  }

  if (trimmedRest.startsWith("norm")) {
    normalCommand(editor, range, rest.trimStart(), options);
    return;
  }

  if (trimmedRest.startsWith("s")) {
    substitute(editor, range ?? currentLineRange(editor, 1), trimmedRest);
  }
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

function parseGotoLine(command: string): number | undefined {
  return /^\d+$/.test(command) ? Number(command) : undefined;
}

function parseRange(editor: VimEditorCapabilities, command: string): { range: LineRange | undefined; rest: string } {
  if (command.startsWith("%") && command.length > 1 && command[1] !== "+" && command[1] !== "-" && command[1] !== "," && command[1] !== ";") {
    return { range: wholeBufferRange(editor), rest: command.slice(1) };
  }

  const first = parseAddress(editor, command, 0);
  if (first === undefined) return { range: undefined, rest: command };

  let nextIndex = first.nextIndex;
  let endRow = first.row;
  if (command[nextIndex] === "," || command[nextIndex] === ";") {
    const second = parseAddress(editor, command, nextIndex + 1);
    if (second !== undefined) {
      endRow = second.row;
      nextIndex = second.nextIndex;
    }
  }

  return {
    range: normalizeLineRange(editor, first.row, endRow),
    rest: command.slice(nextIndex),
  };
}

function parseAddress(editor: VimEditorCapabilities, command: string, startIndex: number): { row: number; nextIndex: number } | undefined {
  let index = startIndex;
  let row: number;
  if (command[index] === "%") {
    row = editor.lineCount() - 1;
    index++;
  } else if (command[index] === ".") {
    row = selectionHead(editor.getSelections()[0]).row;
    index++;
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

function matchingLines(editor: VimEditorCapabilities, range: LineRange, command: string): void {
  const parsed = parseMatchingLines(command);
  if (parsed === undefined) return;
  const rows: number[] = [];
  for (let row = range.startRow; row <= range.endRowInclusive; row++) {
    const matches = new RegExp(parsed.pattern).test(editor.line(row));
    if (matches !== parsed.invert) rows.push(row);
  }
  if (parsed.command === "d" || parsed.command === "delete") {
    deleteMatchingRows(editor, rows);
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
  const keysText = command.replace(/^norm(?:al)?!?\s*/, "");
  const targetRange = range ?? currentLineRange(editor, 1);
  if (keysText.startsWith("I")) {
    prependToLines(editor, targetRange, keysText.slice(1));
    return;
  }
  options.runNormalKeys?.(keysText.split("").map(key => key === " " ? "space" : key), targetRange);
}

function prependToLines(editor: VimEditorCapabilities, range: LineRange, text: string): void {
  const edits: TextEdit[] = [];
  for (let row = range.startRow; row <= range.endRowInclusive; row++) {
    edits.push({ range: { start: { row, column: 0 }, end: { row, column: 0 } }, text });
  }
  editor.applyEdits(edits, [charwiseSelection({ row: range.startRow, column: Math.max(0, text.length - 1) })]);
}

function substitute(editor: VimEditorCapabilities, range: LineRange, command: string): void {
  const parsed = parseSubstitute(command);
  if (parsed === undefined) return;
  if (parsed.flags.includes("n")) return;

  const edits: TextEdit[] = [];
  for (let row = range.startRow; row <= range.endRowInclusive; row++) {
    const line = editor.line(row);
    const replaced = substituteLine(line, parsed.pattern, parsed.replacement, parsed.flags.includes("g"));
    if (replaced !== line) {
      edits.push({ range: { start: { row, column: 0 }, end: { row, column: editor.lineLength(row) } }, text: replaced });
    }
  }
  if (edits.length > 0) {
    const lastEdit = edits[edits.length - 1];
    editor.applyEdits(edits, [charwiseSelection({ row: lastEdit.range.start.row, column: firstNonWhitespace(lastEdit.text) })]);
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
  const regexp = new RegExp(pattern, global ? "g" : "");
  return line.replace(regexp, match => expandReplacement(replacement, match));
}

function expandReplacement(replacement: string, match: string): string {
  return replacement
    .replace(/\\0/g, match)
    .replace(/\\([^0])/g, "$1");
}

function rangeToFullLines(editor: VimEditorCapabilities, range: LineRange): TextRange {
  if (range.endRowInclusive + 1 < editor.lineCount()) {
    return { start: { row: range.startRow, column: 0 }, end: { row: range.endRowInclusive + 1, column: 0 } };
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
