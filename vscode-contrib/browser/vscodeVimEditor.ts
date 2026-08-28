import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { diffInserted, editorFindMatchHighlight } from '../../../../platform/theme/common/colorRegistry.js';
import { registerThemingParticipant } from '../../../../platform/theme/common/themeService.js';
import { IActiveCodeEditor, ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { EnterOperation } from '../../../common/cursor/cursorTypeEditOperations.js';
import { CursorChangeReason } from '../../../common/cursorEvents.js';
import { Position as VSCodePosition } from '../../../common/core/position.js';
import { IRange, Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { IDecorationOptions, IEditorDecorationsCollection, ScrollType } from '../../../common/editorCommon.js';
import { EndOfLinePreference, IIdentifiedSingleEditOperation, IModelDeltaDecoration, ITextModel, InjectedTextCursorStops, PositionAffinity } from '../../../common/model.js';
import { EditSources } from '../../../common/textModelEditSource.js';
import { CommonFindController } from '../../find/browser/findController.js';
import { FindModelBoundToEditorModel } from '../../find/browser/findModel.js';
import { FindReplaceState } from '../../find/browser/findState.js';
import type { SubstitutePreview } from '../common/command.js';
import { ApplyEditsOptions, HostCommand, HostDirection, HostFoldCommand, HostRevealTarget, NativeCommandOptions, VimEditorCapabilities, VimUndoTransaction, insertTextForKey, normalCursorPosition, normalViewLineColumnForGoal } from '../common/editor.js';
import type { EasyMotionMarker } from '../common/editor.js';
import { LineTracker, TrackedLines } from '../common/line_tracker.js';
import { SearchDirection, SearchMatch, SearchMatchCount, SearchOptions, translateVimRegex } from '../common/search.js';
import { charwiseRenderCursor, lowerCharwiseGeometry, previousCharacterCell } from '../common/selection_geometry.js';
import { CursorStyle, TextEdit, TextRange, Position as VimPosition, VimSelection, VimSelectionGoal, charwiseSelection, comparePositions, selectionHead } from '../common/state.js';

type ExplicitSelectionEditor = ICodeEditor & {
	setSelections(selections: readonly Selection[], source?: string, reason?: CursorChangeReason): void;
};

type VSCodeUndoTransaction = {
	model: ITextModel;
	undoSelectionsBefore: Selection[];
	pushStackElement: ITextModel['pushStackElement'];
	pushEditOperations: ITextModel['pushEditOperations'];
	hasEdits: boolean;
};

// Easymotion label decorations are `setDecorationsByType` pseudo-element
// decorations (see [showEasyMotionMarkers]); this key groups them so a new
// marker set replaces the previous one and unused label subtypes are dropped.
// The per-label subtypes the widget registers resolve their *parent* type, so
// the parent key must be registered with the code editor service before the
// first [showEasyMotionMarkers] call — the controller owns that registration.
export const VimEasyMotionLabelDecorationTypeKey = 'vim-easymotion-marker';

registerThemingParticipant((theme, collector) => {
	// The label replaces the target text visually (VSCodeVim-style): the
	// character under the marker is hidden and the label pseudo-element (see
	// [showEasyMotionMarkers]) paints on the editor background over it.
	collector.addRule(`
		.monaco-editor .vim-easymotion-target {
			opacity: 0;
		}
	`);
	// Live `:s` preview: matches use the find-match highlight; once the
	// replacement section is typed the original is struck through and the
	// resolved replacement shows as injected text with an "inserted" tint
	// (VSCodeVim/Neovim 'inccommand'-style).
	// VSCodeVim `vim.highlightedyank.*`: the colors are user-configured strings,
	// applied per-flash as CSS variables on the editor container (see
	// [highlightYankedRanges]); the rule itself is static.
	collector.addRule(`
		.monaco-editor .vim-highlighted-yank {
			background-color: var(--vim-highlighted-yank-background, rgba(250, 240, 170, 0.5));
			color: var(--vim-highlighted-yank-foreground, inherit);
		}
	`);
	const findMatch = theme.getColor(editorFindMatchHighlight);
	const inserted = theme.getColor(diffInserted);
	collector.addRule(`
		.monaco-editor .vim-substitute-match {
			background-color: ${findMatch ?? 'rgba(234, 92, 0, 0.33)'};
		}
		.monaco-editor .vim-substitute-match-replaced {
			background-color: ${findMatch ?? 'rgba(234, 92, 0, 0.33)'};
			text-decoration: line-through;
			opacity: 0.6;
		}
		.monaco-editor .vim-substitute-replacement {
			background-color: ${inserted ?? 'rgba(155, 185, 85, 0.2)'};
		}
	`);
});

// Bounds the match-count scan; when reached ([capped]) the status bar shows a
// `? of 9999+` placeholder instead of exact numbers.
const MaxCountedSearchMatches = 10000;

/** Rendering options for the VSCodeVim `vim.highlightedyank.*` compatibility
    feature; undefined when the highlight is disabled. */
export type YankHighlightOptions = {
	color: string;
	textColor: string | undefined;
	durationMs: number;
};

export class VSCodeVimEditor implements VimEditorCapabilities {
	private readonly visualLineDecorations: IEditorDecorationsCollection;
	private readonly insertPendingDecorations: IEditorDecorationsCollection;
	private readonly easyMotionDecorations: IEditorDecorationsCollection;
	private readonly substitutePreviewDecorations: IEditorDecorationsCollection;
	private readonly yankHighlightDecorations: IEditorDecorationsCollection;
	private yankHighlightTimer: ReturnType<typeof setTimeout> | undefined;
	private lastSetVimSelections: readonly VimSelection[] | undefined;
	private lastSetVSCodeSelections: readonly Selection[] | undefined;
	private rememberedSelectionGoals = new Map<string, VimSelectionGoal>();
	private searchPreviewViewport: { scrollTop: number; scrollLeft: number } | undefined;
	private hiddenFindState: FindReplaceState | undefined;
	/** Set by the controller: reconcile Vim state after a [backgroundSync]
	    native command completes (see NativeCommandOptions.backgroundSync). */
	onBackgroundNativeCommandSync: (() => void) | undefined;
	private hiddenFindModel: FindModelBoundToEditorModel | undefined;
	private viewportControlledByCommand = false;
	private appliedCursorStyle: CursorStyle | undefined = undefined;
	private skipNextPrimaryReveal = false;
	private viewportRevealRequestId = 0;
	private nativeCommandInProgressDepth = 0;
	private readonly pendingNativeSelectionSyncs: Promise<void>[] = [];
	private vimEditInProgress = false;
	private undoTransaction: VSCodeUndoTransaction | undefined;
	private undoTransactionDepth = 0;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly commandService: ICommandService,
		private readonly logUndo: (message: string) => void = () => undefined,
		// The controller reads the live configuration; undefined disables the
		// yank highlight (the default).
		private readonly yankHighlightOptions: () => YankHighlightOptions | undefined = () => undefined
	) {
		this.visualLineDecorations = editor.createDecorationsCollection();
		this.insertPendingDecorations = editor.createDecorationsCollection();
		this.easyMotionDecorations = editor.createDecorationsCollection();
		this.substitutePreviewDecorations = editor.createDecorationsCollection();
		this.yankHighlightDecorations = editor.createDecorationsCollection();
	}

	lineCount(): number {
		return this.model().getLineCount();
	}

	line(row: number): string {
		return this.model().getLineContent(row + 1);
	}

	lineLength(row: number): number {
		return this.model().getLineLength(row + 1);
	}

	getText(range?: TextRange): string {
		// The Vim core requires 1-character `\n` line separators (see
		// [VimEditorCapabilities.getText]): its position<->offset conversions
		// count `lineLength(row) + 1` per line, so returning a CRLF document
		// verbatim would shift every computed offset by one per preceding line
		// (e.g. `iw` selecting the wrong span). Inserted text flows back through
		// `pushEditOperations`, which normalizes `\n` to the buffer EOL.
		const model = this.model();
		if (!range) {
			return model.getValue(EndOfLinePreference.LF);
		}
		return model.getValueInRange(toRange(range), EndOfLinePreference.LF);
	}

	documentVersion(): number {
		// O(1), unlike materializing the document text. The alternative version
		// id returns to its previous value on undo, so equal values guarantee
		// unchanged content.
		return this.model().getAlternativeVersionId();
	}

	getSelections(): readonly VimSelection[] {
		const selections = this.editor.getSelections() ?? [];
		// VSCode-specific adapter behavior, not a Zed concept: Zed owns the editor
		// selection state while Vim is active, but in VSCode native selections can be
		// changed outside Vim by mouse selection, undo/redo recovery, multicursor
		// commands, or other editor contributions. When the native selections still
		// match what Vim last lowered, return the cached semantic VimSelection so
		// Vim-only metadata such as blockwise state, visual cursor, and goal columns
		// survives the round trip. Otherwise, treat VSCode as authoritative and
		// rebuild plain charwise Vim selections from the current editor state.
		if (this.lastSetVimSelections !== undefined && this.selectionsMatchLastSet(selections)) {
			return this.lastSetVimSelections;
		}
		if (selections.length === 0) {
			return [charwiseSelection({ row: 0, column: 0 })];
		}
		const rebuilt = selections.map(selection => {
			const head = {
				row: selection.positionLineNumber - 1,
				column: selection.positionColumn - 1,
			};
			const rebuiltSelection = {
				type: 'charwise' as const,
				anchor: {
					row: selection.selectionStartLineNumber - 1,
					column: selection.selectionStartColumn - 1,
				},
				head,
			};
			const goal = this.rememberedSelectionGoals.get(positionKey(head));
			return goal === undefined ? rebuiltSelection : { ...rebuiltSelection, goal };
		});
		return rebuilt;
	}

	setSelections(selections: readonly VimSelection[]): void {
		const lowered = this.lowerSelections(selections);
		const source = lowered.cursorPositions.length > 0
			? `vim.cursorPositions:${lowered.cursorPositions.map(position => `${position.lineNumber},${position.column}`).join(';')}`
			: 'vim';
		this.updateVisualLineDecorations(selections);
		this.rememberSelections(selections, lowered.selections);
		(this.editor as ExplicitSelectionEditor).setSelections(lowered.selections, source, CursorChangeReason.Explicit);
	}

	isReadonly(): boolean {
		return this.editor.getOption(EditorOption.readOnly);
	}

	setCursorStyle(style: CursorStyle): void {
		// `updateOptions` is not free (it can recompute scroll state), so skip
		// the call when the style is unchanged.
		if (this.appliedCursorStyle === style) {
			return;
		}
		this.appliedCursorStyle = style;
		this.editor.updateOptions({
			cursorStyle: style === 'line' ? 'line'
				: style === 'block' ? 'block'
					: style === 'half-block' ? 'half-block'
						: 'underline',
		});
	}

	/** The controller restores the user's native cursor options directly when
	    Vim is disabled; forget the last applied style so re-enabling applies. */
	clearAppliedCursorStyle(): void {
		this.appliedCursorStyle = undefined;
	}

	setInsertPendingText(text: string | undefined): void {
		if (text === undefined || text.length === 0 || !this.editor.hasModel()) {
			this.insertPendingDecorations.clear();
			return;
		}
		const decorations: IModelDeltaDecoration[] = (this.editor.getSelections() ?? []).map(selection => {
			const position = selection.getPosition();
			return {
				range: Range.fromPositions(position),
				options: {
					description: 'vim-insert-pending-text',
					after: {
						content: text,
						inlineClassName: 'ghost-text-decoration',
						cursorStops: InjectedTextCursorStops.Left,
					},
					showIfCollapsed: true,
				},
			};
		});
		this.insertPendingDecorations.set(decorations);
	}

	showEasyMotionMarkers(markers: readonly EasyMotionMarker[]): void {
		if (!this.editor.hasModel()) {
			this.clearEasyMotionMarkers();
			return;
		}
		const model = this.model();
		// The label must NOT be injected text: injected text occupies columns in
		// the view line's character mapping, and the monospace fast path computes
		// x-offsets arithmetically from that mapping — a zero-width (absolutely
		// positioned) injected label therefore shifted the cursor right by the
		// label width for every marker before it on the same line (and the block
		// cursor painted a duplicate of its character there). Instead the label
		// is a CSS `::before` pseudo-element (`setDecorationsByType`, the same
		// mechanism VSCodeVim's easymotion decorations use), which the character
		// mapping never sees; the pseudo-element leaves the layout flow via
		// VSCodeVim's margin recipe below, so the real text does not shift
		// either. The character under the marker is hidden with a pure CSS class
		// (`.vim-easymotion-target`), which also has no layout effect.
		const hideDecorations: IModelDeltaDecoration[] = [];
		const labelDecorations: IDecorationOptions[] = [];
		for (const marker of markers) {
			const lineNumber = marker.position.row + 1;
			const column = marker.position.column + 1;
			// The label is a transparent overlay: hide as many characters as the
			// label covers so a multi-character label does not overlap visible
			// text; at end-of-line there may be fewer (or no) characters to hide.
			const endColumn = Math.min(column + marker.label.length, model.getLineMaxColumn(lineNumber));
			if (endColumn > column) {
				hideDecorations.push({
					range: new Range(lineNumber, column, lineNumber, endColumn),
					options: {
						description: 'vim-easymotion-target',
						inlineClassName: 'vim-easymotion-target',
					},
				});
			}
			labelDecorations.push({
				range: new Range(lineNumber, column, lineNumber, column),
				renderOptions: {
					before: {
						contentText: marker.label,
						color: '#ff0000',
						fontWeight: 'bold',
						height: '100%',
						// VSCodeVim's recipe (easymotion.ts `firstCharRenderOptions`):
						// the decoration API has no fields for positioning, so the
						// margin value carries the extra properties into the generated
						// rule. `position: absolute` takes the label out of the layout
						// flow, drawing it over the hidden characters without a
						// backing box.
						margin: `0 -1ch 0 0;
						position: absolute;
						z-index: 10;
						width: max-content;
						font-style: normal;`,
					},
				},
			});
		}
		this.easyMotionDecorations.set(hideDecorations);
		this.editor.setDecorationsByType('vim-easymotion-marker', VimEasyMotionLabelDecorationTypeKey, labelDecorations);
	}

	clearEasyMotionMarkers(): void {
		this.easyMotionDecorations.clear();
		this.editor.removeDecorationsByType(VimEasyMotionLabelDecorationTypeKey);
	}

	// VSCodeVim `highlightedyank` (`BaseOperator.highlightYankedRanges`): flash
	// the yanked ranges for the configured duration. A new yank replaces any
	// still-visible flash and restarts the timer.
	highlightYankedRanges(ranges: readonly TextRange[]): void {
		const options = this.yankHighlightOptions();
		if (options === undefined || ranges.length === 0 || !this.editor.hasModel()) {
			return;
		}
		const containerStyle = this.editor.getContainerDomNode().style;
		containerStyle.setProperty('--vim-highlighted-yank-background', options.color);
		if (options.textColor !== undefined) {
			containerStyle.setProperty('--vim-highlighted-yank-foreground', options.textColor);
		} else {
			containerStyle.removeProperty('--vim-highlighted-yank-foreground');
		}
		this.yankHighlightDecorations.set(ranges.map(range => ({
			range: toRange(range),
			options: {
				description: 'vim-highlighted-yank',
				inlineClassName: 'vim-highlighted-yank',
			},
		})));
		if (this.yankHighlightTimer !== undefined) {
			clearTimeout(this.yankHighlightTimer);
		}
		this.yankHighlightTimer = setTimeout(() => {
			this.yankHighlightTimer = undefined;
			this.yankHighlightDecorations.clear();
		}, options.durationMs);
	}

	updateSubstitutePreview(previews: readonly SubstitutePreview[]): void {
		if (!this.editor.hasModel()) {
			this.substitutePreviewDecorations.clear();
			return;
		}
		const decorations: IModelDeltaDecoration[] = previews.map(preview => {
			const range = new Range(
				preview.range.start.row + 1,
				preview.range.start.column + 1,
				preview.range.end.row + 1,
				preview.range.end.column + 1,
			);
			if (preview.replacement === undefined) {
				return {
					range,
					options: {
						description: 'vim-substitute-preview',
						inlineClassName: 'vim-substitute-match',
						showIfCollapsed: true,
					},
				};
			}
			return {
				range,
				options: {
					description: 'vim-substitute-preview',
					inlineClassName: 'vim-substitute-match-replaced',
					showIfCollapsed: true,
					...(preview.replacement.length > 0
						? {
							after: {
								// Injected text must stay single-line; a `\r`
								// replacement renders its break as a return symbol.
								content: preview.replacement.replace(/\n/g, '\u23ce'),
								inlineClassName: 'vim-substitute-replacement',
								cursorStops: InjectedTextCursorStops.None,
							},
						}
						: {}),
				},
			};
		});
		this.substitutePreviewDecorations.set(decorations);
	}

	clearSubstitutePreview(): void {
		this.substitutePreviewDecorations.clear();
	}

	beginUndoTransaction(selectionsBefore: readonly VimSelection[]): VimUndoTransaction {
		this.logUndo(`beginUndoTransaction open=${this.isUndoTransactionOpen()} depth=${this.undoTransactionDepth} before=${formatVimSelections(selectionsBefore)} native=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
		if (this.undoTransactionDepth === 0) {
			this.editor.pushUndoStop();
			this.openUndoTransaction(this.model(), this.lowerSelections(selectionsBefore).selections, { hasEdits: false });
		}
		this.undoTransactionDepth++;
		let finished = false;
		return {
			finish: (selectionsAfter?: readonly VimSelection[]) => {
				if (finished) return;
				finished = true;
				this.finishUndoTransaction(selectionsAfter);
			},
		};
	}

	// Reproduce VSCode's default insert-mode handling for a passthrough key on the
	// replay path (dot-repeat / macros) — there is no real keydown to let through,
	// so drive the editor's own commands: printable text via the `type` command
	// (VSCode's typed-input entry point, so auto-indent / auto-closing / on-type
	// formatting fire), and the whitelisted editing/navigation keys via the
	// corresponding synchronous core editor commands (their default bindings).
	// Using the `keyboard` source makes VSCode coalesce a replayed run into one
	// undo unit, matching live typing. Deterministic by design: replay drives the
	// *default* editing behavior rather than re-resolving keybindings at replay
	// time (honoring user rebindings via the keybinding service is a possible
	// follow-up).
	replayInsertKey(key: string): void {
		const command = insertReplayCommands[key];
		if (command !== undefined) {
			this.editor.trigger('keyboard', command, null);
			return;
		}
		const text = insertTextForKey(key);
		if (text === undefined) {
			return;
		}
		this.editor.trigger('keyboard', 'type', { text });
	}

	// Vim `o`/`O`: run VSCode's Insert Line Below/Above semantics (the same
	// [EnterOperation] the `editor.action.insertLine{After,Before}` actions
	// execute), so the new line gets language-aware auto-indentation and the
	// inserted whitespace registers as auto-whitespace, which VSCode trims
	// again when the line is abandoned without typing. Unlike the native
	// actions this pushes no undo stop: the opened line belongs to the insert
	// session's undo unit (`o` + typed text undo as one). The 'vim' command
	// source keeps the controller's selection listener from reacting to the
	// cursor move.
	openLineNatively({ above }: { above: boolean }): boolean {
		const viewModel = this.editor._getViewModel();
		if (!viewModel || !this.editor.hasModel()) {
			return false;
		}
		// [executeCommands] mutates the view model without the read-only check
		// that [executeEdits] performs (the native insertLine actions rely on
		// their `writable` precondition instead, which this path bypasses).
		// Decline so the model-buffer fallback runs: its edit is rejected by
		// [executeEdits], leaving the buffer untouched while Vim's read-only
		// handling bounces insert mode back to normal.
		if (this.isReadonly()) {
			return false;
		}
		const commands = above
			? EnterOperation.lineInsertBefore(viewModel.cursorConfig, this.editor.getModel(), this.editor.getSelections())
			: EnterOperation.lineInsertAfter(viewModel.cursorConfig, this.editor.getModel(), this.editor.getSelections());
		this.logUndo(`openLineNatively above=${above} open=${this.isUndoTransactionOpen()} nativeBefore=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
		this.withVimEditInProgress(() => {
			this.editor.executeCommands('vim', commands);
		});
		this.invalidateCachedSelections();
		this.logUndo(`openLineNatively end native=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
		return true;
	}

	applyEdits(edits: readonly TextEdit[], selectionsAfter: readonly VimSelection[], options: ApplyEditsOptions = {}): void {
		this.logUndo(`applyEdits start edits=${edits.length} open=${this.isUndoTransactionOpen()} stopBefore=${options.undoStopBefore !== false} stopAfter=${options.undoStopAfter !== false} nativeBefore=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
		if (options.undoStopBefore !== false && !this.isUndoTransactionOpen()) this.editor.pushUndoStop();
		const vscodeEdits: IIdentifiedSingleEditOperation[] = edits.map(edit => ({
			range: toRange(edit.range),
			text: edit.text,
		}));
		const loweredLiveAfter = this.lowerSelections(selectionsAfter);
		this.logUndo(`applyEdits states liveAfter=${formatVimSelections(selectionsAfter)}`);

		this.updateVisualLineDecorations(selectionsAfter);
		this.rememberSelections(selectionsAfter, loweredLiveAfter.selections);
		this.withVimEditInProgress(() => {
			this.editor.executeEdits('vim', vscodeEdits, loweredLiveAfter.selections);
			this.logUndo(`executeEdits nativeAfter=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
		});
		if (options.undoStopAfter !== false) {
			if (!this.isUndoTransactionOpen()) this.editor.pushUndoStop();
		}
		this.logUndo(`applyEdits end open=${this.isUndoTransactionOpen()} native=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
	}

	trackLines(rows: readonly number[]): TrackedLines {
		const tracker = new LineTracker(rows);
		// Track through model content events rather than [applyEdits]: replayed
		// insert-mode keys edit through native commands (see [replayInsertKey]),
		// and the event's change ranges are pre-change coordinates like the
		// tracker expects. Changes within one event are sorted end-to-start, so
		// sequential application never invalidates a later change's range.
		const subscription = this.editor.onDidChangeModelContent(event => {
			for (const change of event.changes) {
				tracker.applyChange({ range: fromRange(change.range), text: change.text });
			}
		});
		return {
			currentRow: index => tracker.currentRow(index),
			dispose: () => subscription.dispose(),
		};
	}

	finishUndoTransaction(selectionsAfter?: readonly VimSelection[]): void {
		this.logUndo(`finishUndoTransaction start open=${this.isUndoTransactionOpen()} depth=${this.undoTransactionDepth} selectionsAfter=${formatVimSelections(selectionsAfter)} nativeBefore=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
		const transaction = this.undoTransaction;
		if (transaction !== undefined && transaction.hasEdits && selectionsAfter !== undefined) {
			const lowered = this.lowerSelections(selectionsAfter);
			this.updateVisualLineDecorations(selectionsAfter);
			this.rememberSelections(selectionsAfter, lowered.selections);
			this.withVimEditInProgress(() => {
				this.applyModelEdits([], this.editor.getSelections() ?? [], lowered.selections);
			});
		}
		if (this.undoTransactionDepth > 0) {
			this.undoTransactionDepth--;
			if (this.undoTransactionDepth > 0) {
				this.logUndo(`finishUndoTransaction deferred depth=${this.undoTransactionDepth}`);
				return;
			}
		}
		if (transaction === undefined) this.editor.pushUndoStop();
		else this.closeUndoTransaction({ pushUndoStop: transaction.hasEdits });
		this.logUndo(`finishUndoTransaction end native=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
	}

	flushUndoTransaction(): void {
		this.logUndo(`flushUndoTransaction open=${this.isUndoTransactionOpen()} depth=${this.undoTransactionDepth} native=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
		this.undoTransactionDepth = 0;
		const transaction = this.undoTransaction;
		if (transaction !== undefined) this.closeUndoTransaction({ pushUndoStop: transaction.hasEdits });
	}

	executeHostCommand(command: HostCommand): void {
		this.invalidateCachedSelections();
		switch (command) {
			case 'navigateBack':
				this.commandService.executeCommand('workbench.action.navigateBack');
				return;
			case 'navigateForward':
				this.commandService.executeCommand('workbench.action.navigateForward');
				return;
			case 'undo':
				this.logUndo(`executeHostCommand undo nativeBefore=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
				this.editor.trigger('vim', 'undo', null);
				this.logUndo(`executeHostCommand undo nativeAfterTrigger=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
				return;
			case 'redo':
				this.logUndo(`executeHostCommand redo nativeBefore=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
				this.editor.trigger('vim', 'redo', null);
				this.logUndo(`executeHostCommand redo nativeAfterTrigger=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
				return;
		}
	}

	executeNativeCommand(command: string, args: readonly unknown[] = [], options: NativeCommandOptions = {}): void | Promise<void> {
		const syncSelectionAfter = options.syncSelectionAfter === true || command === 'undo' || command === 'redo';
		const selectionsToRestore = options.preserveVisualSelection === true
			? visualSemanticSelections(this.lastSetVimSelections)
			: undefined;
		this.nativeCommandInProgressDepth++;
		const commandPromise = (async () => {
			try {
				await this.commandService.executeCommand(command, ...args);
				// [onResolved] runs strictly after the command *completes*
				// (`:wq` must not close while the save is still in flight), and
				// not at all when it fails — a failed save must never take the
				// editor down with it. Awaiting extends the command's own
				// promise over the callback's async work, so the in-progress
				// bookkeeping, [syncSelectionAfter], and the cleanup below stay
				// correct for asynchronous callbacks too.
				await options.onResolved?.();
			} finally {
				this.nativeCommandInProgressDepth = Math.max(0, this.nativeCommandInProgressDepth - 1);
				if (selectionsToRestore !== undefined) {
					this.setSelections(selectionsToRestore);
				}
				if (options.selectionsAfter !== undefined) {
					this.setSelections(options.selectionsAfter);
				}
			}
		})();
		if (syncSelectionAfter) {
			this.pendingNativeSelectionSyncs.push(commandPromise.then(() => undefined, () => undefined));
		}
		if (options.backgroundSync === true) {
			void commandPromise.then(() => this.onBackgroundNativeCommandSync?.(), () => undefined);
		}
		void commandPromise.then(undefined, () => undefined);
		return syncSelectionAfter ? commandPromise : undefined;
	}

	async waitForNativeSelectionSync(): Promise<boolean> {
		if (this.pendingNativeSelectionSyncs.length === 0) {
			return false;
		}
		const pending = this.pendingNativeSelectionSyncs.splice(0);
		await Promise.all(pending);
		return true;
	}

	isExecutingNativeCommand(): boolean {
		return this.nativeCommandInProgressDepth > 0 || this.vimEditInProgress;
	}

	revealPrimaryCursorIfOutsideViewport(): void {
		if (this.skipNextPrimaryReveal) {
			this.skipNextPrimaryReveal = false;
			return;
		}
		if (this.viewportControlledByCommand) {
			this.viewportControlledByCommand = false;
			return;
		}

		const position = this.editor.getPosition();
		if (position === null) {
			return;
		}

		const layoutInfo = this.editor.getLayoutInfo();
		const scrollTop = this.editor.getScrollTop();
		const viewportHeight = layoutInfo.height;
		const bandTop = scrollTop + viewportHeight * 0.15;
		const bandBottom = scrollTop + viewportHeight * 0.85;
		const cursorTop = this.editor.getTopForLineNumber(position.lineNumber);
		const cursorBottom = this.editor.getBottomForLineNumber(position.lineNumber);
		let targetScrollTop: number | undefined;
		if (cursorTop < bandTop) {
			targetScrollTop = scrollTop - (bandTop - cursorTop);
		} else if (cursorBottom > bandBottom) {
			targetScrollTop = scrollTop + (cursorBottom - bandBottom);
		}

		const scrollLeft = this.editor.getScrollLeft();
		const viewportWidth = Math.max(0, layoutInfo.contentWidth - layoutInfo.verticalScrollbarWidth);
		let targetScrollLeft: number | undefined;
		if (viewportWidth > 0) {
			const maxColumn = this.model().getLineMaxColumn(position.lineNumber);
			const nextColumn = Math.min(position.column + 1, maxColumn);
			const cursorLeft = this.editor.getOffsetForColumn(position.lineNumber, position.column);
			const cursorRight = nextColumn > position.column
				? this.editor.getOffsetForColumn(position.lineNumber, nextColumn)
				: cursorLeft + this.editor.getOption(EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
			const bandLeft = scrollLeft + viewportWidth * 0.15;
			const bandRight = scrollLeft + viewportWidth * 0.85;
			if (cursorLeft < bandLeft) {
				targetScrollLeft = Math.max(0, scrollLeft - (bandLeft - cursorLeft));
			} else if (cursorRight > bandRight) {
				targetScrollLeft = Math.max(0, scrollLeft + (cursorRight - bandRight));
			}
		}

		if (targetScrollTop !== undefined || targetScrollLeft !== undefined) {
			this.scheduleViewportReveal({ scrollTop: targetScrollTop, scrollLeft: targetScrollLeft });
		}
	}

	revealRange(range: TextRange): void {
		const scrollTop = this.editor.getScrollTop();
		const viewportHeight = this.editor.getLayoutInfo().height;
		const viewportBottom = scrollTop + viewportHeight;
		const rangeTop = this.editor.getTopForPosition(range.start.row + 1, range.start.column + 1);
		const rangeBottom = this.editor.getBottomForLineNumber(range.end.row + 1);

		if (rangeTop < scrollTop) {
			this.scheduleViewportReveal({ scrollTop: rangeTop });
		} else if (rangeBottom > viewportBottom) {
			this.scheduleViewportReveal({ scrollTop: scrollTop + (rangeBottom - viewportBottom) });
		}
	}

	beginSearchPreview(): void {
		if (this.searchPreviewViewport !== undefined) {
			return;
		}
		this.searchPreviewViewport = {
			scrollTop: this.editor.getScrollTop(),
			scrollLeft: this.editor.getScrollLeft(),
		};
	}

	endSearchPreview({ restoreViewport = false }: { restoreViewport?: boolean } = {}): void {
		const viewport = this.searchPreviewViewport;
		this.searchPreviewViewport = undefined;
		if (restoreViewport && viewport !== undefined) {
			this.editor.setScrollPosition(viewport, ScrollType.Immediate);
			this.skipNextPrimaryReveal = true;
		}
	}

	private scheduleViewportAction(action: () => void): void {
		const requestId = ++this.viewportRevealRequestId;
		// Defer until after VSCode has finished processing this key event and Vim's
		// post-key sync. Applying viewport changes earlier can be overwritten by
		// editor scroll stabilization, especially for visual selections and diff
		// editors with synchronized scrolling.
		setTimeout(() => {
			if (requestId === this.viewportRevealRequestId) action();
		}, 0);
	}

	private scheduleViewportReveal(position: { scrollTop?: number; scrollLeft?: number }): void {
		this.scheduleViewportAction(() => this.editor.setScrollPosition(position, this.editorScrollType()));
	}

	private editorScrollType(): ScrollType {
		return this.editor.getOption(EditorOption.smoothScrolling) ? ScrollType.Smooth : ScrollType.Immediate;
	}

	revealCurrentLine(target: HostRevealTarget): void {
		this.viewportControlledByCommand = true;
		const position = this.editor.getPosition();
		if (position === null) {
			return;
		}
		this.scheduleViewportAction(() => {
			this.editor.trigger('vim', 'revealLine', {
				lineNumber: position.lineNumber - 1,
				at: target,
			});
		});
	}

	executeFoldCommand(command: HostFoldCommand): void {
		this.invalidateCachedSelections();
		this.editor.trigger('vim', foldCommandId(command), null);
	}

	moveByViewLines(direction: HostDirection, count: number, { displayLine, extend }: { displayLine: boolean; extend: boolean }): readonly VimSelection[] {
		// This is a pure query over VSCode's internal view model. Logical-line
		// movement (`j`/`k`) uses hidden model ranges so it skips closed folds but
		// does not stop on soft-wrapped segments. Display-line movement (`gj`/`gk`)
		// instead walks view lines. This mirrors VSCode's CursorMove units
		// `foldedLine` and `wrappedLine` without moving the live cursor mid-dispatch.
		const before = this.getSelections();
		const viewModel = this.editor._getViewModel();
		if (viewModel === null) {
			return before;
		}
		const converter = viewModel.coordinatesConverter;
		const lineCount = viewModel.model.getLineCount();
		const hiddenAreas = viewModel.getHiddenAreas();
		const result = before.map(selection => {
			const head = selection.cursor ?? selectionHead(selection);
			const modelPosition = new VSCodePosition(head.row + 1, head.column + 1);
			const viewPosition = converter.convertModelPositionToViewPosition(modelPosition, PositionAffinity.None, false, direction === 'down');
			let goal: VimSelectionGoal;
			let targetPosition: VimPosition;
			if (displayLine) {
				const rawViewLine = viewPosition.lineNumber + (direction === 'down' ? count : -count);
				const viewLine = Math.max(1, Math.min(rawViewLine, viewModel.getLineCount()));
				goal = viewGoalForSelection(selection.goal, viewPosition);
				const viewColumn = normalViewLineColumnForGoal(goal, {
					minColumn: viewModel.getLineMinColumn(viewLine),
					maxColumn: viewModel.getLineMaxColumn(viewLine),
				});
				const target = converter.convertViewPositionToModelPosition(new VSCodePosition(viewLine, viewColumn));
				const targetLineNumber = Math.max(1, Math.min(target.lineNumber, lineCount));
				const targetColumn = Math.max(1, Math.min(target.column, viewModel.model.getLineMaxColumn(targetLineNumber)));
				targetPosition = { row: targetLineNumber - 1, column: targetColumn - 1 };
			} else {
				goal = modelGoalForSelection(selection.goal, head);
				const targetLineNumber = foldedLineTarget(head.row + 1, direction, count, hiddenAreas, lineCount);
				const maxColumn = Math.max(1, viewModel.model.getLineMaxColumn(targetLineNumber) - 1);
				const targetColumn = modelColumnForGoal(goal, maxColumn);
				targetPosition = { row: targetLineNumber - 1, column: targetColumn - 1 };
			}
			if (extend) {
				switch (selection.type) {
					case 'charwise':
						return extendCharwiseSelection(this, selection, targetPosition, goal);
					case 'linewise':
						return { ...selection, headLine: targetPosition.row, cursor: targetPosition, goal };
					case 'blockwise':
						return { ...selection, head: targetPosition, cursor: targetPosition, goal };
				}
			}
			// VSCode model positions are between characters and can point one column
			// past the final character. Normal Vim cursors live on a character, except
			// on empty lines, so clip host movement results back to Vim-normal shape.
			return { ...charwiseSelection(normalCursorPosition(this, targetPosition)), goal };
		});
		return result;
	}

	moveByPages(direction: HostDirection, count: number, { halfPage, extend }: { halfPage: boolean; extend: boolean }): readonly VimSelection[] {
		const viewModel = this.editor._getViewModel();
		const visibleRange = viewModel?.getCompletelyVisibleViewRange();
		const visibleLineCount = visibleRange === undefined
			? 1
			: Math.max(1, visibleRange.endLineNumber - visibleRange.startLineNumber + 1);
		const pageLineCount = halfPage ? Math.max(1, Math.round(visibleLineCount / 2)) : visibleLineCount;
		return this.moveByViewLines(direction, pageLineCount * count, { displayLine: true, extend });
	}

	rulerColumns(): readonly number[] {
		// `editor.rulers` resolved for this editor (per-language overrides
		// included); entries are numbers or `{ column, color }` objects.
		return this.editor.getOption(EditorOption.rulers).map(ruler => ruler.column);
	}

	indentWidth(): number {
		// The model's resolved indent size (`editor.indentSize` /
		// auto-detected indentation), so Vim shifts match the editor's own
		// indent commands.
		return this.model().getOptions().indentSize;
	}

	visibleRowRange(): { top: number; bottom: number } | undefined {
		// Vim `H`/`M`/`L` target the visible window. Convert the completely
		// visible view range back to model rows so soft wraps and folds use the
		// same coordinates as native cursor movement.
		const viewModel = this.editor._getViewModel();
		const visibleRange = viewModel?.getCompletelyVisibleViewRange();
		if (viewModel === null || visibleRange === undefined) {
			return undefined;
		}
		const converter = viewModel.coordinatesConverter;
		const top = converter.convertViewPositionToModelPosition(new VSCodePosition(visibleRange.startLineNumber, 1));
		const bottom = converter.convertViewPositionToModelPosition(new VSCodePosition(visibleRange.endLineNumber, 1));
		return { top: top.lineNumber - 1, bottom: bottom.lineNumber - 1 };
	}

	scrollByLines(direction: HostDirection, count: number, { extend: _extend = false }: { extend?: boolean } = {}): void {
		this.viewportControlledByCommand = true;
		const lineHeight = this.editor.getOption(EditorOption.fontInfo).lineHeight;
		const delta = count * lineHeight * (direction === 'down' ? 1 : -1);
		// VSCode's `editorScroll` computes every smooth-scroll target from the
		// animation's current intermediate position. Under key repeat that keeps
		// retargeting only one line ahead, whereas j/k advances a full line per
		// key. Accumulate from the pending animation's final target instead.
		const scrollTop = this.editor._getViewModel()?.viewLayout.getFutureViewport().top
			?? this.editor.getScrollTop();
		this.editor.setScrollPosition(
			{ scrollTop: Math.max(0, scrollTop + delta) },
			this.editorScrollType(),
		);
	}

	updateSearch(query: string, _direction: SearchDirection, options: SearchOptions = {}): void {
		if (query.length === 0 || !this.editor.hasModel()) {
			this.clearSearchHighlights();
			return;
		}

		this.closeNativeFindWidget();

		const hiddenFindState = this.ensureHiddenFindState();
		// Vim-pattern conveniences (`\<`, `\>`, `\c`, `\C`) are translated to
		// plain JS regex before the host's find engine sees the pattern; the
		// case force is already folded into [options.caseSensitive].
		const searchString = options.regex === true ? translateVimRegex(query).source : query;
		hiddenFindState.change({
			searchString,
			isRegex: options.regex ?? false,
			wholeWord: options.wholeWord ?? false,
			matchCase: options.caseSensitive ?? true,
			loop: true,
			isRevealed: false,
			isReplaceRevealed: false,
			searchScope: null,
		}, false);
	}

	private ensureHiddenFindState(): FindReplaceState {
		if (this.hiddenFindState === undefined) {
			this.hiddenFindState = new FindReplaceState();
		}
		if (this.hiddenFindModel === undefined) {
			this.hiddenFindModel = new FindModelBoundToEditorModel(this.editor as IActiveCodeEditor, this.hiddenFindState);
		}
		return this.hiddenFindState;
	}

	findSearchMatch(rawQuery: string, start: VimPosition, direction: SearchDirection, options: SearchOptions = {}): SearchMatch | undefined {
		if (rawQuery.length === 0) {
			return undefined;
		}
		const query = options.regex === true ? translateVimRegex(rawQuery).source : rawQuery;
		const model = this.model();
		const wordSeparators = options.wholeWord === true ? this.editor.getOption(EditorOption.wordSeparators) : null;
		if (options.includeStart === true) {
			const containingMatch = findContainingSearchMatch(model, query, start, options, wordSeparators);
			if (containingMatch !== undefined) {
				return containingMatch;
			}
		}
		const startPosition = searchStartPosition(model, start, direction, options);
		const match = direction === 'forward'
			? model.findNextMatch(query, startPosition, options.regex ?? false, options.caseSensitive ?? true, wordSeparators, false)
			: model.findPreviousMatch(query, startPosition, options.regex ?? false, options.caseSensitive ?? true, wordSeparators, false);
		return match === null ? undefined : fromRange(match.range);
	}

	searchMatchCount(rawQuery: string, matchStart: VimPosition, options: SearchOptions = {}): SearchMatchCount | undefined {
		if (rawQuery.length === 0) {
			return undefined;
		}
		const query = options.regex === true ? translateVimRegex(rawQuery).source : rawQuery;
		const model = this.model();
		const wordSeparators = options.wholeWord === true ? this.editor.getOption(EditorOption.wordSeparators) : null;
		const limit = MaxCountedSearchMatches;
		const matches = model.findMatches(query, false, options.regex ?? false, options.caseSensitive ?? true, wordSeparators, false, limit);
		if (matches.length === 0) {
			return undefined;
		}
		const target = new VSCodePosition(matchStart.row + 1, matchStart.column + 1);
		const index = matches.findIndex(match => target.isBeforeOrEqual(match.range.getStartPosition()));
		return {
			index: (index < 0 ? matches.length - 1 : index) + 1,
			total: matches.length,
			capped: matches.length >= limit,
		};
	}

	clearSearchHighlights(): void {
		this.hiddenFindModel?.dispose();
		this.hiddenFindModel = undefined;
		this.hiddenFindState?.dispose();
		this.hiddenFindState = undefined;
		this.closeNativeFindWidget();
	}

	private closeNativeFindWidget(): void {
		const controller = CommonFindController.get(this.editor);
		if (controller?.getState().isRevealed === true) {
			controller.closeFindWidget();
		}
	}

	dispose(): void {
		this.setInsertPendingText(undefined);
		this.clearEasyMotionMarkers();
		this.clearSearchHighlights();
		this.detachFromModel();
	}

	detachFromModel(): void {
		this.endSearchPreview({ restoreViewport: false });
		this.clearSearchHighlights();
		this.setInsertPendingText(undefined);
		this.clearEasyMotionMarkers();
		if (this.yankHighlightTimer !== undefined) {
			clearTimeout(this.yankHighlightTimer);
			this.yankHighlightTimer = undefined;
		}
		this.yankHighlightDecorations.clear();
		this.closeUndoTransaction({ pushUndoStop: false });
		this.invalidateCachedSelections();
		this.rememberedSelectionGoals.clear();
	}

	invalidateCachedSelections(): void {
		this.lastSetVimSelections = undefined;
		this.lastSetVSCodeSelections = undefined;
		this.visualLineDecorations.clear();
	}

	private isUndoTransactionOpen(): boolean {
		return this.undoTransaction !== undefined;
	}

	// VSCode typing/paste commands call [pushStackElement] themselves and record
	// cursor state from the live editor selections. During Vim-owned insert
	// transactions (notably visual-block insert), live selections can be transient
	// multicursors while Vim undo should restore a single normal-mode cursor.  Keep
	// the patch scoped to one model and one open Vim transaction: suppress native
	// checkpoints so native typing/paste appends to Vim's undo element, and replace
	// the before-cursor state only for the first real edit in the transaction.
	private openUndoTransaction(model: ITextModel, undoSelectionsBefore: Selection[], { hasEdits }: { hasEdits: boolean }): void {
		if (this.undoTransaction?.model === model) return;
		this.closeUndoTransaction({ pushUndoStop: false });
		const pushStackElement = model.pushStackElement.bind(model) as ITextModel['pushStackElement'];
		const pushEditOperations = model.pushEditOperations.bind(model) as ITextModel['pushEditOperations'];
		this.undoTransaction = { model, undoSelectionsBefore, pushStackElement, pushEditOperations, hasEdits };
		model.pushStackElement = (() => {
			if (this.undoTransaction?.model === model) {
				this.logUndo('suppressed native pushStackElement during Vim undo transaction');
				return;
			}
			pushStackElement();
		}) as ITextModel['pushStackElement'];
		model.pushEditOperations = ((...args: Parameters<ITextModel['pushEditOperations']>) => {
			const [beforeCursorState, editOperations, cursorStateComputer, group, reason] = args;
			const transaction = this.undoTransaction;
			if (transaction === undefined || transaction.model !== model) {
				return pushEditOperations(beforeCursorState, editOperations, cursorStateComputer, group, reason);
			}
			const before = transaction.hasEdits ? beforeCursorState : transaction.undoSelectionsBefore;
			if (editOperations.length > 0) transaction.hasEdits = true;
			this.logUndo(`pushEditOperations(transaction) edits=${editOperations.length} before=${formatVSCodeSelections(before ?? [])}`);
			return pushEditOperations(before, editOperations, cursorStateComputer, group, reason);
		}) as ITextModel['pushEditOperations'];
	}

	private closeUndoTransaction({ pushUndoStop }: { pushUndoStop: boolean }): void {
		const transaction = this.undoTransaction;
		if (transaction === undefined) return;
		transaction.model.pushStackElement = transaction.pushStackElement;
		transaction.model.pushEditOperations = transaction.pushEditOperations;
		this.undoTransaction = undefined;
		if (pushUndoStop) this.editor.pushUndoStop();
	}

	private applyModelEdits(edits: IIdentifiedSingleEditOperation[], undoSelectionsBefore: Selection[], undoSelectionsAfter: Selection[]): void {
		this.logUndo(`pushEditOperations before=${formatVSCodeSelections(undoSelectionsBefore)} after=${formatVSCodeSelections(undoSelectionsAfter)} edits=${edits.length}`);
		const returnedSelections = this.model().pushEditOperations(
			undoSelectionsBefore,
			edits,
			() => undoSelectionsAfter,
			undefined,
			EditSources.unknown({ name: 'vim' })
		);
		this.logUndo(`pushEditOperations returned=${formatVSCodeSelections(returnedSelections ?? [])} nativeAfterModel=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
	}

	private model() {
		const model = this.editor.getModel();
		if (!model) {
			throw new Error('Vim editor adapter requires an attached model');
		}
		return model;
	}

	private withVimEditInProgress(callback: () => void): void {
		this.vimEditInProgress = true;
		try {
			callback();
		} finally {
			this.vimEditInProgress = false;
		}
	}

	private rememberSelections(vimSelections: readonly VimSelection[], vscodeSelections: readonly Selection[]): void {
		this.lastSetVimSelections = [...vimSelections];
		this.lastSetVSCodeSelections = [...vscodeSelections];
		this.rememberedSelectionGoals = new Map();
		for (const selection of vimSelections) {
			if (selection.goal === undefined) {
				continue;
			}
			this.rememberedSelectionGoals.set(positionKey(selection.cursor ?? selectionHead(selection)), selection.goal);
		}
	}

	private selectionsMatchLastSet(selections: readonly Selection[]): boolean {
		if (this.lastSetVSCodeSelections === undefined || selections.length !== this.lastSetVSCodeSelections.length) {
			this.lastSetVimSelections = undefined;
			this.lastSetVSCodeSelections = undefined;
			this.visualLineDecorations.clear();
			return false;
		}
		const matches = selections.every((selection, index) => this.selectionMatchesLastSet(selection, this.lastSetVSCodeSelections![index], this.lastSetVimSelections![index]));
		if (!matches) {
			this.lastSetVimSelections = undefined;
			this.lastSetVSCodeSelections = undefined;
			this.visualLineDecorations.clear();
		}
		return matches;
	}

	private selectionMatchesLastSet(selection: Selection, lastSetSelection: Selection, lastSetVimSelection: VimSelection | undefined): boolean {
		if (selection.equalsSelection(lastSetSelection)) {
			return true;
		}
		if (lastSetVimSelection?.type !== 'linewise') {
			return false;
		}
		const startLine = Math.min(lastSetVimSelection.anchorLine, lastSetVimSelection.headLine) + 1;
		const endLine = Math.max(lastSetVimSelection.anchorLine, lastSetVimSelection.headLine) + 1;
		const selectionStartLine = Math.min(selection.selectionStartLineNumber, selection.positionLineNumber);
		const selectionEndLine = Math.max(selection.selectionStartLineNumber, selection.positionLineNumber);
		return selectionStartLine === startLine && selectionEndLine === endLine;
	}

	private lowerSelections(selections: readonly VimSelection[]): { selections: Selection[]; cursorPositions: VSCodePosition[] } {
		const loweredSelections: Selection[] = [];
		const cursorPositions: VSCodePosition[] = [];
		for (const selection of selections) {
			const lowered = this.lowerSelection(selection);
			loweredSelections.push(...lowered.selections);
			cursorPositions.push(...lowered.cursorPositions);
		}
		return { selections: loweredSelections, cursorPositions };
	}

	private lowerSelection(selection: VimSelection): { selections: Selection[]; cursorPositions: VSCodePosition[] } {
		switch (selection.type) {
			case 'charwise': {
				const vscodeSelection = new Selection(
					selection.anchor.row + 1,
					selection.anchor.column + 1,
					selection.head.row + 1,
					selection.head.column + 1
				);
				// Always pass an explicit render-cursor cell: the patched view renders
				// the block cursor only from this channel (or its native fallback), and
				// an explicit cell also forces a cursor view event even when the model
				// state is unchanged, so the rendered cursor can never go stale after a
				// Vim-side write-back.
				return {
					selections: [vscodeSelection],
					cursorPositions: [toVSCodePosition(charwiseRenderCursor(this, selection))],
				};
			}
			case 'linewise': {
				const startLine = Math.min(selection.anchorLine, selection.headLine) + 1;
				const endLine = Math.max(selection.anchorLine, selection.headLine) + 1;
				const cursor = this.linewiseCursorPosition(selection);
				const vscodeSelection = selection.headLine < selection.anchorLine
					? new Selection(endLine, this.model().getLineMaxColumn(endLine), startLine, 1)
					: new Selection(startLine, 1, endLine, this.model().getLineMaxColumn(endLine));
				return { selections: [vscodeSelection], cursorPositions: [cursor] };
			}
			case 'blockwise':
				return this.lowerBlockwiseSelection(selection);
		}
	}

	private lowerBlockwiseSelection(selection: Extract<VimSelection, { type: 'blockwise' }>): { selections: Selection[]; cursorPositions: VSCodePosition[] } {
		const startRow = Math.min(selection.anchor.row, selection.head.row);
		const endRow = Math.max(selection.anchor.row, selection.head.row);
		const startColumn = Math.min(selection.anchor.column, selection.head.column);
		const endColumn = Math.max(selection.anchor.column, selection.head.column);
		const cursorAtStart = selection.head.column < selection.anchor.column;
		const selections: Selection[] = [];
		const cursorPositions: VSCodePosition[] = [];

		for (let row = startRow; row <= endRow; row++) {
			const lineLength = this.lineLength(row);
			if (startColumn > lineLength && row !== selection.head.row) {
				continue;
			}
			const selectionStartColumn = Math.min(startColumn, lineLength) + 1;
			const selectionEndColumn = (selection.goal?.type === 'endOfLine' ? lineLength : Math.min(endColumn + 1, lineLength)) + 1;
			const positionColumn = cursorAtStart ? selectionStartColumn : selectionEndColumn;
			const anchorColumn = cursorAtStart ? selectionEndColumn : selectionStartColumn;
			selections.push(new Selection(row + 1, anchorColumn, row + 1, positionColumn));
			const cursorColumn = cursorAtStart
				? Math.min(startColumn, lineLength) + 1
				: (selection.goal?.type === 'endOfLine' ? Math.max(0, lineLength - 1) : Math.min(endColumn, Math.max(0, lineLength - 1))) + 1;
			cursorPositions.push(new VSCodePosition(row + 1, cursorColumn));
		}

		return { selections, cursorPositions };
	}

	private linewiseCursorPosition(selection: Extract<VimSelection, { type: 'linewise' }>): VSCodePosition {
		if (selection.cursor !== undefined) {
			return toVSCodePosition(selection.cursor);
		}
		const lineNumber = selection.headLine + 1;
		return new VSCodePosition(lineNumber, 1);
	}

	private updateVisualLineDecorations(selections: readonly VimSelection[]): void {
		const decorations: IModelDeltaDecoration[] = [];
		for (const selection of selections) {
			if (selection.type !== 'linewise') {
				continue;
			}
			const startLine = Math.min(selection.anchorLine, selection.headLine) + 1;
			const endLine = Math.max(selection.anchorLine, selection.headLine) + 1;
			decorations.push({
				range: new Range(startLine, 1, endLine, this.model().getLineMaxColumn(endLine)),
				options: {
					description: 'vim-visual-line-selection',
					className: 'selected-text',
					isWholeLine: true,
					shouldFillLineOnLineBreak: true,
				},
			});
		}
		this.visualLineDecorations.set(decorations);
	}
}

function positionKey(position: VimPosition): string {
	return `${position.row}:${position.column}`;
}

function visualSemanticSelections(selections: readonly VimSelection[] | undefined): readonly VimSelection[] | undefined {
	if (selections === undefined) {
		return undefined;
	}
	return selections.some(selection => {
		switch (selection.type) {
			case 'charwise':
				return comparePositions(selection.anchor, selection.head) !== 0;
			case 'linewise':
			case 'blockwise':
				return true;
		}
	}) ? selections : undefined;
}

function extendCharwiseSelection(
	editor: VSCodeVimEditor,
	selection: Extract<VimSelection, { type: 'charwise' }>,
	target: VimPosition,
	goal: VimSelectionGoal
): VimSelection {
	const anchor = inclusiveVisualAnchor(editor, selection);
	return lowerCharwiseGeometry(editor, { anchor, head: target, goal });
}

function inclusiveVisualAnchor(
	editor: VSCodeVimEditor,
	selection: Extract<VimSelection, { type: 'charwise' }>
): VimPosition {
	const head = selection.cursor ?? selection.head;
	return comparePositions(head, selection.anchor) < 0
		? previousCharacterCell(editor, selection.anchor)
		: selection.anchor;
}

function viewGoalForSelection(goal: VimSelectionGoal | undefined, viewPosition: VSCodePosition): VimSelectionGoal {
	if (goal?.type === 'endOfLine') {
		return goal;
	}
	if (goal?.type === 'viewColumn') {
		return goal;
	}
	if (goal?.type === 'modelColumn') {
		return { type: 'viewColumn', column: goal.column + 1 };
	}
	return { type: 'viewColumn', column: viewPosition.column };
}

function modelGoalForSelection(goal: VimSelectionGoal | undefined, head: VimPosition): VimSelectionGoal {
	if (goal?.type === 'endOfLine' || goal?.type === 'modelColumn') {
		return goal;
	}
	if (goal?.type === 'viewColumn') {
		return { type: 'modelColumn', column: Math.max(0, goal.column - 1) };
	}
	return { type: 'modelColumn', column: head.column };
}

function modelColumnForGoal(goal: VimSelectionGoal, maxColumn: number): number {
	if (goal.type === 'endOfLine') {
		return maxColumn;
	}
	return Math.max(1, Math.min(goal.column + 1, maxColumn));
}

// VSCode `CursorMoveCommands._targetFolded{Down,Up}` semantics: hidden areas
// contain the folded rows after the visible fold header, so crossing one jumps
// to the first row after it (or back to its header) and consumes one movement.
function foldedLineTarget(
	startLine: number,
	direction: HostDirection,
	count: number,
	hiddenAreas: readonly Range[],
	lineCount: number
): number {
	let line = startLine;
	if (direction === 'down') {
		let hiddenIndex = 0;
		while (hiddenIndex < hiddenAreas.length && hiddenAreas[hiddenIndex].endLineNumber < line + 1) {
			hiddenIndex++;
		}
		for (let step = 0; step < count; step++) {
			if (line >= lineCount) return lineCount;
			let candidate = line + 1;
			while (hiddenIndex < hiddenAreas.length && hiddenAreas[hiddenIndex].endLineNumber < candidate) {
				hiddenIndex++;
			}
			if (hiddenIndex < hiddenAreas.length && hiddenAreas[hiddenIndex].startLineNumber <= candidate) {
				candidate = hiddenAreas[hiddenIndex].endLineNumber + 1;
			}
			if (candidate > lineCount) return line;
			line = candidate;
		}
		return line;
	}

	let hiddenIndex = hiddenAreas.length - 1;
	while (hiddenIndex >= 0 && hiddenAreas[hiddenIndex].startLineNumber > line - 1) {
		hiddenIndex--;
	}
	for (let step = 0; step < count; step++) {
		if (line <= 1) return 1;
		let candidate = line - 1;
		while (hiddenIndex >= 0 && hiddenAreas[hiddenIndex].startLineNumber > candidate) {
			hiddenIndex--;
		}
		if (hiddenIndex >= 0 && hiddenAreas[hiddenIndex].endLineNumber >= candidate) {
			candidate = hiddenAreas[hiddenIndex].startLineNumber - 1;
		}
		if (candidate < 1) return line;
		line = candidate;
	}
	return line;
}

function foldCommandId(command: HostFoldCommand): string {
	switch (command) {
		case 'toggle':
			return 'editor.toggleFold';
		case 'open':
			return 'editor.unfold';
		case 'close':
			return 'editor.fold';
		case 'openRecursive':
			return 'editor.unfoldRecursively';
		case 'closeRecursive':
			return 'editor.foldRecursively';
		case 'openAll':
			return 'editor.unfoldAll';
		case 'closeAll':
			return 'editor.foldAll';
	}
}

function findContainingSearchMatch(
	model: ITextModel,
	query: string,
	position: VimPosition,
	options: SearchOptions,
	wordSeparators: string | null
): SearchMatch | undefined {
	const offset = model.getOffsetAt(toVSCodePosition(position));
	const match = model.findPreviousMatch(
		query,
		model.getPositionAt(Math.min(model.getValueLength(), offset + 1)),
		options.regex ?? false,
		options.caseSensitive ?? true,
		wordSeparators,
		false
	);
	if (match === null) {
		return undefined;
	}
	const startOffset = model.getOffsetAt(match.range.getStartPosition());
	const endOffset = model.getOffsetAt(match.range.getEndPosition());
	return startOffset <= offset && offset < Math.max(startOffset + 1, endOffset)
		? fromRange(match.range)
		: undefined;
}

function searchStartPosition(model: ITextModel, position: VimPosition, direction: SearchDirection, options: SearchOptions): VSCodePosition {
	const offset = model.getOffsetAt(toVSCodePosition(position));
	const shiftedOffset = options.includeStart === true
		? offset
		: direction === 'forward'
			? Math.min(model.getValueLength(), offset + 1)
			: Math.max(0, offset - 1);
	return model.getPositionAt(shiftedOffset);
}

function fromRange(range: IRange): TextRange {
	return {
		start: { row: range.startLineNumber - 1, column: range.startColumn - 1 },
		end: { row: range.endLineNumber - 1, column: range.endColumn - 1 },
	};
}

function formatVimSelections(selections: readonly VimSelection[] | undefined): string {
	if (selections === undefined) return 'undefined';
	return `[${selections.map(selection => {
					switch (selection.type) {
			case 'charwise': {
				const cursor = selection.cursor === undefined ? '' : ` cursor=${formatVimPosition(selection.cursor)}`;
				const goal = selection.goal === undefined ? '' : ` goal=${JSON.stringify(selection.goal)}`;
				return `char:${formatVimPosition(selection.anchor)}->${formatVimPosition(selection.head)}${cursor}${goal}`;
			}
			case 'linewise':
				return `line:${selection.anchorLine}->${selection.headLine}`;
			case 'blockwise':
				return `block:${formatVimPosition(selection.anchor)}->${formatVimPosition(selection.head)}`;
		}
	}).join(', ')}]`;
}

// The default editing/navigation commands behind the insert-mode passthrough
// whitelist (see `isPassthroughInsertKey` in ../common/insert_handler.js). All
// synchronous core editor commands, so the recorded-key replay loop stays
// synchronous.
const insertReplayCommands: Readonly<Record<string, string>> = {
	'backspace': 'deleteLeft',
	'delete': 'deleteRight',
	'ctrl-backspace': 'deleteWordLeft',
	'ctrl-delete': 'deleteWordRight',
	'up': 'cursorUp',
	'down': 'cursorDown',
	'left': 'cursorLeft',
	'right': 'cursorRight',
	'ctrl-left': 'cursorWordLeft',
	'ctrl-right': 'cursorWordRight',
	'home': 'cursorHome',
	'end': 'cursorEnd',
	'pageup': 'cursorPageUp',
	'pagedown': 'cursorPageDown',
};

function formatVimPosition(position: VimPosition): string {
	return `${position.row + 1}:${position.column + 1}`;
}

function formatVSCodeSelections(selections: readonly { selectionStartLineNumber: number; selectionStartColumn: number; positionLineNumber: number; positionColumn: number }[]): string {
	return `[${selections.map(selection => `${selection.selectionStartLineNumber}:${selection.selectionStartColumn}->${selection.positionLineNumber}:${selection.positionColumn}`).join(', ')}]`;
}

function toRange(range: TextRange): Range {
	return new Range(
		range.start.row + 1,
		range.start.column + 1,
		range.end.row + 1,
		range.end.column + 1
	);
}

function toVSCodePosition(position: VimPosition): VSCodePosition {
	return new VSCodePosition(position.row + 1, position.column + 1);
}
