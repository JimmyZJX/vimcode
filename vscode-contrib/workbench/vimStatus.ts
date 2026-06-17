import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { VimController } from '../../../../editor/contrib/vim/browser/vimController.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

class VimStatusbarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vimStatusbar';

	private readonly statusbarEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly focusedEditorListener = this._register(new MutableDisposable<IDisposable>());
	private readonly statusListener = this._register(new MutableDisposable<IDisposable>());

	constructor(
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
	) {
		super();
		for (const editor of codeEditorService.listCodeEditors()) {
			this.registerEditor(editor);
		}
		this._register(codeEditorService.onCodeEditorAdd(editor => this.registerEditor(editor)));
		this.updateFocusedEditor();
	}

	private registerEditor(editor: ICodeEditor): void {
		this._register(editor.onDidFocusEditorText(() => this.updateFocusedEditor()));
		this._register(editor.onDidBlurEditorText(() => this.updateFocusedEditor()));
	}

	private updateFocusedEditor(): void {
		const editor = this.codeEditorService.getFocusedCodeEditor();
		this.focusedEditorListener.clear();
		this.statusListener.clear();

		const controller = editor?.getContribution<VimController>(VimController.ID) ?? undefined;
		if (!controller) {
			this.statusbarEntry.clear();
			return;
		}

		this.statusListener.value = controller.onDidChangeStatus(() => this.updateEntry(controller));
		this.focusedEditorListener.value = Event.once(editor!.onDidBlurEditorText)(() => this.updateFocusedEditor());
		this.updateEntry(controller);
	}

	private updateEntry(controller: VimController): void {
		if (!controller.isVimEnabled()) {
			this.statusbarEntry.clear();
			return;
		}
		const status = controller.getStatus();
		const text = `VIM ${status.text}`;
		const entry = {
			name: 'Vim Mode',
			text,
			ariaLabel: `Vim mode ${status.mode}${status.chord ? `, pending ${status.chord}` : ''}${status.macroRecording ? `, recording @${status.macroRecording.register}` : ''}`,
			tooltip: 'Current Vim mode, unfinished key sequence, and macro recording state',
		};

		if (this.statusbarEntry.value) {
			this.statusbarEntry.value.update(entry);
		} else {
			this.statusbarEntry.value = this.statusbarService.addEntry(entry, 'status.vimMode', StatusbarAlignment.LEFT, 100);
		}
	}
}

registerWorkbenchContribution2(VimStatusbarContribution.ID, VimStatusbarContribution, WorkbenchPhase.AfterRestored);
