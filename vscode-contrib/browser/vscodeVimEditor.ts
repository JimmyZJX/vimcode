import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IActiveCodeEditor, ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { CursorChangeReason } from '../../../common/cursorEvents.js';
import { Position as VSCodePosition } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { IEditorDecorationsCollection, ScrollType } from '../../../common/editorCommon.js';
import { IIdentifiedSingleEditOperation, IModelDeltaDecoration, ITextModel, InjectedTextCursorStops, PositionAffinity } from '../../../common/model.js';
import { EditSources } from '../../../common/textModelEditSource.js';
import { CommonFindController } from '../../find/browser/findController.js';
import { FindModelBoundToEditorModel } from '../../find/browser/findModel.js';
import { FindReplaceState } from '../../find/browser/findState.js';
import { ApplyEditsOptions, HostCommand, HostDirection, HostFoldCommand, HostRevealTarget, NativeCommandOptions, VimEditorCapabilities, normalCursorPosition } from '../common/editor.js';
import { SearchDirection, SearchMatch, SearchOptions } from '../common/search.js';
import { charwiseRenderCursor, lowerCharwiseGeometry, previousCharacterCell } from '../common/selection_geometry.js';
import { CursorStyle, TextEdit, TextRange, Position as VimPosition, VimSelection, VimSelectionGoal, charwiseSelection, comparePositions, selectionHead } from '../common/state.js';

type ExplicitSelectionEditor = ICodeEditor & {
	setSelections(selections: readonly Selection[], source?: string, reason?: CursorChangeReason): void;
};

type VimUndoTransaction = {
	model: ITextModel;
	undoSelectionsBefore: Selection[];
	pushStackElement: ITextModel['pushStackElement'];
	pushEditOperations: ITextModel['pushEditOperations'];
	hasEdits: boolean;
};

export class VSCodeVimEditor implements VimEditorCapabilities {
	private readonly visualLineDecorations: IEditorDecorationsCollection;
	private readonly insertPendingDecorations: IEditorDecorationsCollection;
	private lastSetVimSelections: readonly VimSelection[] | undefined;
	private lastSetVSCodeSelections: readonly Selection[] | undefined;
	private rememberedSelectionGoals = new Map<string, VimSelectionGoal>();
	private searchPreviewViewport: { scrollTop: number; scrollLeft: number } | undefined;
	private hiddenFindState: FindReplaceState | undefined;
	private hiddenFindModel: FindModelBoundToEditorModel | undefined;
	private viewportControlledByCommand = false;
	private skipNextPrimaryReveal = false;
	private viewportRevealRequestId = 0;
	private nativeCommandInProgress = false;
	private vimEditInProgress = false;
	private undoTransaction: VimUndoTransaction | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly commandService: ICommandService,
		private readonly logUndo: (message: string) => void = () => undefined
	) {
		this.visualLineDecorations = editor.createDecorationsCollection();
		this.insertPendingDecorations = editor.createDecorationsCollection();
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
		const model = this.model();
		if (!range) {
			return model.getValue();
		}
		return model.getValueInRange(toRange(range));
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

	setCursorStyle(style: CursorStyle): void {
		this.editor.updateOptions({ cursorStyle: style === 'line' ? 'line' : style === 'block' ? 'block' : 'underline' });
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

	beginUndoTransaction(selectionsBefore: readonly VimSelection[]): void {
		this.logUndo(`beginUndoTransaction open=${this.isUndoTransactionOpen()} before=${formatVimSelections(selectionsBefore)} native=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
		if (this.isUndoTransactionOpen()) return;
		this.editor.pushUndoStop();
		this.openUndoTransaction(this.model(), this.lowerSelections(selectionsBefore).selections, { hasEdits: false });
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
			if (this.isUndoTransactionOpen()) this.closeUndoTransaction({ pushUndoStop: true });
			else this.editor.pushUndoStop();
		}
		this.logUndo(`applyEdits end open=${this.isUndoTransactionOpen()} native=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
	}

	finishUndoTransaction(selectionsAfter?: readonly VimSelection[]): void {
		this.logUndo(`finishUndoTransaction start open=${this.isUndoTransactionOpen()} selectionsAfter=${formatVimSelections(selectionsAfter)} nativeBefore=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
		const transaction = this.undoTransaction;
		if (transaction !== undefined && transaction.hasEdits && selectionsAfter !== undefined) {
			const lowered = this.lowerSelections(selectionsAfter);
			this.updateVisualLineDecorations(selectionsAfter);
			this.rememberSelections(selectionsAfter, lowered.selections);
			this.withVimEditInProgress(() => {
				this.applyModelEdits([], this.editor.getSelections() ?? [], lowered.selections);
			});
		}
		if (transaction === undefined) this.editor.pushUndoStop();
		else this.closeUndoTransaction({ pushUndoStop: transaction.hasEdits });
		this.logUndo(`finishUndoTransaction end native=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
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

	executeNativeCommand(command: string, args: readonly unknown[] = [], options: NativeCommandOptions = {}): void {
		const syncSelectionAfter = options.syncSelectionAfter === true || command === 'undo' || command === 'redo';
		const selectionsToRestore = options.preserveVisualSelection === true
			? visualSemanticSelections(this.lastSetVimSelections)
			: undefined;
		this.nativeCommandInProgress = !syncSelectionAfter;
		void this.commandService.executeCommand(command, ...args).finally(() => {
			this.nativeCommandInProgress = false;
			if (selectionsToRestore !== undefined) {
				this.setSelections(selectionsToRestore);
			}
		});
	}

	isExecutingNativeCommand(): boolean {
		return this.nativeCommandInProgress || this.vimEditInProgress;
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

		const scrollTop = this.editor.getScrollTop();
		const viewportHeight = this.editor.getLayoutInfo().height;
		const bandTop = scrollTop + viewportHeight * 0.15;
		const bandBottom = scrollTop + viewportHeight * 0.85;
		const cursorTop = this.editor.getTopForLineNumber(position.lineNumber);
		const cursorBottom = this.editor.getBottomForLineNumber(position.lineNumber);

		if (cursorTop < bandTop) {
			this.scheduleViewportReveal(scrollTop - (bandTop - cursorTop));
		} else if (cursorBottom > bandBottom) {
			this.scheduleViewportReveal(scrollTop + (cursorBottom - bandBottom));
		}
	}

	revealRange(range: TextRange): void {
		const scrollTop = this.editor.getScrollTop();
		const viewportHeight = this.editor.getLayoutInfo().height;
		const viewportBottom = scrollTop + viewportHeight;
		const rangeTop = this.editor.getTopForPosition(range.start.row + 1, range.start.column + 1);
		const rangeBottom = this.editor.getBottomForLineNumber(range.end.row + 1);

		if (rangeTop < scrollTop) {
			this.scheduleViewportReveal(rangeTop);
		} else if (rangeBottom > viewportBottom) {
			this.scheduleViewportReveal(scrollTop + (rangeBottom - viewportBottom));
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

	private scheduleViewportReveal(targetScrollTop: number): void {
		const requestId = ++this.viewportRevealRequestId;
		// Defer until after VSCode has finished processing the selection/cursor event for
		// this command. Applying the smooth scroll synchronously can be overwritten by
		// editor scroll stabilization, especially for visual selections.
		queueMicrotask(() => {
			if (requestId === this.viewportRevealRequestId) {
				this.editor.setScrollTop(targetScrollTop, ScrollType.Smooth);
			}
		});
	}

	revealCurrentLine(target: HostRevealTarget): void {
		this.viewportControlledByCommand = true;
		const position = this.editor.getPosition();
		if (position === null) {
			return;
		}
		this.editor.trigger('vim', 'revealLine', {
			lineNumber: position.lineNumber - 1,
			at: target,
		});
	}

	executeFoldCommand(command: HostFoldCommand): void {
		this.invalidateCachedSelections();
		this.editor.trigger('vim', foldCommandId(command), null);
	}

	moveByViewLines(direction: HostDirection, count: number, { displayLine, extend }: { displayLine: boolean; extend: boolean }): readonly VimSelection[] {
		// This is a pure query over VSCode's internal view model. It uses the same
		// model<->view coordinate conversion that native cursor movement uses, so
		// folded ranges and soft wraps are represented without moving the live cursor.
		const before = this.getSelections();
		const viewModel = this.editor._getViewModel();
		if (viewModel === null) {
			return before;
		}
		const converter = viewModel.coordinatesConverter;
		const lineCount = viewModel.model.getLineCount();
		const result = before.map(selection => {
			const head = selection.cursor ?? selectionHead(selection);
			const modelPosition = new VSCodePosition(head.row + 1, head.column + 1);
			const viewPosition = converter.convertModelPositionToViewPosition(modelPosition, PositionAffinity.None, false, direction === 'down');
			const rawViewLine = viewPosition.lineNumber + (direction === 'down' ? count : -count);
			const viewLine = Math.max(1, Math.min(rawViewLine, viewModel.getLineCount()));
			const goal = viewGoalForSelection(selection.goal, viewPosition);
			const viewColumn = viewColumnForGoal(viewModel, viewLine, goal);
			const target = converter.convertViewPositionToModelPosition(new VSCodePosition(viewLine, viewColumn));
			const targetLineNumber = Math.max(1, Math.min(target.lineNumber, lineCount));
			const targetColumn = Math.max(1, Math.min(target.column, viewModel.model.getLineMaxColumn(targetLineNumber)));
			const targetPosition = { row: targetLineNumber - 1, column: targetColumn - 1 };
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

	scrollByLines(direction: HostDirection, count: number): void {
		this.viewportControlledByCommand = true;
		this.editor.trigger('vim', 'editorScroll', {
			to: direction,
			by: 'wrappedLine',
			value: count,
			revealCursor: false,
			select: false,
		});
	}

	updateSearch(query: string, _direction: SearchDirection, options: SearchOptions = {}): void {
		if (query.length === 0 || !this.editor.hasModel()) {
			this.clearSearchHighlights();
			return;
		}

		this.closeNativeFindWidget();

		const hiddenFindState = this.ensureHiddenFindState();
		hiddenFindState.change({
			searchString: query,
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

	findSearchMatch(query: string, start: VimPosition, direction: SearchDirection, options: SearchOptions = {}): SearchMatch | undefined {
		if (query.length === 0) {
			return undefined;
		}
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
		this.clearSearchHighlights();
		this.detachFromModel();
	}

	detachFromModel(): void {
		this.endSearchPreview({ restoreViewport: false });
		this.clearSearchHighlights();
		this.setInsertPendingText(undefined);
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

type ViewModelLike = NonNullable<ReturnType<ICodeEditor['_getViewModel']>>;

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

function viewColumnForGoal(viewModel: ViewModelLike, viewLine: number, goal: VimSelectionGoal): number {
	const minColumn = viewModel.getLineMinColumn(viewLine);
	const maxColumn = viewModel.getLineMaxColumn(viewLine);
	if (goal.type === 'endOfLine') {
		return Math.max(minColumn, maxColumn - 1);
	}
	return Math.max(minColumn, Math.min(goal.column, maxColumn));
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

function fromRange(range: Range): TextRange {
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
