import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { readCompatibilityConfigValue } from '../../../../editor/contrib/vim/browser/vim.contribution.js';
import { VimController } from '../../../../editor/contrib/vim/browser/vimController.js';
import { VimMode } from '../../../../editor/contrib/vim/common/state.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

const VimCodeEnabledContext = new RawContextKey<boolean>('vimcode.enabled', false, true);
const VimEnabledContext = new RawContextKey<boolean>('vim.enabled', false, true);

// VSCodeVim `vim.statusBarColorControl` (`StatusBarImpl.updateColor`): the
// customization keys the per-mode background/foreground colors are written to.
const StatusBarBackgroundCustomizations = [
	'statusBar.background',
	'statusBar.noFolderBackground',
	'statusBar.debuggingBackground',
	'statusBarItem.prominentBackground',
];
const StatusBarForegroundCustomizations = [
	'statusBar.foreground',
	'statusBar.debuggingForeground',
	'statusBarItem.prominentForeground',
];

// The `vim.statusBarColors.*` key for a Vim mode, following VSCodeVim's
// lowercased mode names. The Helix modes have no VSCodeVim equivalent and use
// the closest Vim mode's color.
function statusBarColorKeyForMode(mode: VimMode): string {
	switch (mode) {
		case 'normal': return 'normal';
		case 'insert': return 'insert';
		case 'replace': return 'replace';
		case 'visual': return 'visual';
		case 'visualLine': return 'visualline';
		case 'visualBlock': return 'visualblock';
		case 'command': return 'commandlineinprogress';
		case 'search': return 'searchinprogressmode';
		case 'helixNormal': return 'normal';
		case 'helixSelect': return 'visual';
	}
}

// A `vim.statusBarColors.*` value: a background color string, or a
// `[background, foreground]` pair (VSCodeVim's two accepted shapes).
function parseStatusBarColor(value: unknown): { background: string; foreground: string | undefined } | undefined {
	if (typeof value === 'string' && value.length > 0) {
		return { background: value, foreground: undefined };
	}
	if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
		return { background: value[0], foreground: typeof value[1] === 'string' && value[1].length > 0 ? value[1] : undefined };
	}
	return undefined;
}

// This existing workbench-level contribution also owns global enablement
// contexts. It starts before views restore, unlike per-editor VimController,
// so list/tree keybindings never depend on an editor having been created.
class VimStatusbarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vimStatusbar';

	private readonly statusbarEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly unknownKeyEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly focusedEditorListener = this._register(new MutableDisposable<IDisposable>());
	private readonly statusListener = this._register(new MutableDisposable<IDisposable>());
	private readonly vimcodeEnabledContext: IContextKey<boolean>;
	private vimEnabledContext: IContextKey<boolean> | undefined;
	private wasEnabled = false;
	private readonlyWarningTimeout: ReturnType<typeof setTimeout> | undefined;
	// The mode + colors currently applied to the status bar via the in-memory
	// `workbench.colorCustomizations` override; undefined when no override is
	// active (`vim.statusBarColorControl` off, or Vim disabled).
	private appliedStatusBarColor: { mode: VimMode; background: string; foreground: string | undefined } | undefined;

	constructor(
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		this.vimcodeEnabledContext = VimCodeEnabledContext.bindTo(contextKeyService);
		this.updateEnabledContexts();
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('vim.enabled') || event.affectsConfiguration('vimcode.enabled')) {
				this.updateEnabledContexts();
			}
			if (
				event.affectsConfiguration('vim.statusBarColorControl')
				|| event.affectsConfiguration('vimcode.statusBarColorControl')
				|| event.affectsConfiguration('vim.statusBarColors')
				|| event.affectsConfiguration('vimcode.statusBarColors')
			) {
				this.refreshStatusBarColorFromConfiguration();
			}
		}));
		// Keep the status-bar/editor tracking at its previous AfterRestored timing;
		// only the tiny global-context initialization belongs on the startup path.
		void lifecycleService.when(LifecyclePhase.Restored).then(() => this.initializeStatusbar());
	}

	private initializeStatusbar(): void {
		for (const editor of this.codeEditorService.listCodeEditors()) {
			this.registerEditor(editor);
		}
		this._register(this.codeEditorService.onCodeEditorAdd(editor => {
			this.registerEditor(editor);
			this.updateFocusedEditor();
		}));
		this.updateFocusedEditor();
	}

	private updateEnabledContexts(): void {
		const enabled = readCompatibilityConfigValue(this.configurationService, 'enabled') === true;
		this.vimcodeEnabledContext.set(enabled);

		// `vim.enabled` is shared with VSCodeVim. Preserve the inert disabled
		// startup path by not creating/writing it unless vimcode has been enabled
		// during this window's lifetime.
		if (enabled || this.wasEnabled) {
			this.vimEnabledContext ??= VimEnabledContext.bindTo(this.contextKeyService);
			this.vimEnabledContext.set(enabled);
		}
		this.wasEnabled = enabled;
	}

	private registerEditor(editor: ICodeEditor): void {
		this._register(editor.onDidFocusEditorText(() => this.updateFocusedEditor()));
		this._register(editor.onDidBlurEditorText(() => this.updateFocusedEditor()));
	}

	override dispose(): void {
		this.clearReadonlyWarningTimeout();
		this.restoreStatusBarColor();
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
			this.restoreStatusBarColor();
			return;
		}
		const status = controller.getStatus();
		this.updateStatusBarColor(status.mode);
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

	// VSCodeVim `vim.statusBarColorControl` (`StatusBarImpl.updateColor`),
	// with one deliberate difference: VSCodeVim persists the per-mode colors
	// into the user's settings.json `workbench.colorCustomizations` (leaving
	// stale colors behind); vimcode writes the same customization keys to the
	// window's *in-memory* configuration layer, so the status bar recolors
	// identically but no settings file is modified and disabling restores the
	// user's own colors.
	private updateStatusBarColor(mode: VimMode): void {
		if (readCompatibilityConfigValue(this.configurationService, 'statusBarColorControl') !== true) {
			this.restoreStatusBarColor();
			return;
		}
		const configured = parseStatusBarColor(
			readCompatibilityConfigValue(this.configurationService, `statusBarColors.${statusBarColorKeyForMode(mode)}`));
		// A mode without a configured color keeps the current color, like
		// VSCodeVim (with the shipped defaults every mode has one).
		if (configured === undefined) {
			return;
		}
		const applied = this.appliedStatusBarColor;
		if (applied !== undefined
			&& applied.mode === mode
			&& applied.background === configured.background
			&& applied.foreground === configured.foreground) {
			return;
		}
		this.appliedStatusBarColor = { mode, ...configured };
		const customizations: Record<string, unknown> = { ...this.baseColorCustomizations() };
		for (const key of StatusBarBackgroundCustomizations) {
			customizations[key] = configured.background;
		}
		if (configured.foreground !== undefined) {
			for (const key of StatusBarForegroundCustomizations) {
				customizations[key] = configured.foreground;
			}
		}
		void this.configurationService.updateValue('workbench.colorCustomizations', customizations, ConfigurationTarget.MEMORY);
	}

	private restoreStatusBarColor(): void {
		if (this.appliedStatusBarColor === undefined) {
			return;
		}
		this.appliedStatusBarColor = undefined;
		void this.configurationService.updateValue('workbench.colorCustomizations', undefined, ConfigurationTarget.MEMORY);
	}

	// The user's own `workbench.colorCustomizations`, merged across the real
	// (non-memory) configuration layers so the override extends rather than
	// replaces it.
	private baseColorCustomizations(): Record<string, unknown> {
		const inspected = this.configurationService.inspect<Record<string, unknown>>('workbench.colorCustomizations');
		return Object.assign(
			{},
			...[
				inspected.applicationValue,
				inspected.userValue,
				inspected.userLocalValue,
				inspected.userRemoteValue,
				inspected.workspaceValue,
				inspected.workspaceFolderValue,
				inspected.policyValue,
			].filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value))
		);
	}

	// A `vim.statusBarColorControl` / `vim.statusBarColors.*` setting changed:
	// re-resolve the active mode's color. [updateStatusBarColor] drops the
	// override when the control was turned off, re-applies when the colors
	// changed, and no-ops when the resolved color is unchanged.
	private refreshStatusBarColorFromConfiguration(): void {
		const applied = this.appliedStatusBarColor;
		if (applied !== undefined) {
			this.updateStatusBarColor(applied.mode);
			return;
		}
		// Nothing applied yet: a currently-focused Vim editor still needs the
		// new colors picked up.
		const controller = this.codeEditorService.getFocusedCodeEditor()?.getContribution<VimController>(VimController.ID);
		if (controller && controller.isVimEnabled()) {
			this.updateStatusBarColor(controller.getStatus().mode);
		}
	}
}

registerWorkbenchContribution2(VimStatusbarContribution.ID, VimStatusbarContribution, WorkbenchPhase.BlockStartup);
