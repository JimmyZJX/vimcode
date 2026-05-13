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
		const vscodeSelections = selections.map(selection => this.toSelection(selection));
		const cursorPositions = selections.map(selection => this.cursorPositionForSelection(selection));
		const source = cursorPositions.some((position, index) => !position.equals(vscodeSelections[index].getPosition()))
			? `vim.cursorPositions:${cursorPositions.map(position => `${position.lineNumber},${position.column}`).join(';')}`
			: 'vim';
		this.updateVisualLineDecorations(selections);
		this.rememberSelections(selections, vscodeSelections);
		this.editor.setSelections(vscodeSelections, source);
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
		const vscodeSelectionsAfter = selectionsAfter.map(selection => this.toSelection(selection));
		this.updateVisualLineDecorations(selectionsAfter);
		this.rememberSelections(selectionsAfter, vscodeSelectionsAfter);
		this.editor.executeEdits('vim', vscodeEdits, vscodeSelectionsAfter);
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

	private toSelection(selection: VimSelection): Selection {
		switch (selection.type) {
			case 'charwise':
			case 'blockwise':
				return new Selection(
					selection.anchor.row + 1,
					selection.anchor.column + 1,
					selection.head.row + 1,
					selection.head.column + 1
				);
			case 'linewise':
				return this.toLinewiseSelection(selection);
		}
	}

	private toLinewiseSelection(selection: Extract<VimSelection, { type: 'linewise' }>): Selection {
		const cursor = this.linewiseCursorPosition(selection);
		return new Selection(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column);
	}

	private cursorPositionForSelection(selection: VimSelection): VSCodePosition {
		switch (selection.type) {
			case 'charwise':
			case 'blockwise':
				return selection.cursor !== undefined ? toVSCodePosition(selection.cursor) : this.toSelection(selection).getPosition();
			case 'linewise':
				return this.linewiseCursorPosition(selection);
		}
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
