import { ICodeEditor } from '../../../browser/editorBrowser.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { IIdentifiedSingleEditOperation } from '../../../common/model.js';
import { CursorStyle, TextEdit, TextRange, VimSelection, charwiseSelection } from '../common/state.js';
import { VimEditorCapabilities } from '../common/editor.js';
import { VSCodeVimClipboard } from './vscodeClipboard.js';

export class VSCodeVimEditor implements VimEditorCapabilities {
	constructor(
		private readonly editor: ICodeEditor,
		private readonly clipboard: VSCodeVimClipboard
	) { }

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
		this.editor.setSelections(selections.map(toSelection), 'vim');
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
		this.editor.executeEdits('vim', vscodeEdits, selectionsAfter.map(toSelection));
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
}

function toRange(range: TextRange): Range {
	return new Range(
		range.start.row + 1,
		range.start.column + 1,
		range.end.row + 1,
		range.end.column + 1
	);
}

function toSelection(selection: VimSelection): Selection {
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
			return new Selection(selection.anchorLine + 1, 1, selection.headLine + 1, 1);
	}
}
