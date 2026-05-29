import { IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import * as nls from '../../../../nls.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { RawContextKey, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ResultKind } from '../../../../platform/keybinding/common/keybindingResolver.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICodeEditor } from '../../../browser/editorBrowser.js';
import { CursorChangeReason, ICursorSelectionChangedEvent } from '../../../common/cursorEvents.js';
import { IModelContentChangedEvent } from '../../../common/textModelEvents.js';
import type { ITextModel } from '../../../common/model.js';
import { VimCommandMapping, VimConfiguration, VimKeyRemapping, layeredConfigValue } from '../common/config.js';
import type { VimSystemClipboard } from '../common/registers.js';
import { Vim, VimGlobalState, VimModelState, VimStatus } from '../common/vim.js';
import type { EditorSyncResult } from '../common/vim.js';
import { VSCodeVimClipboard } from './vscodeClipboard.js';
import { VSCodeVimEditor } from './vscodeVimEditor.js';

const VimActiveContext = new RawContextKey<boolean>('vim.active', false, true);
const VimModeContext = new RawContextKey<string>('vim.mode', 'Normal', true);
const VimNormalContext = new RawContextKey<boolean>('vim.normal', true, true);
const VimInsertContext = new RawContextKey<boolean>('vim.insert', false, true);
const VimPendingContext = new RawContextKey<boolean>('vim.pending', false, true);
const VimOperatorContext = new RawContextKey<string>('vim.operator', '', true);
const VimChordContext = new RawContextKey<string>('vim.chord', '', true);

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
	private readonly vimActiveContext: IContextKey<boolean>;
	private readonly vimModeContext: IContextKey<string>;
	private readonly vimNormalContext: IContextKey<boolean>;
	private readonly vimInsertContext: IContextKey<boolean>;
	private readonly vimPendingContext: IContextKey<boolean>;
	private readonly vimOperatorContext: IContextKey<string>;
	private readonly vimChordContext: IContextKey<string>;
	private enabled = false;
	private lastAmbiguousRemapWarningSignature = '';
	private pendingUndoRedoContentSync = false;
	private readonly originalCursorStyle = this.editor.getRawOptions().cursorStyle;
	private readonly _onDidChangeStatus = this._register(new Emitter<VimStatus>());
	readonly onDidChangeStatus: Event<VimStatus> = this._onDidChangeStatus.event;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly contextKeyService: IContextKeyService,
		clipboardService: IClipboardService,
		commandService: ICommandService,
		private readonly configurationService: IConfigurationService,
		private readonly keybindingService: IKeybindingService,
		private readonly extensionManagementService: IExtensionManagementService,
		private readonly notificationService: INotificationService,
		private readonly logService: ILogService
	) {
		super();
		this.vimClipboard = new VSCodeVimClipboard(clipboardService);
		this.vimEditor = new VSCodeVimEditor(editor, commandService, message => this.logUndo(message));
		this.vim = new Vim(this.vimEditor, this.readVimCompatibilityConfiguration(), VimController.globalState);
		this.vimActiveContext = VimActiveContext.bindTo(contextKeyService);
		this.vimModeContext = VimModeContext.bindTo(contextKeyService);
		this.vimNormalContext = VimNormalContext.bindTo(contextKeyService);
		this.vimInsertContext = VimInsertContext.bindTo(contextKeyService);
		this.vimPendingContext = VimPendingContext.bindTo(contextKeyService);
		this.vimOperatorContext = VimOperatorContext.bindTo(contextKeyService);
		this.vimChordContext = VimChordContext.bindTo(contextKeyService);
		this.attachCurrentModelState();
		this.updateEnabledState();
		this._register(this.editor.onKeyDown(event => this.handleKeyDown(event)));
		this._register(this.editor.onDidFocusEditorText(() => this.syncEditorState()));
		this._register(this.editor.onDidChangeCursorSelection(event => this.handleCursorSelectionChanged(event)));
		this._register(this.editor.onDidChangeModelContent(event => this.handleModelContentChanged(event)));
		this._register(this.editor.onDidChangeModel(() => this.handleEditorModelChanged()));
		this._register(this.extensionManagementService.onDidInstallExtensions(() => {
			if (this.enabled) this.warnIfVSCodeVimInstalled();
		}));
		this._register(this.configurationService.onDidChangeConfiguration(() => {
			this.vim.setConfiguration(this.readVimCompatibilityConfiguration());
			this.updateEnabledState();
		}));
	}

	getStatus(): VimStatus {
		return this.vim.status;
	}

	override dispose(): void {
		this.vimEditor.dispose();
		this.syncDisabledStatus();
		this.editor.updateOptions({ cursorStyle: this.originalCursorStyle });
		super.dispose();
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<unknown>('vim.enabled') === true;
	}

	private updateEnabledState(): void {
		const enabled = this.isEnabled();
		this.enabled = enabled;
		if (enabled) {
			this.attachCurrentModelState();
			this.warnIfVSCodeVimInstalled();
			this.logAmbiguousRemapConflicts();
			this.syncEditorState();
		} else {
			this.editor.getContainerDomNode().classList.remove('vim-character-mode-enabled');
			this.editor.updateOptions({ cursorStyle: this.originalCursorStyle });
			this.syncDisabledStatus();
		}
	}

	private logAmbiguousRemapConflicts(): void {
		const conflicts = this.vim.ambiguousRemapConflicts();
		const messages = [...new Set(conflicts.map(conflict =>
			`vim.${conflict.mode} remap ${formatKeySequence(conflict.shorter)} shadows longer remap ${formatKeySequence(conflict.longer)}. vimcode executes the shorter mapping immediately and does not wait for ambiguous-map timeout.`
		))];
		const signature = messages.join('\n');
		if (signature === this.lastAmbiguousRemapWarningSignature) return;
		this.lastAmbiguousRemapWarningSignature = signature;
		for (const message of messages) {
			this.logService.warn(`[vimcode] ${message}`);
		}
	}

	private logUndo(message: string): void {
		if (this.configurationService.getValue<unknown>('vim.debugUndo') === true) {
			this.logService.info(`[vimcode.undo] ${message}`);
		}
	}

	private shouldLogVisual(): boolean {
		return this.configurationService.getValue<unknown>('vim.debugVisual') === true;
	}

	private logVisual(message: string): void {
		if (this.shouldLogVisual()) {
			this.logService.info(`[vimcode.visual] ${message}`);
		}
	}

	private warnIfVSCodeVimInstalled(): void {
		if (VimController.warnedAboutVSCodeVim) return;
		this.extensionManagementService.getInstalled().then(extensions => {
			const hasVSCodeVim = extensions.some(extension => extension.identifier.id.toLowerCase() === 'vscodevim.vim');
			if (hasVSCodeVim && this.enabled && !VimController.warnedAboutVSCodeVim) {
				VimController.warnedAboutVSCodeVim = true;
				this.notificationService.warn(nls.localize(
					'vim.vscodevimConflict',
					"vimcode is enabled while the VSCodeVim extension is installed. Disable one of them to avoid conflicting Vim key handling."
				));
			}
		}, () => undefined);
	}

	private readVimCompatibilityConfiguration(): Partial<VimConfiguration> {
		const vimConfig = this.configurationService.getValue<Record<string, unknown>>('vim') ?? {};
		const useCtrlKeys = this.configurationService.getValue<unknown>('vim.useCtrlKeys');
		const useSystemClipboard = this.configurationService.getValue<unknown>('vim.useSystemClipboard');
		const visualMultilineInsert = this.configurationService.getValue<unknown>('vim.visualMultilineInsert');
		return {
			leader: typeof vimConfig.leader === 'string' ? vimConfig.leader : undefined,
			useCtrlKeys: typeof useCtrlKeys === 'boolean'
				? useCtrlKeys
				: typeof vimConfig.useCtrlKeys === 'boolean' ? vimConfig.useCtrlKeys : undefined,
			useSystemClipboard: typeof useSystemClipboard === 'boolean'
				? useSystemClipboard
				: typeof vimConfig.useSystemClipboard === 'boolean' ? vimConfig.useSystemClipboard : undefined,
			visualMultilineInsert: typeof visualMultilineInsert === 'boolean'
				? visualMultilineInsert
				: typeof vimConfig.visualMultilineInsert === 'boolean' ? vimConfig.visualMultilineInsert : undefined,
			handleKeys: readHandleKeys(layeredConfigValue(vimConfig, 'handleKeys')),
			normalModeKeyBindings: readRemaps(layeredConfigValue(vimConfig, 'normalModeKeyBindings')),
			normalModeKeyBindingsNonRecursive: readRemaps(layeredConfigValue(vimConfig, 'normalModeKeyBindingsNonRecursive')),
			insertModeKeyBindings: readRemaps(layeredConfigValue(vimConfig, 'insertModeKeyBindings')),
			insertModeKeyBindingsNonRecursive: readRemaps(layeredConfigValue(vimConfig, 'insertModeKeyBindingsNonRecursive')),
			visualModeKeyBindings: readRemaps(layeredConfigValue(vimConfig, 'visualModeKeyBindings')),
			visualModeKeyBindingsNonRecursive: readRemaps(layeredConfigValue(vimConfig, 'visualModeKeyBindingsNonRecursive')),
			operatorPendingModeKeyBindings: readRemaps(layeredConfigValue(vimConfig, 'operatorPendingModeKeyBindings')),
			operatorPendingModeKeyBindingsNonRecursive: readRemaps(layeredConfigValue(vimConfig, 'operatorPendingModeKeyBindingsNonRecursive')),
		};
	}

	private handleKeyDown(event: IKeyboardEvent): void {
		if (!this.enabled || !this.hasModel()) {
			return;
		}
		const key = keyFromEvent(event);
		if (!key || !this.vim.shouldHandleKey(key) || this.shouldLetNativeKeybindingHandle(event)) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		void this.asyncKeyQueue.enqueue(async () => this.handleVimKey(key)).then(undefined, () => this.syncStatus());
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
			return this.hasMatchingUserOrExtensionKeybinding(event, undefined, true);
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
			return !keybinding.isDefault || (keybinding.extensionId !== null && !keybinding.isBuiltinExtension);
		});
	}

	private async handleVimKey(key: string): Promise<void> {
		const clipboard = new ClipboardTransaction(this.vimClipboard);
		await clipboard.with(async () => {
			await this.vim.onKeyAsync(key, { clipboard });
		});
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
			this.logVisual(`mouse selection reason=${cursorChangeReasonName(event.reason)} mode=${this.vim.mode.kind} native=${formatVSCodeSelections(selections)}`);
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
		if (this.vim.mode.kind === 'insert' || this.vim.mode.kind === 'replace') {
			return;
		}
		this.handleExternalEditorStateChanged(event.source);
	}

	private isModelMarkerRecoveryNoise(event: ICursorSelectionChangedEvent): boolean {
		if (event.source !== 'modelChange' || event.reason !== CursorChangeReason.RecoverFromMarkers) {
			return false;
		}
		// Marker recovery is VSCode adjusting cursor/selection markers after model edits
		// such as log-file appends. Treat it as authoritative for insert/replace via the
		// existing early return above, but do not let it churn normal-mode cursors or
		// rewrite an active Vim visual selection.
		if (this.vim.mode.kind === 'visual' || this.vim.mode.kind === 'visualLine' || this.vim.mode.kind === 'visualBlock') {
			return true;
		}
		return this.vim.mode.kind === 'normal'
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
		this.vimEditor.detachFromModel();
		if (!this.attachCurrentModelState()) {
			this.syncDetachedStatus();
			return;
		}
		this.handleExternalEditorStateChanged('model');
	}

	private handleExternalEditorStateChanged(source?: string, { render = false }: { render?: boolean } = {}): void {
		if (!this.enabled || this.vimEditor.isExecutingNativeCommand?.()) return;
		if (!this.hasModel()) {
			this.pendingUndoRedoContentSync = false;
			this.vimEditor.detachFromModel();
			this.syncDetachedStatus();
			return;
		}
		this.vimEditor.invalidateCachedSelections();
		const result = this.vim.syncFromEditorState({ render });
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
		this.logUndo(`syncFromUndoRedoState start reason=${reason} native=${formatVSCodeSelections(this.editor.getSelections() ?? [])} mode=${this.vim.mode.kind}`);
		this.vimEditor.invalidateCachedSelections();
		const result = this.vim.syncFromUndoRedoState({ render: false });
		this.logVisualSyncDecision(`undoRedo:${reason}`, result);
		this.logUndo(`syncFromUndoRedoState end reason=${reason} native=${formatVSCodeSelections(this.editor.getSelections() ?? [])} mode=${this.vim.mode.kind}`);
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
		this.editor.getContainerDomNode().classList.remove('vim-character-mode-enabled');
		this.vimActiveContext.set(true);
		this.vimModeContext.set(vscodeVimModeContextValue(status));
		this.vimNormalContext.set(status.mode === 'normal');
		this.vimInsertContext.set(status.mode === 'insert');
		this.vimPendingContext.set(status.pending);
		this.vimOperatorContext.set(status.operator ?? '');
		this.vimChordContext.set(status.chord);
	}

	private syncDisabledStatus(): void {
		this.editor.getContainerDomNode().classList.remove('vim-character-mode-enabled');
		this.vimActiveContext.set(false);
		this.vimModeContext.set('Disabled');
		this.vimNormalContext.set(false);
		this.vimInsertContext.set(false);
		this.vimPendingContext.set(false);
		this.vimOperatorContext.set('');
		this.vimChordContext.set('');
	}

	private syncStatus(): void {
		if (!this.enabled) {
			this.syncDisabledStatus();
			return;
		}
		const status = this.vim.status;
		this.editor.getContainerDomNode().classList.toggle('vim-character-mode-enabled', status.mode !== 'insert' && status.mode !== 'replace');
		this.vimActiveContext.set(true);
		this.vimModeContext.set(vscodeVimModeContextValue(status));
		this.vimNormalContext.set(status.mode === 'normal');
		this.vimInsertContext.set(status.mode === 'insert');
		this.vimPendingContext.set(status.pending);
		this.vimOperatorContext.set(status.operator ?? '');
		this.vimChordContext.set(status.chord);
		this.vimEditor.setCursorStyle(status.mode === 'insert' ? 'line' : 'block');
		this._onDidChangeStatus.fire(status);
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
		case 'visual':
			return `Visual${suffix}`;
		case 'visualLine':
			return `VisualLine${suffix}`;
		case 'visualBlock':
			return `VisualBlock${suffix}`;
		default:
			return `Unknown${suffix}`;
	}
}

function formatKeySequence(keys: readonly string[]): string {
	return keys.join(' ');
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

function readRemaps(value: unknown): VimKeyRemapping[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(item => {
		if (typeof item !== 'object' || item === null) return [];
		const remap = item as { before?: unknown; after?: unknown; commands?: unknown; silent?: unknown; recursive?: unknown };
		if (!Array.isArray(remap.before) || !remap.before.every(key => typeof key === 'string')) return [];
		return [{
			before: remap.before,
			after: Array.isArray(remap.after) && remap.after.every(key => typeof key === 'string') ? remap.after : undefined,
			commands: Array.isArray(remap.commands) ? readRemapCommands(remap.commands) : undefined,
			silent: typeof remap.silent === 'boolean' ? remap.silent : undefined,
			recursive: typeof remap.recursive === 'boolean' ? remap.recursive : undefined,
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
