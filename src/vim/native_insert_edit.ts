// Recording of insert-mode input that the host handles natively.
//
// Not a Zed concept: Zed's Vim owns every insert-mode edit, while the VSCode
// host lets typed input pass through to VSCode, where a key's effect depends on
// editor state Vim cannot see (suggestion widget, snippet session, auto-close,
// format-on-type, language config, `insertSpaces`). Replaying such a key later
// re-runs it in a different state: `expe<tab>` that expanded a snippet replays
// as `expe` plus a tab. Like Vim's redo buffer, which holds the inserted text
// (completions included) rather than how it was produced, the host observes
// what a native key did to the buffer and Vim records that effect as an
// [InsertEdit] (see [RecordedKey] "edit"); replay applies the edit verbatim.

import { ApplyEditsOptions, VimEditorCapabilities } from "./editor.js";
import { positionAfterInsertedText } from "./insert.js";
import { Position, TextEdit, VimSelection, comparePositions, rangeOfSelection } from "./state.js";

// One native insert-mode effect, relative to the primary selection it ran at,
// so it replays at any cursor like typed text. Offsets count characters with
// line breaks as one "\n".
// - Replace [selectionStart + from, selectionEnd + to] with [text]
//   ([from] <= 0 <= [to]).
// - Then select [anchor]..[head], as offsets from the start of the replaced
//   range in the edited document. Offsets may fall outside [text] (a snippet
//   tabstop jump moves the cursor without editing).
export type InsertEdit = {
  from: number;
  to: number;
  text: string;
  anchor: number;
  head: number;
};

export type OffsetSelection = { anchor: number; head: number };

// The host's view of one native key: the text of a span of lines around the
// primary selection before the key and the same (tracked, see [TrackedSpan])
// span after its effect settled, with the selections as offsets into them.
export type NativeInsertSnapshot = {
  before: string;
  after: string;
  selectionBefore: OffsetSelection;
  selectionAfter: OffsetSelection;
  // Record an effect that only moved the cursor. Hosts allow this for keys
  // Vim does not record itself (a snippet tabstop `tab`); recorded keys such as
  // arrows replay faithfully on their own.
  allowCursorOnly: boolean;
};

// The [InsertEdit] that turns [snapshot.before] into [snapshot.after], or
// undefined when the key had no effect worth recording. The diff is the common
// prefix/suffix, clamped so the replaced range always contains the original
// selection; the inserted text then never depends on where an ambiguous diff
// (typing `a` next to `a`) happens to land.
export function diffInsertEdit(snapshot: NativeInsertSnapshot): InsertEdit | undefined {
  const { before, after, selectionBefore, selectionAfter } = snapshot;
  const startBefore = Math.min(selectionBefore.anchor, selectionBefore.head);
  const endBefore = Math.max(selectionBefore.anchor, selectionBefore.head);
  const selectionInside = (offset: number) => offset >= 0 && offset <= after.length;
  const insideAfter = selectionInside(selectionAfter.anchor) && selectionInside(selectionAfter.head);
  if (before === after) {
    if (!snapshot.allowCursorOnly || !insideAfter) return undefined;
    if (selectionAfter.anchor === selectionBefore.anchor && selectionAfter.head === selectionBefore.head) return undefined;
  }
  let prefix = 0;
  const maxPrefix = Math.min(startBefore, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;
  if (prefix > 0 && isHighSurrogate(after.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  const maxSuffix = Math.min(before.length - endBefore, after.length - prefix);
  while (suffix < maxSuffix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  if (suffix > 0 && isLowSurrogate(after.charCodeAt(after.length - suffix))) suffix--;
  const text = after.slice(prefix, after.length - suffix);
  // A selection that left the observed span (the host could not attribute it)
  // collapses to the end of the inserted text.
  const anchor = insideAfter ? selectionAfter.anchor - prefix : text.length;
  const head = insideAfter ? selectionAfter.head - prefix : text.length;
  return { from: prefix - startBefore, to: before.length - suffix - endBefore, text, anchor, head };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

// A document range followed through model changes reported in pre-change
// offsets (VSCode's `IModelContentChange.rangeOffset`/`rangeLength`). Changes
// that touch or overlap the span grow it; changes strictly before it shift it;
// changes after it are ignored. Edits elsewhere in the document (a completion's
// auto-import) therefore never enter the recorded effect.
export class TrackedSpan {
  constructor(public start: number, public end: number) {}

  applyChange(offset: number, length: number, insertedLength: number): void {
    const changeEnd = offset + length;
    const delta = insertedLength - length;
    if (changeEnd < this.start) {
      this.start += delta;
      this.end += delta;
      return;
    }
    if (offset > this.end) return;
    this.start = Math.min(this.start, offset);
    this.end = Math.max(this.end, changeEnd) + delta;
  }
}

// Replay an [InsertEdit] at every selection, keeping the insert undo unit open.
// Overlapping targets (cursors closer together than the edit's reach) keep the
// first.
export function applyInsertEdit(editor: VimEditorCapabilities, edit: InsertEdit, options: ApplyEditsOptions): void {
  const ranges = editor.getSelections().map(rangeOfSelection).sort((left, right) => comparePositions(left.start, right.start));
  const edits: TextEdit[] = [];
  for (const range of ranges) {
    const start = walkPosition(editor, range.start, edit.from);
    const end = walkPosition(editor, range.end, edit.to);
    const previous = edits[edits.length - 1];
    if (previous !== undefined && comparePositions(start, previous.range.end) < 0) continue;
    edits.push({ range: { start, end }, text: edit.text });
  }
  const selectionsAfter: VimSelection[] = edits.map((_, index) => ({
    type: "charwise",
    anchor: positionAfterEdit(editor, edits, index, edit.anchor),
    head: positionAfterEdit(editor, edits, index, edit.head),
  }));
  editor.applyEdits(edits, selectionsAfter, options);
}

// Where offset [relative] from the start of edit [index]'s replaced range ends
// up once all [edits] (ascending, non-overlapping) are applied.
function positionAfterEdit(editor: VimEditorCapabilities, edits: readonly TextEdit[], index: number, relative: number): Position {
  const target = edits[index];
  if (relative < 0) return transformPosition(walkPosition(editor, target.range.start, relative), edits);
  if (relative > target.text.length) {
    return transformPosition(walkPosition(editor, target.range.end, relative - target.text.length), edits);
  }
  return positionAfterInsertedText(transformPosition(target.range.start, edits.slice(0, index)), target.text.slice(0, relative));
}

// Map a pre-edit position that lies outside every edit to the edited document.
function transformPosition(position: Position, edits: readonly TextEdit[]): Position {
  let rowDelta = 0;
  // On pre-edit row [columnRow], columns from [columnFrom] map to [columnTo] + offset.
  let columnRow = -1;
  let columnFrom = 0;
  let columnTo = 0;
  const map = (point: Position): Position => ({
    row: point.row + rowDelta,
    column: point.row === columnRow && point.column >= columnFrom ? columnTo + point.column - columnFrom : point.column,
  });
  for (const edit of edits) {
    if (comparePositions(edit.range.end, position) > 0) break;
    const endAfter = positionAfterInsertedText(map(edit.range.start), edit.text);
    rowDelta = endAfter.row - edit.range.end.row;
    columnRow = edit.range.end.row;
    columnFrom = edit.range.end.column;
    columnTo = endAfter.column;
  }
  return map(position);
}

// Move [delta] characters from [position] (a line break counts as one),
// clamped to the document.
export function walkPosition(editor: VimEditorCapabilities, position: Position, delta: number): Position {
  let { row, column } = position;
  let remaining = delta;
  while (remaining > 0) {
    const available = editor.lineLength(row) - column;
    if (remaining <= available) return { row, column: column + remaining };
    if (row >= editor.lineCount() - 1) return { row, column: editor.lineLength(row) };
    remaining -= available + 1;
    row++;
    column = 0;
  }
  while (remaining < 0) {
    if (-remaining <= column) return { row, column: column + remaining };
    if (row === 0) return { row: 0, column: 0 };
    remaining += column + 1;
    row--;
    column = editor.lineLength(row);
  }
  return { row, column };
}
