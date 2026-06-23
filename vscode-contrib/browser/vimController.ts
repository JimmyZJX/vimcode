import { IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import * as nls from '../../../../nls.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, RawContextKey, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import type { ContextKeyExpression, IContextKeyServiceTarget } from '../../../../platform/contextkey/common/contextkey.js';
import { IExtensionManagementService, IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ResultKind } from '../../../../platform/keybinding/common/keybindingResolver.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorCommand, registerEditorCommand } from '../../../browser/editorExtensions.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { CursorChangeReason, CursorSelectionStartKind, ICursorSelectionChangedEvent } from '../../../common/cursorEvents.js';
import { IModelContentChangedEvent } from '../../../common/textModelEvents.js';
import type { ITextModel } from '../../../common/model.js';
import { RemapTimeoutKey, VimCommandMapping, VimConfiguration, VimKeyRemapping, defaultVimHandleKeys, layeredConfigValueFromSources } from '../common/config.js';
import type { VimSystemClipboard } from '../common/registers.js';
import { Vim, VimGlobalState, VimModelState, VimStatus } from '../common/vim.js';
import type { EditorSyncResult, KeyPlan } from '../common/vim.js';
import { VSCodeVimClipboard } from './vscodeClipboard.js';
import { VSCodeVimEditor } from './vscodeVimEditor.js';

const VimEnabledContext = new RawContextKey<boolean>('vim.enabled', false, true);
const VimCodeEnabledContext = new RawContextKey<boolean>('vimcode.enabled', false, true);
const VimActiveContext = new RawContextKey<boolean>('vim.active', false, true);
const VimModeContext = new RawContextKey<string>('vim.mode', 'Normal', true);
const VimNormalContext = new RawContextKey<boolean>('vim.normal', true, true);
const VimInsertContext = new RawContextKey<boolean>('vim.insert', false, true);
const VimPendingContext = new RawContextKey<boolean>('vim.pending', false, true);
const VimOperatorContext = new RawContextKey<string>('vim.operator', '', true);
const VimChordContext = new RawContextKey<string>('vim.chord', '', true);

const VimNativePassthroughCommands = new Set([
	'selectNextSuggestion',
	'selectPrevSuggestion',
	'showNextParameterHint',
	'showPrevParameterHint',
]);

let vimRemapCommandRegistered = false;

function registerVimRemapCommandOnce(): void {
	if (vimRemapCommandRegistered) {
		return;
	}
	vimRemapCommandRegistered = true;
	const VimCommand = EditorCommand.bindToContribution<VimController>(editor => editor.getContribution<VimController>(VimController.ID));
	registerEditorCommand(new VimCommand({
		id: 'vim.remap',
		precondition: undefined,
		handler: (controller, args) => controller.runRemapCommand(args),
	}));
}

type NativeCursorAppearance = {
	cursorStyle: ReturnType<ICodeEditor['getRawOptions']>['cursorStyle'];
	cursorBlinking: NonNullable<ReturnType<ICodeEditor['getRawOptions']>['cursorBlinking']>;
};

type VimContextKeys = {
	active: IContextKey<boolean>;
	mode: IContextKey<string>;
	normal: IContextKey<boolean>;
	insert: IContextKey<boolean>;
	pending: IContextKey<boolean>;
	operator: IContextKey<string>;
	chord: IContextKey<string>;
};

class VimModelStateStore {
	private readonly entries = new Map<string, { state: VimModelState; disposeListener: IDisposable }>();

	getOrCreate(model: ITextModel): VimModelState {
		const key = model.uri.toString();
		let entry = this.entries.get(key);
		if (entry === undefined) {
			const disposeListener = model.onWillDispose(() => {
				disposeListener.dispose();
				this.entries.delete(key);
			});
			entry = { state: new VimModelState(), disposeListener };
			this.entries.set(key, entry);
		}
		return entry.state;
	}
}

export class VimController extends Disposable {
	public static readonly ID = 'editor.contrib.vim';
	private static readonly globalState = new VimGlobalState();
	private static readonly modelStateStore = new VimModelStateStore();
	private static warnedAboutVSCodeVim = false;

	private readonly vimClipboard: VSCodeVimClipboard;
	private readonly vimEditor: VSCodeVimEditor;
	private readonly vim: Vim;
	private readonly asyncKeyQueue = new AsyncKeyQueue();
	private vimContexts: VimContextKeys | undefined = undefined;
	private enabled = false;
	private remapTimeout: ReturnType<typeof setTimeout> | undefined;
	private remapTimeoutGeneration = 0;
	private readonly whenExpressionCache = new Map<string, ContextKeyExpression | undefined>();
	private pendingUndoRedoContentSync = false;
	private nativeCursorAppearance: NativeCursorAppearance | undefined = undefined;
	private appliedCursorBlinking: 'vim-solid' | 'original' | undefined = undefined;
	private appliedPendingCursorInset: string | undefined = undefined;
	private restoringNativeCursor = false;
	private readonly _onDidChangeStatus = this._register(new Emitter<VimStatus>());
	readonly onDidChangeStatus: Event<VimStatus> = this._onDidChangeStatus.event;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly contextKeyService: IContextKeyService,
		clipboardService: IClipboardService,
		private readonly commandService: ICommandService,
		private readonly configurationService: IConfigurationService,
		private readonly keybindingService: IKeybindingService,
		private readonly extensionManagementService: IExtensionManagementService,
		private readonly extensionEnablementService: IGlobalExtensionEnablementService,
		private readonly notificationService: INotificationService,
		private readonly logService: ILogService
	) {
		super();
		this.vimClipboard = new VSCodeVimClipboard(clipboardService);
		this.vimEditor = new VSCodeVimEditor(editor, this.commandService, message => this.logUndo(message));
		this.vim = new Vim(this.vimEditor, this.readVimCompatibilityConfiguration(), VimController.globalState);
		this.updateEnabledState();
		this._register(this.editor.onKeyDown(event => this.handleKeyDown(event)));
		this._register(this.editor.onDidFocusEditorText(() => this.syncEditorState()));
		this._register(this.editor.onDidChangeCursorSelection(event => this.handleCursorSelectionChanged(event)));
		this._register(this.editor.onDidChangeModelContent(event => this.handleModelContentChanged(event)));
		this._register(this.editor.onDidChangeModel(() => this.handleEditorModelChanged()));
		this._register(this.extensionManagementService.onDidInstallExtensions(() => {
			if (this.enabled) this.warnIfVSCodeVimEnabled();
		}));
		this._register(this.extensionEnablementService.onDidChangeEnablement(() => {
			if (this.enabled) this.warnIfVSCodeVimEnabled();
		}));
		this._register(this.configurationService.onDidChangeConfiguration(() => {
			this.vim.setConfiguration(this.readVimCompatibilityConfiguration());
			this.updateEnabledState();
		}));
		this._register(this.editor.onDidChangeConfiguration(event => {
			// The workbench re-applies configuration-derived editor options (on
			// first open and on settings changes), clobbering the Vim cursor
			// appearance underneath the change-guards. Invalidate the guards and
			// re-apply. Re-entrancy terminates: our own re-apply either changes
			// nothing (no event) or settles on the Vim value (next pass no-ops).
			const cursorAppearanceChanged = event.hasChanged(EditorOption.cursorStyle) || event.hasChanged(EditorOption.cursorBlinking);
			if (cursorAppearanceChanged) {
				this.vimEditor.clearAppliedCursorStyle();
				this.appliedCursorBlinking = undefined;
				if (this.enabled && !this.restoringNativeCursor) {
					this.syncCursorAppearance(this.vim.status);
				}
			}
			if (event.hasChanged(EditorOption.readOnly) && this.enabled) {
				this.syncStatus();
			}
		}));
	}

	getStatus(): VimStatus {
		return this.vim.status;
	}

	runRemapCommand(args: unknown): void {
		if (!this.enabled || !this.hasModel()) {
			return;
		}
		const remap = readRemapCommandArgs(args);
		if (remap === undefined) {
			throw new Error("vim.remap requires args with an optional 'after': string[] and/or 'commands': ({ command: string; args?: unknown | unknown[] } | string)[]");
		}
		void this.asyncKeyQueue.enqueue(async () => {
			this.vim.executeExternalRemap(remap);
			if (!this.vim.status.pending) {
				this.vimEditor.revealPrimaryCursorIfOutsideViewport();
				this.syncEditorState();
			} else {
				this.syncStatus();
			}
		}).then(undefined, () => this.syncStatus());
	}

	isVimEnabled(): boolean {
		return this.enabled;
	}

	override dispose(): void {
		this.clearRemapTimeout();
		this.vimEditor.flushUndoTransaction();
		this.vimEditor.dispose();
		this.syncDisabledStatus();
		this.restoreNativeCursorAppearance();
		super.dispose();
	}

	private rememberNativeCursorAppearance(): void {
		const rawOptions = this.editor.getRawOptions();
		this.nativeCursorAppearance = {
			cursorStyle: rawOptions.cursorStyle,
			cursorBlinking: rawOptions.cursorBlinking ?? 'blink',
		};
	}

	private restoreNativeCursorAppearance(): void {
		const nativeCursorAppearance = this.nativeCursorAppearance;
		this.nativeCursorAppearance = undefined;
		this.appliedCursorBlinking = undefined;
		this.vimEditor.clearAppliedCursorStyle();
		this.syncPendingCursorInset(undefined);
		if (nativeCursorAppearance === undefined) {
			return;
		}
		// `dispose` restores while `this.enabled` is still true; keep the
		// option-change listener from re-applying the Vim cursor on top.
		this.restoringNativeCursor = true;
		try {
			this.editor.updateOptions({
				cursorStyle: nativeCursorAppearance.cursorStyle,
				cursorBlinking: nativeCursorAppearance.cursorBlinking,
			});
		} finally {
			this.restoringNativeCursor = false;
		}
	}

	private isEnabled(): boolean {
		return this.readCompatibilityConfigValue('enabled') === true;
	}

	private setGlobalEnabledContexts(enabled: boolean, options: { mirrorVimEnabled: boolean }): void {
		void this.commandService.executeCommand('_setContext', VimCodeEnabledContext.key, enabled);
		if (options.mirrorVimEnabled) {
			void this.commandService.executeCommand('_setContext', VimEnabledContext.key, enabled);
		}
	}

	private ensureVimContextKeys(): VimContextKeys {
		if (this.vimContexts === undefined) {
			this.vimContexts = {
				active: VimActiveContext.bindTo(this.contextKeyService),
				mode: VimModeContext.bindTo(this.contextKeyService),
				normal: VimNormalContext.bindTo(this.contextKeyService),
				insert: VimInsertContext.bindTo(this.contextKeyService),
				pending: VimPendingContext.bindTo(this.contextKeyService),
				operator: VimOperatorContext.bindTo(this.contextKeyService),
				chord: VimChordContext.bindTo(this.contextKeyService),
			};
		}
		return this.vimContexts;
	}

	private updateEnabledState(): void {
		const enabled = this.isEnabled();
		const wasEnabled = this.enabled;
		// Only snapshot/restore cursor options around an enabled Vim session. When
		// Vim is disabled, this contribution must not write editor options or it
		// can clobber native setting changes.
		if (enabled && !wasEnabled) {
			this.rememberNativeCursorAppearance();
		}
		this.enabled = enabled;
		// Keep the default disabled startup path inert for users of the VSCodeVim
		// extension: do not write the shared `vim.enabled` context key until
		// vimcode has actually taken ownership. Once vimcode is active, mirror it
		// for VSCodeVim-compatible when-clauses and clear it when toggling away
		// from vimcode. Users switching back to VSCodeVim should reload the window.
		this.setGlobalEnabledContexts(enabled, { mirrorVimEnabled: enabled || wasEnabled });
		if (enabled) {
			registerVimRemapCommandOnce();
			this.attachCurrentModelState();
			this.warnIfVSCodeVimEnabled();
			this.syncEditorState();
		} else {
			this.editor.getContainerDomNode().classList.remove('vim-character-mode-enabled');
			if (wasEnabled) {
				this.vimEditor.flushUndoTransaction();
				this.restoreNativeCursorAppearance();
			}
			this.syncDisabledStatus();
			// `syncDisabledStatus` only resets context keys; notify status
			// listeners (the workbench status bar entry) about the transition
			// so they can hide themselves.
			this._onDidChangeStatus.fire(this.vim.status);
		}
	}

	private logUndo(message: string): void {
		if (this.readCompatibilityConfigValue('debugUndo') === true) {
			this.logService.info(`[vimcode.undo] ${message}`);
		}
	}

	private shouldLogVisual(): boolean {
		return this.readCompatibilityConfigValue('debugVisual') === true;
	}

	private logVisual(message: string): void {
		if (this.shouldLogVisual()) {
			this.logService.info(`[vimcode.visual] ${message}`);
		}
	}

	private warnIfVSCodeVimEnabled(): void {
		if (VimController.warnedAboutVSCodeVim) return;
		this.extensionManagementService.getInstalled().then(extensions => {
			const vsCodeVim = extensions.find(extension => extension.identifier.id.toLowerCase() === 'vscodevim.vim');
			if (vsCodeVim === undefined) return;

			const disabledExtensions = this.extensionEnablementService.getDisabledExtensions();
			const vsCodeVimIsDisabled = disabledExtensions.some(extension => extension.id.toLowerCase() === vsCodeVim.identifier.id.toLowerCase());
			if (!vsCodeVimIsDisabled && this.enabled && !VimController.warnedAboutVSCodeVim) {
				VimController.warnedAboutVSCodeVim = true;
				this.notificationService.warn(nls.localize(
					'vim.vscodevimConflict',
					"vimcode is enabled while the VSCodeVim extension is enabled. Disable one of them to avoid conflicting Vim key handling."
				));
			}
		}, () => undefined);
	}

	private readVimCompatibilityConfiguration(): Partial<VimConfiguration> {
		const vimConfig = this.configurationService.getValue<Record<string, unknown>>('vim') ?? {};
		const vimcodeConfig = this.readConfiguredConfigSection('vimcode');
		const configSources = [vimConfig, vimcodeConfig];
		const useCtrlKeys = this.readCompatibilityConfigValue('useCtrlKeys');
		const useSystemClipboard = this.readCompatibilityConfigValue('useSystemClipboard');
		const timeout = this.readCompatibilityConfigValue('timeout');
		const visualMultilineInsert = this.readCompatibilityConfigValue('visualMultilineInsert');
		const easymotion = this.readCompatibilityConfigValue('easymotion');
		const easymotionKeys = this.readCompatibilityConfigValue('easymotionKeys');
		const easymotionJumpToAnywhereRegex = this.readCompatibilityConfigValue('easymotionJumpToAnywhereRegex');
		const leader = this.readCompatibilityConfigValue('leader');
		return {
			leader: typeof leader === 'string' ? leader : undefined,
			useCtrlKeys: typeof useCtrlKeys === 'boolean' ? useCtrlKeys : undefined,
			useSystemClipboard: typeof useSystemClipboard === 'boolean' ? useSystemClipboard : undefined,
			timeout: typeof timeout === 'number' ? timeout : undefined,
			visualMultilineInsert: typeof visualMultilineInsert === 'boolean' ? visualMultilineInsert : undefined,
			easymotion: typeof easymotion === 'boolean' ? easymotion : undefined,
			easymotionKeys: typeof easymotionKeys === 'string' ? easymotionKeys : undefined,
			easymotionJumpToAnywhereRegex: typeof easymotionJumpToAnywhereRegex === 'string' ? easymotionJumpToAnywhereRegex : undefined,
			handleKeys: readHandleKeys(layeredConfigValueFromSources([{ handleKeys: defaultVimHandleKeys }, ...configSources], 'handleKeys')),
			normalModeKeyBindings: readRemaps(layeredConfigValueFromSources(configSources, 'normalModeKeyBindings')),
			normalModeKeyBindingsNonRecursive: readRemaps(layeredConfigValueFromSources(configSources, 'normalModeKeyBindingsNonRecursive')),
			insertModeKeyBindings: readRemaps(layeredConfigValueFromSources(configSources, 'insertModeKeyBindings')),
			insertModeKeyBindingsNonRecursive: readRemaps(layeredConfigValueFromSources(configSources, 'insertModeKeyBindingsNonRecursive')),
			visualModeKeyBindings: readRemaps(layeredConfigValueFromSources(configSources, 'visualModeKeyBindings')),
			visualModeKeyBindingsNonRecursive: readRemaps(layeredConfigValueFromSources(configSources, 'visualModeKeyBindingsNonRecursive')),
			operatorPendingModeKeyBindings: readRemaps(layeredConfigValueFromSources(configSources, 'operatorPendingModeKeyBindings')),
			operatorPendingModeKeyBindingsNonRecursive: readRemaps(layeredConfigValueFromSources(configSources, 'operatorPendingModeKeyBindingsNonRecursive')),
		};
	}

	private readCompatibilityConfigValue(key: string): unknown {
		const vimcodeValue = this.readConfiguredConfigValue(`vimcode.${key}`);
		return vimcodeValue !== undefined ? vimcodeValue : this.configurationService.getValue<unknown>(`vim.${key}`);
	}

	private readConfiguredConfigSection(section: string): Record<string, unknown> {
		const inspected = this.configurationService.inspect<Record<string, unknown>>(section);
		return Object.assign(
			{},
			...[
				inspected.applicationValue,
				inspected.userValue,
				inspected.userLocalValue,
				inspected.userRemoteValue,
				inspected.workspaceValue,
				inspected.workspaceFolderValue,
				inspected.memoryValue,
				inspected.policyValue,
			].filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value))
		);
	}

	/**
	 * Return a configuration value only when it was explicitly set outside the
	 * schema default. This lets vimcode.* intentionally override vim.* while
	 * avoiding the registered vimcode.* defaults accidentally shadowing a user's
	 * vim.* settings.
	 */
	private readConfiguredConfigValue(key: string): unknown {
		const inspected = this.configurationService.inspect<unknown>(key);
		if (
			inspected.applicationValue === undefined
			&& inspected.userValue === undefined
			&& inspected.userLocalValue === undefined
			&& inspected.userRemoteValue === undefined
			&& inspected.workspaceValue === undefined
			&& inspected.workspaceFolderValue === undefined
			&& inspected.memoryValue === undefined
			&& inspected.policyValue === undefined
		) {
			return undefined;
		}
		return inspected.value;
	}

	private handleKeyDown(event: IKeyboardEvent): void {
		if (!this.enabled || !this.hasModel()) {
			return;
		}
		const key = keyFromEvent(event);
		const whenEvaluator = (when: string | undefined) => this.evaluateWhen(when, event.target);
		// When Vim is waiting for the rest of a command (`g`, `d`, a register name,
		// search input, a pending remap, ...), the next key belongs to Vim. Otherwise
		// user/extension VSCode keybindings get first refusal, and Vim only runs if it
		// returns a concrete KeyPlan.
		const vimPending = this.vim.status.pending;
		if (!vimPending && this.shouldLetNativeKeybindingHandle(event)) {
			this.syncReadonlyModeAfterNativeKey();
			return;
		}
		const keyPlan = key === undefined ? null : this.vim.handleKey(key, { whenEvaluator });
		if (keyPlan === null) {
			this.syncReadonlyModeAfterNativeKey();
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		void this.asyncKeyQueue.enqueue(async () => this.runVimKeyPlan(keyPlan)).then(undefined, () => this.syncStatus());
	}


	private syncReadonlyModeAfterNativeKey(): void {
		const mode = this.vim.status.mode;
		if (!this.vimEditor.isReadonly() || (mode !== 'insert' && mode !== 'replace')) {
			return;
		}
		setTimeout(() => {
			if (!this.enabled || !this.hasModel()) return;
			if (this.vim.ensureNormalModeForReadonlyDocument()) {
				this.syncStatus();
			}
		}, 0);
	}

	private evaluateWhen(when: string | undefined, target: IContextKeyServiceTarget | null): boolean {
		if (when === undefined || when.trim().length === 0) {
			return true;
		}
		const expression = this.whenExpression(when);
		if (expression === undefined) {
			return false;
		}
		return expression.evaluate(this.contextKeyService.getContext(target));
	}

	private whenExpression(when: string): ContextKeyExpression | undefined {
		if (!this.whenExpressionCache.has(when)) {
			let expression: ContextKeyExpression | undefined;
			try {
				expression = ContextKeyExpr.deserialize(when);
			} catch (_error) {
				expression = undefined;
			}
			this.whenExpressionCache.set(when, expression);
		}
		return this.whenExpressionCache.get(when);
	}

	private shouldLetNativeKeybindingHandle(event: IKeyboardEvent): boolean {
		const target = event.target;
		if (this.keybindingService.inChordMode) {
			return true;
		}
		const result = this.keybindingService.softDispatch(event, target);
		if (result.kind === ResultKind.NoMatchingKb) {
			return false;
		}
		if (result.kind === ResultKind.MoreChordsNeeded) {
			// Do not let native chord prefixes preempt Vim prefixes (`z`, `g`,
			// `ctrl-w`, ...). If Vim refuses the key, [handleKeyDown] returns without
			// preventing the event, so VSCode can still enter its chord mode.
			return false;
		}
		if (result.commandId === null || result.isBubble) {
			return false;
		}
		return this.hasMatchingUserOrExtensionKeybinding(event, result.commandId, false);
	}

	private hasMatchingUserOrExtensionKeybinding(event: IKeyboardEvent, commandId: string | undefined, prefixOnly: boolean): boolean {
		const resolved = this.keybindingService.resolveKeyboardEvent(event);
		const [firstChord] = resolved.getDispatchChords();
		if (firstChord === null) {
			return false;
		}
		const context = this.contextKeyService.getContext(event.target);
		return this.keybindingService.getKeybindings().some(keybinding => {
			if (commandId !== undefined && keybinding.command !== commandId) {
				return false;
			}
			if (keybinding.command === null || keybinding.chords[0] !== firstChord) {
				return false;
			}
			if (prefixOnly !== (keybinding.chords.length > 1)) {
				return false;
			}
			if (keybinding.when !== undefined && !keybinding.when.evaluate(context)) {
				return false;
			}
			return VimNativePassthroughCommands.has(keybinding.command)
				|| !keybinding.isDefault
				|| (keybinding.extensionId !== null && !keybinding.isBuiltinExtension);
		});
	}

	private async runVimKeyPlan(keyPlan: KeyPlan): Promise<void> {
		const clipboard = new ClipboardTransaction(this.vimClipboard);
		await clipboard.with(async () => {
			await keyPlan.run({ clipboard });
		});
		if (await this.vimEditor.waitForNativeSelectionSync()) {
			this.vimEditor.invalidateCachedSelections();
			const result = this.vim.syncFromEditorState({ canonicalizeVisualSelection: true });
			this.logVisualSyncDecision('nativeCommand', result);
		}
		if (!this.vim.status.pending) {
			this.vimEditor.revealPrimaryCursorIfOutsideViewport();
			this.syncEditorState();
		} else {
			this.syncStatus();
		}
	}

	private handleCursorSelectionChanged(event: ICursorSelectionChangedEvent): void {
		if (!this.enabled || !this.hasModel() || this.vimEditor.isExecutingNativeCommand?.()) return;
		const selections = [event.selection, ...event.secondarySelections];
		if (this.isModelMarkerRecoveryNoise(event)) {
			return;
		}
		if (event.source.startsWith('vim')) {
			return;
		}
		this.logUndo(`selection event source=${event.source} reason=${cursorChangeReasonName(event.reason)} selections=${formatVSCodeSelections(selections)}`);
		if (event.source === 'mouse' && this.shouldLogVisual()) {
			this.logVisual(`mouse selection reason=${cursorChangeReasonName(event.reason)} mode=${this.vim.mode} native=${formatVSCodeSelections(selections)}`);
		}
		if (event.reason === CursorChangeReason.Undo || event.reason === CursorChangeReason.Redo) {
			this.pendingUndoRedoContentSync = false;
			this.syncFromUndoRedoState(`selection:${cursorChangeReasonName(event.reason)}`);
			return;
		}
		// VSCode-specific synchronization path: unlike Zed, VSCode selection state
		// can be changed outside the Vim state machine (mouse selections, multicursor
		// commands, other editor contributions). Ignore native cursor movement while
		// insert/replace mode is intentionally letting VSCode handle typed input.
		if (this.vim.mode === 'insert' || this.vim.mode === 'replace') {
			return;
		}
		this.handleExternalEditorStateChanged(event.source, {
			oneCharacterSelection: event.source === 'mouse' && event.selectionStartKind === CursorSelectionStartKind.Word
				? 'visual'
				: 'collapse',
		});
	}

	private isModelMarkerRecoveryNoise(event: ICursorSelectionChangedEvent): boolean {
		if (event.source !== 'modelChange' || event.reason !== CursorChangeReason.RecoverFromMarkers) {
			return false;
		}
		// Marker recovery is VSCode adjusting cursor/selection markers after model edits
		// such as log-file appends. Treat it as authoritative for insert/replace via the
		// existing early return above, but do not let it churn normal-mode cursors or
		// rewrite an active Vim visual selection.
		if (this.vim.mode === 'visual' || this.vim.mode === 'visualLine' || this.vim.mode === 'visualBlock') {
			return true;
		}
		return this.vim.mode === 'normal'
			&& [event.selection, ...event.secondarySelections].every(selection =>
				selection.selectionStartLineNumber === selection.positionLineNumber
				&& selection.selectionStartColumn === selection.positionColumn);
	}

	private handleModelContentChanged(event: IModelContentChangedEvent): void {
		if (!this.enabled || !this.hasModel() || this.vimEditor.isExecutingNativeCommand?.() || (!event.isUndoing && !event.isRedoing)) return;
		this.logUndo(`content event undo=${event.isUndoing} redo=${event.isRedoing} version=${event.versionId} changes=${event.changes.length} native=${formatVSCodeSelections(this.editor.getSelections() ?? [])}`);
		this.pendingUndoRedoContentSync = true;
		queueMicrotask(() => {
			if (!this.pendingUndoRedoContentSync) return;
			this.pendingUndoRedoContentSync = false;
			this.syncFromUndoRedoState(event.isUndoing ? 'content:undo' : 'content:redo');
		});
	}

	private handleEditorModelChanged(): void {
		if (!this.enabled || this.vimEditor.isExecutingNativeCommand?.()) return;
		this.pendingUndoRedoContentSync = false;
		this.vimEditor.flushUndoTransaction();
		this.vimEditor.detachFromModel();
		if (!this.attachCurrentModelState()) {
			this.syncDetachedStatus();
			return;
		}
		this.handleExternalEditorStateChanged('model');
	}

	private handleExternalEditorStateChanged(source?: string, options: { oneCharacterSelection?: 'collapse' | 'visual' } = {}): void {
		if (!this.enabled || this.vimEditor.isExecutingNativeCommand?.()) return;
		if (!this.hasModel()) {
			this.pendingUndoRedoContentSync = false;
			this.vimEditor.flushUndoTransaction();
			this.vimEditor.detachFromModel();
			this.syncDetachedStatus();
			return;
		}
		this.vimEditor.invalidateCachedSelections();
		const result = this.vim.syncFromEditorState(options);
		this.logVisualSyncDecision(source ?? 'external', result);
		this.syncEditorState();
	}

	private syncFromUndoRedoState(reason: string): void {
		if (!this.enabled) {
			this.pendingUndoRedoContentSync = false;
			this.syncDisabledStatus();
			return;
		}
		if (!this.hasModel()) {
			this.pendingUndoRedoContentSync = false;
			this.syncDetachedStatus();
			return;
		}
		this.logUndo(`syncFromUndoRedoState start reason=${reason} native=${formatVSCodeSelections(this.editor.getSelections() ?? [])} mode=${this.vim.mode}`);
		this.vimEditor.invalidateCachedSelections();
		const result = this.vim.syncFromUndoRedoState();
		this.logVisualSyncDecision(`undoRedo:${reason}`, result);
		this.logUndo(`syncFromUndoRedoState end reason=${reason} native=${formatVSCodeSelections(this.editor.getSelections() ?? [])} mode=${this.vim.mode}`);
		this.syncEditorState();
	}

	private logVisualSyncDecision(source: string, result: EditorSyncResult): void {
		if (!this.shouldLogVisual()) return;
		this.logVisual(`sync source=${source} mode=${result.mode} selectionCount=${result.selectionCount} visualSelectionFound=${result.visualSelectionFound} adopted=${result.adoptedVisualSelection} reason=${result.reason}`);
	}

	private syncEditorState(): void {
		if (!this.enabled) {
			this.syncDisabledStatus();
			return;
		}
		if (!this.hasModel()) {
			this.syncDetachedStatus();
			return;
		}
		this.syncStatus();
	}

	private hasModel(): boolean {
		return this.editor.getModel() !== null;
	}

	private attachCurrentModelState(): boolean {
		const model = this.editor.getModel();
		if (model === null) return false;
		this.vim.attachModelState(VimController.modelStateStore.getOrCreate(model));
		return true;
	}

	private syncDetachedStatus(): void {
		const status = this.vim.status;
		const contexts = this.ensureVimContextKeys();
		this.clearRemapTimeout();
		this.vimEditor.setInsertPendingText(undefined);
		this.editor.getContainerDomNode().classList.remove('vim-character-mode-enabled');
		contexts.active.set(true);
		contexts.mode.set(vscodeVimModeContextValue(status));
		contexts.normal.set(status.mode === 'normal');
		contexts.insert.set(status.mode === 'insert');
		contexts.pending.set(status.pending);
		contexts.operator.set(status.operator ?? '');
		contexts.chord.set(status.chord);
	}

	private syncDisabledStatus(): void {
		this.clearRemapTimeout();
		this.vimEditor.setInsertPendingText(undefined);
		this.editor.getContainerDomNode().classList.remove('vim-character-mode-enabled');
		const contexts = this.vimContexts;
		if (contexts === undefined) {
			return;
		}
		contexts.active.set(false);
		contexts.mode.set('Disabled');
		contexts.normal.set(false);
		contexts.insert.set(false);
		contexts.pending.set(false);
		contexts.operator.set('');
		contexts.chord.set('');
	}

	private syncStatus(): void {
		if (!this.enabled) {
			this.syncDisabledStatus();
			return;
		}
		this.vim.ensureNormalModeForReadonlyDocument();
		const status = this.vim.status;
		const contexts = this.ensureVimContextKeys();
		this.editor.getContainerDomNode().classList.toggle('vim-character-mode-enabled', status.mode !== 'insert' && status.mode !== 'replace');
		contexts.active.set(true);
		contexts.mode.set(vscodeVimModeContextValue(status));
		contexts.normal.set(status.mode === 'normal');
		contexts.insert.set(status.mode === 'insert');
		contexts.pending.set(status.pending);
		contexts.operator.set(status.operator ?? '');
		contexts.chord.set(status.chord);
		this.syncCursorAppearance(status);
		this.vimEditor.setInsertPendingText(status.insertPendingText);
		this.updateRemapTimeout(status);
		this._onDidChangeStatus.fire(status);
	}

	// Vim cursor language:
	// - normal: block, native blinking (the editor is idle and ready);
	// - normal waiting for more keys (pending operator, `f`/`r`/mark/register
	//   chords, `g`/`z` prefixes, remaps, counts): solid half-height block
	//   (gvim's operator-pending `o:hor50` guicursor shape, rendered natively
	//   by the `vim-half-block-cursor.patch` instead of VSCodeVim's CSS
	//   decoration hack);
	// - visual modes: solid block (the rendered cursor cell sits inside a
	//   selection; blinking there reads as flicker, and VSCodeVim's
	//   decoration-based visual cursor is also non-blinking);
	// - insert: bar with native blinking; replace: underline with native
	//   blinking (gvim `r:hor20`, VSCodeVim uses underline too).
	private syncCursorAppearance(status: VimStatus): void {
		// `status.pending` is the same signal that puts a pending chord in the
		// status bar; an active operator always implies it.
		const operatorPending = status.mode === 'normal' && (status.pending || status.operator !== undefined);
		const visual = status.mode === 'visual' || status.mode === 'visualLine' || status.mode === 'visualBlock';
		this.vimEditor.setCursorStyle(
			status.mode === 'insert' ? 'line'
				: status.mode === 'replace' ? 'underline'
					: operatorPending ? 'half-block'
						: 'block');
		const blinking = visual || operatorPending ? 'vim-solid' : 'original';
		if (blinking !== this.appliedCursorBlinking) {
			this.appliedCursorBlinking = blinking;
			this.editor.updateOptions({
				cursorBlinking: blinking === 'vim-solid' ? 'solid' : (this.nativeCursorAppearance?.cursorBlinking ?? 'blink'),
			});
		}
		// The pending cursor shrinks geometrically with the pending-stack
		// depth: height (2/3)^n of the cell at depth n (`d` -> 2/3, `d3` ->
		// 4/9, ...; `2` and `21` are the same depth), floored so it stays
		// visible. The half-block render patch reads the clip inset from this
		// custom property (defaulting to 50%).
		this.syncPendingCursorInset(
			operatorPending ? `${pendingCursorClipInsetPercent(status.pendingDepth)}%` : undefined);
	}

	private syncPendingCursorInset(inset: string | undefined): void {
		if (inset === this.appliedPendingCursorInset) {
			return;
		}
		this.appliedPendingCursorInset = inset;
		const containerStyle = this.editor.getContainerDomNode().style;
		if (inset === undefined) {
			containerStyle.removeProperty('--vimcode-pending-cursor-inset');
		} else {
			containerStyle.setProperty('--vimcode-pending-cursor-inset', inset);
		}
	}

	private updateRemapTimeout(status: VimStatus): void {
		this.clearRemapTimeout();
		if (!status.remapPending) return;
		const generation = ++this.remapTimeoutGeneration;
		this.remapTimeout = setTimeout(() => {
			this.remapTimeout = undefined;
			if (generation !== this.remapTimeoutGeneration) return;
			const keyPlan = this.vim.handleKey(RemapTimeoutKey);
			if (keyPlan !== null) {
				void this.asyncKeyQueue.enqueue(async () => this.runVimKeyPlan(keyPlan));
			}
		}, status.remapTimeoutMs);
	}

	private clearRemapTimeout(): void {
		this.remapTimeoutGeneration++;
		if (this.remapTimeout !== undefined) {
			clearTimeout(this.remapTimeout);
			this.remapTimeout = undefined;
		}
	}

}

class AsyncKeyQueue {
	private tail: Promise<void> = Promise.resolve();

	enqueue(task: () => Promise<void>): Promise<void> {
		const next = this.tail.then(task, task);
		this.tail = next.then(undefined, () => undefined);
		return next;
	}
}

class ClipboardTransaction implements VimSystemClipboard {
	private contents: string | undefined;
	private pendingWrite: string | undefined;

	constructor(private readonly clipboard: VSCodeVimClipboard) { }

	async readText(): Promise<string> {
		if (this.contents === undefined) {
			this.contents = await this.clipboard.readTextAsync();
		}
		return this.contents;
	}

	writeText(text: string): void {
		this.contents = text;
		this.pendingWrite = text;
	}

	async with<T>(task: () => Promise<T>): Promise<T> {
		try {
			return await task();
		} finally {
			if (this.pendingWrite !== undefined) {
				await this.clipboard.writeTextAsync(this.pendingWrite);
			}
		}
	}
}

function vscodeVimModeContextValue(status: VimStatus): string {
	const suffix = status.pending ? '+' : '';
	switch (status.mode) {
		case 'normal':
			return `Normal${suffix}`;
		case 'insert':
			return `Insert${suffix}`;
		case 'replace':
			return `Replace${suffix}`;
		case 'search':
			return 'Search';
		case 'command':
			return 'Command';
		case 'visual':
			return `Visual${suffix}`;
		case 'visualLine':
			return `VisualLine${suffix}`;
		case 'visualBlock':
			return `VisualBlock${suffix}`;
		case 'helixNormal':
			return `HelixNormal${suffix}`;
		case 'helixSelect':
			return `HelixSelect${suffix}`;
		default:
			return `Unknown${suffix}`;
	}
}

function formatVSCodeSelections(selections: readonly { selectionStartLineNumber: number; selectionStartColumn: number; positionLineNumber: number; positionColumn: number }[]): string {
	return `[${selections.map(selection => `${selection.selectionStartLineNumber}:${selection.selectionStartColumn}->${selection.positionLineNumber}:${selection.positionColumn}`).join(', ')}]`;
}

function cursorChangeReasonName(reason: CursorChangeReason): string {
	switch (reason) {
		case CursorChangeReason.NotSet:
			return 'NotSet';
		case CursorChangeReason.ContentFlush:
			return 'ContentFlush';
		case CursorChangeReason.RecoverFromMarkers:
			return 'RecoverFromMarkers';
		case CursorChangeReason.Explicit:
			return 'Explicit';
		case CursorChangeReason.Paste:
			return 'Paste';
		case CursorChangeReason.Undo:
			return 'Undo';
		case CursorChangeReason.Redo:
			return 'Redo';
		default:
			return `Unknown(${reason})`;
	}
}

function readHandleKeys(value: unknown): Record<string, boolean> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
}

function readRemapCommandArgs(value: unknown): { after?: readonly string[]; commands?: readonly VimCommandMapping[] } | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	const args = value as { after?: unknown; commands?: unknown };
	const after = Array.isArray(args.after) && args.after.every(key => typeof key === 'string')
		? args.after
		: undefined;
	const commands = Array.isArray(args.commands) ? readRemapCommands(args.commands) : undefined;
	return after !== undefined || commands !== undefined ? { after, commands } : undefined;
}

function readRemaps(value: unknown): VimKeyRemapping[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(item => {
		if (typeof item !== 'object' || item === null) return [];
		const remap = item as { before?: unknown; after?: unknown; commands?: unknown; silent?: unknown; recursive?: unknown; when?: unknown };
		if (!Array.isArray(remap.before) || !remap.before.every(key => typeof key === 'string')) return [];
		return [{
			before: remap.before,
			after: Array.isArray(remap.after) && remap.after.every(key => typeof key === 'string') ? remap.after : undefined,
			commands: Array.isArray(remap.commands) ? readRemapCommands(remap.commands) : undefined,
			silent: typeof remap.silent === 'boolean' ? remap.silent : undefined,
			recursive: typeof remap.recursive === 'boolean' ? remap.recursive : undefined,
			when: typeof remap.when === 'string' ? remap.when : undefined,
		}];
	});
}

function shiftedDigitKey(digit: number): string {
	const shiftedDigits = [')', '!', '@', '#', '$', '%', '^', '&', '*', '('];
	return shiftedDigits[digit] ?? String(digit);
}

function readRemapCommands(commands: unknown[]): VimKeyRemapping['commands'] {
	const result: VimCommandMapping[] = [];
	for (const command of commands) {
		if (typeof command === 'string') {
			result.push(command);
			continue;
		}
		if (typeof command !== 'object' || command === null) {
			continue;
		}
		const commandObject = command as { command?: unknown; args?: unknown };
		if (typeof commandObject.command === 'string') {
			result.push({
				command: commandObject.command,
				args: Array.isArray(commandObject.args)
					? commandObject.args
					: commandObject.args === undefined ? undefined : [commandObject.args],
			});
		}
	}
	return result;
}

function keyNameFromKeyCode(keyCode: KeyCode, shiftKey: boolean): string | undefined {
	switch (keyCode) {
		case KeyCode.LeftArrow:
			return 'left';
		case KeyCode.RightArrow:
			return 'right';
		case KeyCode.UpArrow:
			return 'up';
		case KeyCode.DownArrow:
			return 'down';
		case KeyCode.Home:
			return 'home';
		case KeyCode.End:
			return 'end';
		case KeyCode.PageUp:
			return 'pageup';
		case KeyCode.PageDown:
			return 'pagedown';
		case KeyCode.Escape:
			return '<escape>';
		case KeyCode.Enter:
			return 'enter';
		case KeyCode.Backspace:
			return 'backspace';
		case KeyCode.Delete:
			return 'delete';
		case KeyCode.Insert:
			return 'insert';
		case KeyCode.Space:
			return 'space';
		case KeyCode.Semicolon:
			return shiftKey ? ':' : ';';
		case KeyCode.Quote:
			return shiftKey ? '"' : '\'';
		case KeyCode.Comma:
			return shiftKey ? '<' : ',';
		case KeyCode.Period:
			return shiftKey ? '>' : '.';
		case KeyCode.Slash:
			return shiftKey ? '?' : '/';
		case KeyCode.Backquote:
			return shiftKey ? '~' : '`';
		case KeyCode.BracketLeft:
			return shiftKey ? '{' : '[';
		case KeyCode.BracketRight:
			return shiftKey ? '}' : ']';
		case KeyCode.Backslash:
			return shiftKey ? '|' : '\\';
		case KeyCode.Minus:
			return shiftKey ? '_' : '-';
		case KeyCode.Equal:
			return shiftKey ? '+' : '=';
		default:
			return undefined;
	}
}

// Height (2/3)^n of the cell, expressed as the clip inset from the top,
// floored at 1/8 of the cell so deep pending stacks keep a visible cursor.
function pendingCursorClipInsetPercent(pendingDepth: number): number {
	const height = Math.max(1 / 8, Math.pow(2 / 3, Math.max(1, pendingDepth)));
	return Math.round((1 - height) * 1000) / 10;
}

function keyFromEvent(event: IKeyboardEvent): string | undefined {
	if (event.altKey || event.metaKey) {
		return undefined;
	}
	if (event.ctrlKey) {
		if (event.shiftKey) {
			return undefined;
		}
		switch (event.keyCode) {
			case KeyCode.LeftArrow:
				return 'ctrl-left';
			case KeyCode.RightArrow:
				return 'ctrl-right';
			case KeyCode.Home:
				return 'ctrl-home';
			case KeyCode.End:
				return 'ctrl-end';
			case KeyCode.PageUp:
				return 'ctrl-pageup';
			case KeyCode.PageDown:
				return 'ctrl-pagedown';
			case KeyCode.BracketLeft:
				return 'ctrl-[';
			default:
				break;
		}
		if (event.keyCode >= KeyCode.KeyA && event.keyCode <= KeyCode.KeyZ) {
			const letter = String.fromCharCode('a'.charCodeAt(0) + event.keyCode - KeyCode.KeyA);
			return `ctrl-${letter}`;
		}
		return undefined;
	}

	if (event.keyCode >= KeyCode.KeyA && event.keyCode <= KeyCode.KeyZ) {
		const letter = String.fromCharCode('a'.charCodeAt(0) + event.keyCode - KeyCode.KeyA);
		return event.shiftKey ? letter.toUpperCase() : letter;
	}

	if (event.keyCode >= KeyCode.Digit0 && event.keyCode <= KeyCode.Digit9) {
		const digit = event.keyCode - KeyCode.Digit0;
		return event.shiftKey ? shiftedDigitKey(digit) : String(digit);
	}

	return keyNameFromKeyCode(event.keyCode, event.shiftKey);
}
