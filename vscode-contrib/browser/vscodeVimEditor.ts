import { ICodeEditor } from '../../../browser/editorBrowser.js';
import { Position as VSCodePosition } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { IEditorDecorationsCollection } from '../../../common/editorCommon.js';
import { IIdentifiedSingleEditOperation, IModelDeltaDecoration } from '../../../common/model.js';
import { CursorStyle, Position as VimPosition, TextEdit, TextRange, VimSelection, charwiseSelection } from '../common/state.js';
import { VimEditorCapabilities } from '../common/editor.js';
import { VSCodeVimClipboard } from './vscodeClipboard.js';

export class VSCodeVimEditor implements VimEditorCapabilities {
	private readonly visualLineDecorations: IEditorDecorationsCollection;
	private lastSetVimSelections: readonly VimSelection[] | undefined;
	private lastSetVSCodeSelections: readonly Selection[] | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly clipboard: VSCodeVimClipboard
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
		this.updateVisualLineDecorations(selections);
		this.rememberSelections(selections, lowered.selections);
		this.editor.setSelections(lowered.selections, 'vim');
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

	private lowerSelections(selections: readonly VimSelection[]): { selections: Selection[] } {
		const loweredSelections: Selection[] = [];
		for (const selection of selections) {
			loweredSelections.push(...this.lowerSelection(selection));
		}
		return { selections: loweredSelections };
	}

	private lowerSelection(selection: VimSelection): Selection[] {
		switch (selection.type) {
			case 'charwise': {
				const vscodeSelection = new Selection(
					selection.anchor.row + 1,
					selection.anchor.column + 1,
					selection.head.row + 1,
					selection.head.column + 1
				);
				return [vscodeSelection];
			}
			case 'linewise': {
				const cursor = this.linewiseCursorPosition(selection);
				const vscodeSelection = new Selection(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column);
				return [vscodeSelection];
			}
			case 'blockwise':
				return this.lowerBlockwiseSelection(selection);
		}
	}

	private lowerBlockwiseSelection(selection: Extract<VimSelection, { type: 'blockwise' }>): Selection[] {
		const startRow = Math.min(selection.anchor.row, selection.head.row);
		const endRow = Math.max(selection.anchor.row, selection.head.row);
		const startColumn = Math.min(selection.anchor.column, selection.head.column);
		const endColumn = Math.max(selection.anchor.column, selection.head.column);
		const cursorAtStart = selection.head.column < selection.anchor.column;
		const selections: Selection[] = [];

		for (let row = startRow; row <= endRow; row++) {
			const lineLength = this.lineLength(row);
			const selectionStartColumn = Math.min(startColumn, lineLength) + 1;
			const selectionEndColumn = Math.min(endColumn + 1, lineLength) + 1;
			const positionColumn = cursorAtStart ? selectionStartColumn : selectionEndColumn;
			const anchorColumn = cursorAtStart ? selectionEndColumn : selectionStartColumn;
			selections.push(new Selection(row + 1, anchorColumn, row + 1, positionColumn));
		}

		return selections;
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
