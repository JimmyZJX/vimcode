import { ICodeEditor } from '../../../browser/editorBrowser.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Position as VSCodePosition } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { IEditorDecorationsCollection } from '../../../common/editorCommon.js';
import { IIdentifiedSingleEditOperation, IModelDeltaDecoration, PositionAffinity } from '../../../common/model.js';
import { CursorStyle, Position as VimPosition, TextEdit, TextRange, VimSelection, charwiseSelection, selectionHead } from '../common/state.js';
import { HostCommand, HostDirection, HostFoldCommand, HostRevealTarget, VimEditorCapabilities } from '../common/editor.js';
import { VSCodeVimClipboard } from './vscodeClipboard.js';

export class VSCodeVimEditor implements VimEditorCapabilities {
	private readonly visualLineDecorations: IEditorDecorationsCollection;
	private lastSetVimSelections: readonly VimSelection[] | undefined;
	private lastSetVSCodeSelections: readonly Selection[] | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly clipboard: VSCodeVimClipboard,
		private readonly commandService: ICommandService
	) {
		this.visualLineDecorations = editor.createDecorationsCollection();
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
		return selections.map(selection => ({
			type: 'charwise',
			anchor: {
				row: selection.selectionStartLineNumber - 1,
				column: selection.selectionStartColumn - 1,
			},
			head: {
				row: selection.positionLineNumber - 1,
				column: selection.positionColumn - 1,
			},
		}));
	}

	setSelections(selections: readonly VimSelection[]): void {
		const lowered = this.lowerSelections(selections);
		const source = lowered.cursorPositions.length > 0
			? `vim.cursorPositions:${lowered.cursorPositions.map(position => `${position.lineNumber},${position.column}`).join(';')}`
			: 'vim';
		this.updateVisualLineDecorations(selections);
		this.rememberSelections(selections, lowered.selections);
		this.editor.setSelections(lowered.selections, source);
	}

	setCursorStyle(style: CursorStyle): void {
		this.editor.updateOptions({ cursorStyle: style === 'line' ? 'line' : style === 'block' ? 'block' : 'underline' });
	}

	applyEdits(edits: readonly TextEdit[], selectionsAfter: readonly VimSelection[]): void {
		this.editor.pushUndoStop();
		const vscodeEdits: IIdentifiedSingleEditOperation[] = edits.map(edit => ({
			range: toRange(edit.range),
			text: edit.text,
		}));
		const lowered = this.lowerSelections(selectionsAfter);
		this.updateVisualLineDecorations(selectionsAfter);
		this.rememberSelections(selectionsAfter, lowered.selections);
		this.editor.executeEdits('vim', vscodeEdits, lowered.selections);
		this.editor.pushUndoStop();
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
				this.editor.trigger('vim', 'undo', null);
				return;
			case 'redo':
				this.editor.trigger('vim', 'redo', null);
				return;
		}
	}

	revealCurrentLine(target: HostRevealTarget): void {
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
		const viewModel = this.editor._getViewModel();
		if (viewModel === null) {
			return this.getSelections();
		}
		const converter = viewModel.coordinatesConverter;
		const lineCount = viewModel.model.getLineCount();
		return this.getSelections().map(selection => {
			const head = selection.type === 'charwise' ? selection.cursor ?? selection.head : selectionHead(selection);
			const modelPosition = new VSCodePosition(head.row + 1, head.column + 1);
			const viewPosition = converter.convertModelPositionToViewPosition(modelPosition, PositionAffinity.None, false, direction === 'down');
			const rawViewLine = viewPosition.lineNumber + (direction === 'down' ? count : -count);
			const viewLine = Math.max(1, Math.min(rawViewLine, viewModel.getLineCount()));
			const viewColumn = Math.max(viewModel.getLineMinColumn(viewLine), Math.min(viewPosition.column, viewModel.getLineMaxColumn(viewLine)));
			const target = converter.convertViewPositionToModelPosition(new VSCodePosition(viewLine, viewColumn));
			const targetLineNumber = Math.max(1, Math.min(target.lineNumber, lineCount));
			const targetColumn = Math.max(1, Math.min(target.column, viewModel.model.getLineMaxColumn(targetLineNumber)));
			const targetPosition = { row: targetLineNumber - 1, column: targetColumn - 1 };
			if (extend && selection.type === 'charwise') {
				return {
					...selection,
					head: exclusiveVisualHead(this, targetPosition),
					cursor: targetPosition,
				};
			}
			return charwiseSelection(targetPosition);
		});
	}

	moveByPages(direction: HostDirection, count: number, { halfPage, extend }: { halfPage: boolean; extend: boolean }): void {
		this.invalidateCachedSelections();
		this.editor.trigger('vim', 'editorScroll', {
			to: direction,
			by: halfPage ? 'halfPage' : 'page',
			value: count,
			revealCursor: true,
			select: extend,
		});
	}

	scrollByLines(direction: HostDirection, count: number): void {
		this.editor.trigger('vim', 'editorScroll', {
			to: direction,
			by: 'wrappedLine',
			value: count,
			revealCursor: false,
			select: false,
		});
	}

	readClipboard(): string {
		return this.clipboard.readText();
	}

	writeClipboard(text: string): void {
		this.clipboard.writeText(text);
	}

	refreshClipboardFromSystemClipboard(): void {
		this.clipboard.refreshFromSystemClipboard();
	}

	invalidateCachedSelections(): void {
		this.lastSetVimSelections = undefined;
		this.lastSetVSCodeSelections = undefined;
		this.visualLineDecorations.clear();
	}

	private model() {
		const model = this.editor.getModel();
		if (!model) {
			throw new Error('Vim editor adapter requires an attached model');
		}
		return model;
	}

	private rememberSelections(vimSelections: readonly VimSelection[], vscodeSelections: readonly Selection[]): void {
		this.lastSetVimSelections = [...vimSelections];
		this.lastSetVSCodeSelections = [...vscodeSelections];
	}

	private selectionsMatchLastSet(selections: readonly Selection[]): boolean {
		if (this.lastSetVSCodeSelections === undefined || selections.length !== this.lastSetVSCodeSelections.length) {
			this.lastSetVimSelections = undefined;
			this.lastSetVSCodeSelections = undefined;
			this.visualLineDecorations.clear();
			return false;
		}
		const matches = selections.every((selection, index) => selection.equalsSelection(this.lastSetVSCodeSelections![index]));
		if (!matches) {
			this.lastSetVimSelections = undefined;
			this.lastSetVSCodeSelections = undefined;
			this.visualLineDecorations.clear();
		}
		return matches;
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
				return { selections: [vscodeSelection], cursorPositions: [] };
			}
			case 'linewise': {
				const cursor = this.linewiseCursorPosition(selection);
				const vscodeSelection = new Selection(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column);
				return { selections: [vscodeSelection], cursorPositions: [] };
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
			const selectionStartColumn = Math.min(startColumn, lineLength) + 1;
			const selectionEndColumn = Math.min(endColumn + 1, lineLength) + 1;
			const positionColumn = cursorAtStart ? selectionStartColumn : selectionEndColumn;
			const anchorColumn = cursorAtStart ? selectionEndColumn : selectionStartColumn;
			selections.push(new Selection(row + 1, anchorColumn, row + 1, positionColumn));
			const cursorColumn = cursorAtStart
				? Math.min(startColumn, lineLength) + 1
				: Math.min(endColumn, Math.max(0, lineLength - 1)) + 1;
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

function exclusiveVisualHead(editor: VSCodeVimEditor, head: VimPosition): VimPosition {
	const lineLength = editor.lineLength(head.row);
	if (lineLength === 0) {
		return head;
	}
	return { row: head.row, column: Math.min(head.column + 1, lineLength) };
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
