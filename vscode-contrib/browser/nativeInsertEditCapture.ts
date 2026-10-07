import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IActiveCodeEditor } from '../../../browser/editorBrowser.js';
import { IPosition } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { EndOfLinePreference, ITextModel } from '../../../common/model.js';
import { TextModelEditSource } from '../../../common/textModelEditSource.js';
import { InsertEdit, OffsetSelection, TrackedSpan, diffInsertEdit } from '../common/native_insert_edit.js';

/**
 * Edit sources (VSCode's `IModelContentChangedEvent.detailedReasons`) of
 * completion-like insertions: text chosen from editor state that replaying
 * the key cannot reproduce. Any key whose effect includes one is recorded as
 * that effect, whichever command or provider produced it (an extension's
 * completion goes through the suggest controller; emmet and `insertSnippet`
 * through the snippet controller; Copilot through inline completions).
 */
const completionEditSources: ReadonlySet<string> = new Set([
	'suggest',
	'snippet',
	'inlineCompletionAccept',
	'inlineCompletionPartialAccept',
]);

/**
 * `cursor` edit-source kinds of plain typing (including IME composition).
 */
const typingEditKinds: ReadonlySet<string> = new Set(['type', 'compositionType', 'compositionEnd']);

/**
 * Commands of keys Vim declines (does not record) whose effect is still
 * insert-mode input worth recording. Their edits are tagged like any editor
 * command (`cursor`/`executeCommand`), so only the command tells indentation
 * apart from, say, toggle comment, which stays out of recordings.
 */
const indentCommands: ReadonlySet<string> = new Set(['tab', 'outdent']);

/**
 * Commands whose effect may be a pure cursor move worth replaying: a snippet
 * tabstop jump lands on a position the replayed snippet text recreates.
 */
const snippetJumpCommands: ReadonlySet<string> = new Set([
	'jumpToNextSnippetPlaceholder',
	'jumpToPrevSnippetPlaceholder',
]);

function isCompletionEdit(reason: TextModelEditSource): boolean {
	return completionEditSources.has(reason.metadata.source);
}

function isTypingEdit(reason: TextModelEditSource): boolean {
	return reason.metadata.source === 'cursor' && typingEditKinds.has(reason.metadata.kind);
}

export type NativeInsertEditResult = { key: string; edit: InsertEdit; supersedesTyped: boolean };

export type NativeInsertEditCaptureOptions = {
	// Vim's name for the key (display only).
	key: string;
	// The command VSCode's keybinding resolution picked for the key, if any.
	commandId: string | undefined;
	// Vim recorded the key as a passthrough `typed` entry.
	supersedesTyped: boolean;
	// Vim (or a native command Vim runs) is editing the buffer.
	isVimEditing: () => boolean;
};

/**
 * Observes what VSCode does for one insert/replace-mode key Vim let it handle
 * natively, so Vim records that effect instead of a key whose native meaning
 * depends on editor state Vim cannot replay (suggestion widget, snippet
 * session, auto-close; see the core's [InsertEdit]).
 *
 * The capture opens on keydown, before VSCode handles the key, and is finished
 * by the controller when the next key arrives; blur and mouse cursor moves end
 * it early. It snapshots the lines around the single selection, follows that
 * span through model changes ([TrackedSpan]), and diffs the span's text. Edits
 * it cannot attribute to the key (Vim's own edits, undo/redo) or a switch to
 * several cursors abandon it, leaving the recording as it was.
 *
 * Whether the effect replaces the key in the recording ([recordsEffect]):
 * - It contains a completion-like edit ([completionEditSources]).
 * - Otherwise a key Vim recorded itself keeps its `typed` entry: replaying
 *   plain typing natively re-applies auto-indent and auto-close in the replay
 *   context, like Vim's redo re-applies 'autoindent'.
 * - A key Vim declined has nothing to replay, so its effect is recorded when
 *   it is typing (IME, AltGr) or indentation ([indentCommands]), or a snippet
 *   tabstop jump, the only effect recorded even when it just moves the cursor.
 *   Other editor commands (toggle comment, move line) stay unrecorded.
 */
export class NativeInsertEditCapture implements IDisposable {
	private readonly disposables = new DisposableStore();
	private readonly span: TrackedSpan;
	private readonly before: string;
	private readonly selectionBefore: OffsetSelection;
	private selectionAfter: Selection;
	private sawCompletionEdit = false;
	private sawEdit = false;
	private sawNonTypingEdit = false;
	private result: NativeInsertEditResult | undefined;
	private done = false;

	static open(
		editor: IActiveCodeEditor,
		options: NativeInsertEditCaptureOptions
	): NativeInsertEditCapture | undefined {
		const selections = editor.getSelections();
		if (selections.length !== 1) {
			return undefined;
		}
		return new NativeInsertEditCapture(editor, selections[0], options);
	}

	private constructor(
		private readonly editor: IActiveCodeEditor,
		selection: Selection,
		private readonly options: NativeInsertEditCaptureOptions
	) {
		const model = editor.getModel();
		const startLine = Math.min(selection.startLineNumber, selection.endLineNumber);
		const endLine = Math.max(selection.startLineNumber, selection.endLineNumber);
		const spanStart = { lineNumber: startLine, column: 1 };
		const spanEnd = { lineNumber: endLine, column: model.getLineMaxColumn(endLine) };
		this.span = new TrackedSpan(model.getOffsetAt(spanStart), model.getOffsetAt(spanEnd));
		this.before = model.getValueInRange(Range.fromPositions(spanStart, spanEnd), EndOfLinePreference.LF);
		this.selectionBefore = offsetSelection(model, spanStart, selection);
		this.selectionAfter = selection;
		this.disposables.add(editor.onDidChangeModelContent(event => {
			if (this.done) return;
			if (event.isUndoing || event.isRedoing || this.options.isVimEditing()) {
				this.abandon();
				return;
			}
			for (const change of event.changes) {
				this.span.applyChange(change.rangeOffset, change.rangeLength, change.text.length);
			}
			this.sawEdit = true;
			for (const reason of event.detailedReasons) {
				if (isCompletionEdit(reason)) this.sawCompletionEdit = true;
				if (!isTypingEdit(reason)) this.sawNonTypingEdit = true;
			}
		}));
		this.disposables.add(editor.onDidChangeCursorSelection(event => {
			if (this.done) return;
			if (event.secondarySelections.length > 0) {
				this.abandon();
			} else if (event.source === 'mouse') {
				// The click is not part of the key's effect: settle on the
				// selection the key left.
				this.settle();
			} else {
				this.selectionAfter = event.selection;
			}
		}));
		this.disposables.add(editor.onDidBlurEditorText(() => this.settle()));
		this.disposables.add(editor.onDidChangeModel(() => this.abandon()));
	}

	/** The key's observed effect, if it is worth recording. */
	finish(): NativeInsertEditResult | undefined {
		this.settle();
		return this.result;
	}

	dispose(): void {
		this.done = true;
		this.disposables.dispose();
	}

	private settle(): void {
		if (this.done) return;
		this.done = true;
		this.disposables.clear();
		if (!this.recordsEffect()) return;
		const model = this.editor.getModel();
		const spanStart = model.getPositionAt(this.span.start);
		const spanEnd = model.getPositionAt(this.span.end);
		const edit = diffInsertEdit({
			before: this.before,
			after: model.getValueInRange(Range.fromPositions(spanStart, spanEnd), EndOfLinePreference.LF),
			selectionBefore: this.selectionBefore,
			selectionAfter: offsetSelection(model, spanStart, this.selectionAfter),
			allowCursorOnly: this.isDeclinedCommand(snippetJumpCommands),
		});
		this.result = edit === undefined ? undefined : { key: this.options.key, edit, supersedesTyped: this.options.supersedesTyped };
	}

	private recordsEffect(): boolean {
		if (this.sawCompletionEdit) return true;
		if (this.options.supersedesTyped) return false;
		if (this.isDeclinedCommand(indentCommands) || this.isDeclinedCommand(snippetJumpCommands)) return true;
		return this.options.commandId === undefined && this.sawEdit && !this.sawNonTypingEdit;
	}

	private isDeclinedCommand(commands: ReadonlySet<string>): boolean {
		return !this.options.supersedesTyped && this.options.commandId !== undefined && commands.has(this.options.commandId);
	}

	private abandon(): void {
		this.done = true;
		this.disposables.clear();
		this.result = undefined;
	}
}

// [selection] as LF-normalized character offsets from [origin] (negative when
// before it), matching the core's "\n"-per-line-break offsets.
function offsetSelection(model: ITextModel, origin: IPosition, selection: Selection): OffsetSelection {
	const offset = (lineNumber: number, column: number) => {
		const position = { lineNumber, column };
		const length = model.getValueLengthInRange(Range.fromPositions(origin, position), EndOfLinePreference.LF);
		const isBefore = lineNumber < origin.lineNumber || (lineNumber === origin.lineNumber && column < origin.column);
		return isBefore ? -length : length;
	};
	return {
		anchor: offset(selection.selectionStartLineNumber, selection.selectionStartColumn),
		head: offset(selection.positionLineNumber, selection.positionColumn),
	};
}
