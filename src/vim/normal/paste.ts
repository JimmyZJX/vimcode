// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/paste.rs
// - translated concepts: paste before/after the cursor
// - intentional differences: this is still a small subset of Zed paste behavior; visual,
//   counts, multicursor details, and auto-indent are future work.

import { previousGraphemeBoundary } from "../grapheme.js";
import { VimEditorCapabilities } from "../editor.js";
import { positionAfterInsertedText } from "../insert.js";
import { RegisterContent, RegisterName, RegisterPart, Registers } from "../registers.js";
import { TextEdit, VimSelection, charwiseSelection, selectionHead } from "../state.js";

export type PasteVariant = {
  before: boolean;
  count?: number;
  // `gp`/`gP`: leave the cursor just after the pasted text (the character
  // following a charwise paste; the line below a linewise one).
  cursorAfter?: boolean;
  // `]p`/`[p`/`]P`/`[P`: reindent a linewise paste to the current line,
  // preserving the pasted lines' relative indentation (spaces-first, like
  // 'expandtab' — the fixtures are recorded with it). Charwise/blockwise
  // registers paste plainly, like Vim.
  adjustIndent?: boolean;
};

// Zed: `normal::paste::Vim::paste`.
export function paste(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  { before, count = 1, cursorAfter = false, adjustIndent = false }: PasteVariant
): void {
  const content = registers.readContent(registerName);
  if (content.text.length === 0) return;

  const distributed = distributedRegisterParts(content, editor.getSelections().length);
  if (distributed !== undefined) {
    pasteDistributed(editor, distributed, { before, count });
    return;
  }

  if (content.kind === "linewise") {
    pasteLinewise(editor, content.text, { before, count, cursorAfter, adjustIndent });
  } else if (content.kind === "blockwise") {
    pasteBlockwise(editor, content.text, { before, count });
  } else {
    pasteCharacterwise(editor, content.text.repeat(count), { before, cursorAfter });
  }
}

function distributedRegisterParts(content: RegisterContent, selectionCount: number): readonly RegisterPart[] | undefined {
  if (selectionCount <= 1) return undefined;
  if (content.parts?.length === selectionCount) return content.parts;

  const lines = linesForPlainTextDistribution(content.text, selectionCount);
  return lines === undefined ? undefined : lines.map(text => ({ text, kind: "characterwise" }));
}

function linesForPlainTextDistribution(text: string, selectionCount: number): readonly string[] | undefined {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withoutFinalLineSeparator = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const lines = withoutFinalLineSeparator.split("\n");
  return lines.length === selectionCount ? lines : undefined;
}

function pasteDistributed(
  editor: VimEditorCapabilities,
  parts: readonly RegisterPart[],
  { before, count }: { before: boolean; count: number }
): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  const selections = editor.getSelections();

  for (let index = 0; index < selections.length; index++) {
    const part = parts[index];
    const selection = selections[index];
    if (part === undefined || selection === undefined) continue;
    pushPasteEditsForSelection(editor, edits, selectionsAfter, selection, part, { before, count });
  }

  editor.applyEdits(edits, selectionsAfter);
}

function pushPasteEditsForSelection(
  editor: VimEditorCapabilities,
  edits: TextEdit[],
  selectionsAfter: VimSelection[],
  selection: VimSelection,
  part: RegisterPart,
  { before, count }: { before: boolean; count: number }
): void {
  switch (part.kind) {
    case "characterwise":
      pushCharacterwisePasteEdit(editor, edits, selectionsAfter, selection, part.text.repeat(count), { before, cursorAfter: false });
      return;
    case "linewise":
      pushLinewisePasteEdit(editor, edits, selectionsAfter, selection, repeatedLinewiseText(part.text, count), { before, cursorAfter: false });
      return;
    case "blockwise":
      pushBlockwisePasteEdits(editor, edits, selectionsAfter, selection, part.text, { before, count });
      return;
  }
}

function pasteCharacterwise(
  editor: VimEditorCapabilities,
  text: string,
  { before, cursorAfter = false }: { before: boolean; cursorAfter?: boolean }
): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];
  for (const selection of editor.getSelections()) {
    pushCharacterwisePasteEdit(editor, edits, selectionsAfter, selection, text, { before, cursorAfter });
  }
  editor.applyEdits(edits, selectionsAfter);
}

function pushCharacterwisePasteEdit(
  editor: VimEditorCapabilities,
  edits: TextEdit[],
  selectionsAfter: VimSelection[],
  selection: VimSelection,
  text: string,
  { before, cursorAfter }: { before: boolean; cursorAfter: boolean }
): void {
  const head = selectionHead(selection);
  const insertAt = before
    ? head
    : { row: head.row, column: Math.min(head.column + 1, editor.lineLength(head.row)) };
  edits.push({ range: { start: insertAt, end: insertAt }, text });
  // `gp`/`gP`: the cursor lands on the character just after the pasted text.
  const cursor = cursorAfter
    ? positionAfterInsertedText(insertAt, text)
    : cursorAtEndOfInsertedText(insertAt, text);
  selectionsAfter.push(charwiseSelection(cursor));
}

function cursorAtEndOfInsertedText(start: ReturnType<typeof selectionHead>, text: string): ReturnType<typeof selectionHead> {
  const after = positionAfterInsertedText(start, text);
  if (text.length === 0) return start;
  // Vim: pasting multi-line charwise text leaves the cursor on the first
  // pasted character; single-line charwise paste leaves it on the last
  // character *cell* (cluster start).
  if (text.includes("\n")) return start;
  void after;
  return { row: start.row, column: Math.max(start.column, start.column + previousGraphemeBoundary(text, text.length)) };
}

function pasteBlockwise(
  editor: VimEditorCapabilities,
  text: string,
  { before, count }: { before: boolean; count: number }
): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];

  for (const selection of editor.getSelections()) {
    pushBlockwisePasteEdits(editor, edits, selectionsAfter, selection, text, { before, count });
  }

  editor.applyEdits(edits, selectionsAfter);
}

function pushBlockwisePasteEdits(
  editor: VimEditorCapabilities,
  edits: TextEdit[],
  selectionsAfter: VimSelection[],
  selection: VimSelection,
  text: string,
  { before, count }: { before: boolean; count: number }
): void {
  const blockLines = Array(count).fill(text).join("\n").split("\n");
  const head = selectionHead(selection);
  const column = before ? head.column : head.column;
  for (let index = 0; index < blockLines.length; index++) {
    const row = Math.min(head.row + index, editor.lineCount() - 1);
    const insertAt = { row, column: Math.min(column, editor.lineLength(row)) };
    edits.push({ range: { start: insertAt, end: insertAt }, text: blockLines[index] });
  }
  selectionsAfter.push(charwiseSelection({ row: head.row, column: head.column + (blockLines[0]?.length ?? 0) }));
}

function pasteLinewise(
  editor: VimEditorCapabilities,
  text: string,
  { before, count, cursorAfter = false, adjustIndent = false }: { before: boolean; count: number; cursorAfter?: boolean; adjustIndent?: boolean }
): void {
  const repeatedLineText = repeatedLinewiseText(text, count);
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];

  for (const selection of editor.getSelections()) {
    const lineText = adjustIndent
      ? reindentedLines(repeatedLineText, editor.line(selectionHead(selection).row))
      : repeatedLineText;
    pushLinewisePasteEdit(editor, edits, selectionsAfter, selection, lineText, { before, cursorAfter });
  }

  editor.applyEdits(edits, selectionsAfter);
}

// `]p`-family reindentation: shift every pasted line's indentation by the
// difference between the current line's indent width and the first pasted
// line's, preserving relative indentation. Widths count tabs at 8 columns;
// the synthesized indent is spaces.
function reindentedLines(text: string, currentLine: string): string {
  const lines = text.split("\n");
  const targetWidth = indentWidth(currentLine);
  const sourceWidth = lines.length > 0 ? indentWidth(lines[0]) : 0;
  const delta = targetWidth - sourceWidth;
  return lines
    .map(line => {
      if (/^[ \t]*$/.test(line)) return line;
      const body = line.replace(/^[ \t]*/, "");
      return " ".repeat(Math.max(0, indentWidth(line) + delta)) + body;
    })
    .join("\n");
}

function firstNonBlankColumn(line: string): number {
  const column = line.search(/[^ \t]/);
  return column < 0 ? 0 : column;
}

function indentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width++;
    else if (char === "\t") width = (Math.floor(width / 8) + 1) * 8;
    else break;
  }
  return width;
}

function repeatedLinewiseText(text: string, count: number): string {
  const lineText = text.endsWith("\n") ? text.slice(0, -1) : text;
  return Array(count).fill(lineText).join("\n");
}

function pushLinewisePasteEdit(
  editor: VimEditorCapabilities,
  edits: TextEdit[],
  selectionsAfter: VimSelection[],
  selection: VimSelection,
  repeatedLineText: string,
  { before, cursorAfter }: { before: boolean; cursorAfter: boolean }
): void {
  const head = selectionHead(selection);
  const insertAt = before
    ? { row: head.row, column: 0 }
    : { row: head.row, column: editor.lineLength(head.row) };
  const insertedText = before ? `${repeatedLineText}\n` : `\n${repeatedLineText}`;
  edits.push({ range: { start: insertAt, end: insertAt }, text: insertedText });
  const firstPastedRow = before ? head.row : head.row + 1;
  const pastedLineCount = repeatedLineText.split("\n").length;
  // `gp`/`gP`: the line after the pasted block; otherwise the first non-blank
  // of the first pasted line.
  const cursor = cursorAfter
    ? { row: firstPastedRow + pastedLineCount, column: 0 }
    : { row: firstPastedRow, column: firstNonBlankColumn(repeatedLineText.split("\n")[0] ?? "") };
  selectionsAfter.push(charwiseSelection(cursor));
}
