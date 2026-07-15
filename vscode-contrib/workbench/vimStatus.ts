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
	private readonly unknownKeyEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly focusedEditorListener = this._register(new MutableDisposable<IDisposable>());
	private readonly statusListener = this._register(new MutableDisposable<IDisposable>());
	private readonlyWarningTimeout: ReturnType<typeof setTimeout> | undefined;

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

	override dispose(): void {
		this.clearReadonlyWarningTimeout();
		super.dispose();
	}

	private updateFocusedEditor(): void {
		const editor = this.codeEditorService.getFocusedCodeEditor();
		this.focusedEditorListener.clear();
		this.statusListener.clear();
		this.clearReadonlyWarningTimeout();

		const controller = editor?.getContribution<VimController>(VimController.ID) ?? undefined;
		if (!controller) {
			this.statusbarEntry.clear();
			this.unknownKeyEntry.clear();
			return;
		}

		this.statusListener.value = controller.onDidChangeStatus(() => this.updateEntry(controller));
		this.focusedEditorListener.value = Event.once(editor!.onDidBlurEditorText)(() => this.updateFocusedEditor());
		this.updateEntry(controller);
	}

	private updateEntry(controller: VimController): void {
		this.clearReadonlyWarningTimeout();
		if (!controller.isVimEnabled()) {
			this.statusbarEntry.clear();
			this.unknownKeyEntry.clear();
			return;
		}
		const status = controller.getStatus();
		const text = `VIM ${status.text}`;
		const entry = {
			name: 'Vim Mode',
			text,
			ariaLabel: `Vim mode ${status.mode}${status.chord ? `, pending ${status.chord}` : ''}${status.macroRecording ? `, recording @${status.macroRecording.register}` : ''}${status.readonlyWarning ? ', read-only document' : ''}`,
			tooltip: status.readonlyWarning ? 'Vim cannot enter Insert or Replace mode in a read-only document' : 'Current Vim mode, unfinished key sequence, and macro recording state',
			kind: status.readonlyWarning ? 'warning' as const : undefined,
		};

		if (this.statusbarEntry.value) {
			this.statusbarEntry.value.update(entry);
		} else {
			this.statusbarEntry.value = this.statusbarService.addEntry(entry, 'status.vimMode', StatusbarAlignment.LEFT, 100);
		}
		this.updateUnknownKeyEntry(status);
		const remainingMs = [status.readonlyWarningRemainingMs, status.swallowedKeyWarningRemainingMs]
			.filter((ms): ms is number => ms !== undefined);
		if (remainingMs.length > 0) {
			this.readonlyWarningTimeout = setTimeout(() => this.updateEntry(controller), Math.max(0, Math.min(...remainingMs)));
		}
	}

	// A prompt swallowed a key it does not understand: a transient warning
	// entry right next to the main Vim one, instead of silently ignoring the
	// key (it disappears when [swallowedKeyWarningRemainingMs] runs out).
	private updateUnknownKeyEntry(status: ReturnType<VimController['getStatus']>): void {
		if (status.swallowedKeyWarning === undefined) {
			this.unknownKeyEntry.clear();
			return;
		}
		const entry = {
			name: 'Vim Unknown Key',
			text: `unknown ${status.swallowedKeyWarning}`,
			ariaLabel: `The open Vim prompt does not understand ${status.swallowedKeyWarning}; the key was ignored`,
			tooltip: `The open prompt does not understand ${status.swallowedKeyWarning}; the key was ignored`,
			kind: 'warning' as const,
		};
		if (this.unknownKeyEntry.value) {
			this.unknownKeyEntry.value.update(entry);
		} else {
			this.unknownKeyEntry.value = this.statusbarService.addEntry(entry, 'status.vimUnknownKey', StatusbarAlignment.LEFT, 99);
		}
	}

	private clearReadonlyWarningTimeout(): void {
		if (this.readonlyWarningTimeout !== undefined) {
			clearTimeout(this.readonlyWarningTimeout);
			this.readonlyWarningTimeout = undefined;
		}
	}
}

registerWorkbenchContribution2(VimStatusbarContribution.ID, VimStatusbarContribution, WorkbenchPhase.AfterRestored);
