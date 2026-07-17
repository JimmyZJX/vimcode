// VSCodeVim compatibility reference:
// - source: src/actions/plugins/replaceWithRegister.ts
// - translated behavior: `gr{motion}` / `grr` replace the target with a
//   register without changing that register; visual `gr` replaces the selection.

import { previousGraphemeBoundary } from "../grapheme.js";
import { VimEditorCapabilities, rangeText } from "../editor.js";
import type { CharwiseTarget, ResolvedTarget, RowRange } from "../operator_target.js";
import { RegisterContent, RegisterName, RegisterPart, Registers } from "../registers.js";
import { TextEdit, VimSelection, charwiseSelection } from "../state.js";

export function replaceWithRegisterWouldEdit(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  target: ResolvedTarget
): boolean {
  const content = registers.readContentIfPresent(registerName);
  if (content === undefined) return false;
  switch (target.kind) {
    case "charwise":
      return target.targets.some((candidate, index) =>
        candidate.cancelled !== true
        && rangeText(editor, candidate.range)
          !== normalizedRegisterText(registerContentForTarget(content, candidate.selectionIndex ?? index)));
    case "linewise":
      return target.rows.some((row, index) => {
        const range = {
          start: { row: row.startRow, column: 0 },
          end: { row: row.endRow, column: editor.lineLength(row.endRow) },
        };
        return rangeText(editor, range)
          !== normalizedRegisterText(registerContentForTarget(content, row.selectionIndex ?? index));
      });
  }
}

export function applyReplaceWithRegister(
  editor: VimEditorCapabilities,
  registers: Registers,
  registerName: RegisterName | undefined,
  target: ResolvedTarget,
  { lineAction, multilineObject }: { lineAction: boolean; multilineObject: boolean }
): void {
  const content = registers.readContentIfPresent(registerName);
  if (content === undefined) return;

  switch (target.kind) {
    case "charwise":
      replaceCharwiseTargets(editor, content, target.targets, { lineAction, multilineObject });
      return;
    case "linewise":
      replaceLinewiseTargets(editor, content, target.rows, { lineAction });
      return;
  }
}

function replaceCharwiseTargets(
  editor: VimEditorCapabilities,
  content: RegisterContent,
  targets: readonly CharwiseTarget[],
  { lineAction, multilineObject }: { lineAction: boolean; multilineObject: boolean }
): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];

  targets.forEach((target, index) => {
    if (target.cancelled === true) {
      selectionsAfter.push(charwiseSelection(target.head));
      return;
    }
    const registerContent = registerContentForTarget(content, target.selectionIndex ?? index);
    const replacement = normalizedRegisterText(registerContent);
    // VSCodeVim's multiline surround objects start at the line boundary. Keep
    // that plugin-specific geometry adjustment tied to the target source — a
    // multiline visual selection or ordinary motion must retain its prefix.
    const replacementIsNoop = rangeText(editor, target.range) === replacement;
    if (replacementIsNoop) {
      selectionsAfter.push(charwiseSelection(target.range.start));
      return;
    }
    const range = multilineObject && target.range.start.row !== target.range.end.row
      ? { ...target.range, start: { row: target.range.start.row, column: 0 } }
      : target.range;
    edits.push({ range, text: replacement });
    selectionsAfter.push(charwiseSelection(cursorAfterReplacement(range, replacement, { lineAction })));
  });

  if (edits.length > 0) editor.applyEdits(edits, selectionsAfter);
  else if (selectionsAfter.length > 0) editor.setSelections(selectionsAfter);
}

function replaceLinewiseTargets(
  editor: VimEditorCapabilities,
  content: RegisterContent,
  rows: readonly RowRange[],
  { lineAction }: { lineAction: boolean }
): void {
  const edits: TextEdit[] = [];
  const selectionsAfter: VimSelection[] = [];

  rows.forEach((rowRange, index) => {
    const range = {
      start: { row: rowRange.startRow, column: 0 },
      end: { row: rowRange.endRow, column: editor.lineLength(rowRange.endRow) },
    };
    const replacement = normalizedRegisterText(registerContentForTarget(content, rowRange.selectionIndex ?? index));
    edits.push({ range, text: replacement });
    selectionsAfter.push(charwiseSelection(cursorAfterReplacement(range, replacement, { lineAction })));
  });

  if (edits.length > 0) editor.applyEdits(edits, selectionsAfter);
}

function registerContentForTarget(content: RegisterContent, selectionIndex: number): RegisterPart | RegisterContent {
  if (content.parts === undefined || content.parts.length === 0) return content;
  return content.parts[selectionIndex] ?? content.parts[0];
}

function normalizedRegisterText(content: RegisterPart | RegisterContent): string {
  // Local linewise registers carry their terminating newline; VSCodeVim's
  // ReplaceWithRegister inserts line contents into a range that preserves the
  // surrounding newline, so strip exactly that register terminator.
  return content.kind === "linewise" && content.text.endsWith("\n")
    ? content.text.slice(0, -1)
    : content.text;
}

function cursorAfterReplacement(
  range: TextEdit["range"],
  replacement: string,
  { lineAction }: { lineAction: boolean }
): { row: number; column: number } {
  const lines = replacement.split("\n");
  if (!lineAction && range.start.row === range.end.row && lines.length === 1) {
    const lastCell = replacement.length === 0 ? 0 : previousGraphemeBoundary(replacement, replacement.length);
    return { row: range.start.row, column: range.start.column + lastCell };
  }
  const firstNonBlank = lines[0]?.search(/\S/) ?? -1;
  return { row: range.start.row, column: Math.max(0, firstNonBlank) };
}
