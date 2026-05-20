import { IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import * as nls from '../../../../nls.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { RawContextKey, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICodeEditor } from '../../../browser/editorBrowser.js';
import { VimCommandMapping, VimConfiguration, VimKeyRemapping, layeredConfigValue } from '../common/config.js';
import type { VimSystemClipboard } from '../common/registers.js';
import { Vim, VimStatus } from '../common/vim.js';
import { vimcodeKeyEventFromKeyboardEvent, vimcodeKeyHandlerRegistry } from './keyHandlerRegistry.js';
import { VSCodeVimClipboard } from './vscodeClipboard.js';
import { VSCodeVimEditor } from './vscodeVimEditor.js';

const VimModeContext = new RawContextKey<string>('vim.mode', 'normal', true);
const VimNormalContext = new RawContextKey<boolean>('vim.normal', true, true);
const VimInsertContext = new RawContextKey<boolean>('vim.insert', false, true);
const VimPendingContext = new RawContextKey<boolean>('vim.pending', false, true);
const VimOperatorContext = new RawContextKey<string>('vim.operator', '', true);
const VimChordContext = new RawContextKey<string>('vim.chord', '', true);

export class VimController extends Disposable {
	public static readonly ID = 'editor.contrib.vim';
	private static warnedAboutVSCodeVim = false;

	private readonly vimClipboard: VSCodeVimClipboard;
	private readonly vimEditor: VSCodeVimEditor;
	private readonly vim: Vim;
	private readonly asyncKeyQueue = new AsyncKeyQueue();
	private readonly vimModeContext: IContextKey<string>;
	private readonly vimNormalContext: IContextKey<boolean>;
	private readonly vimInsertContext: IContextKey<boolean>;
	private readonly vimPendingContext: IContextKey<boolean>;
	private readonly vimOperatorContext: IContextKey<string>;
	private readonly vimChordContext: IContextKey<string>;
	private enabled = false;
	private lastAmbiguousRemapWarningSignature = '';
	private readonly originalCursorStyle = this.editor.getRawOptions().cursorStyle;
	private readonly _onDidChangeStatus = this._register(new Emitter<VimStatus>());
	readonly onDidChangeStatus: Event<VimStatus> = this._onDidChangeStatus.event;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly contextKeyService: IContextKeyService,
		clipboardService: IClipboardService,
		private readonly commandService: ICommandService,
		private readonly configurationService: IConfigurationService,
		private readonly extensionManagementService: IExtensionManagementService,
		private readonly notificationService: INotificationService,
		private readonly logService: ILogService
	) {
		super();
		this.vimClipboard = new VSCodeVimClipboard(clipboardService);
		this.vimEditor = new VSCodeVimEditor(editor, commandService);
		this.vim = new Vim(this.vimEditor, this.readVimCompatibilityConfiguration());
		this.vimModeContext = VimModeContext.bindTo(contextKeyService);
		this.vimNormalContext = VimNormalContext.bindTo(contextKeyService);
		this.vimInsertContext = VimInsertContext.bindTo(contextKeyService);
		this.vimPendingContext = VimPendingContext.bindTo(contextKeyService);
		this.vimOperatorContext = VimOperatorContext.bindTo(contextKeyService);
		this.vimChordContext = VimChordContext.bindTo(contextKeyService);
		this.updateEnabledState();
		this._register(this.editor.onKeyDown(event => this.handleKeyDown(event)));
		this._register(this.editor.onDidFocusEditorText(() => this.syncEditorState()));
		this._register(this.editor.onDidChangeCursorSelection(event => this.handleCursorSelectionChanged(event.source)));
		this._register(this.editor.onDidChangeModel(() => this.handleExternalEditorStateChanged()));
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
		this.editor.getContainerDomNode().classList.remove('vim-cursor-rendering-enabled');
		this.editor.updateOptions({ cursorStyle: this.originalCursorStyle });
		super.dispose();
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<unknown>('vim.enabled') === true;
	}

	private updateEnabledState(): void {
		const enabled = this.isEnabled();
		this.enabled = enabled;
		this.editor.getContainerDomNode().classList.toggle('vim-cursor-rendering-enabled', enabled);
		if (enabled) {
			this.warnIfVSCodeVimInstalled();
			this.logAmbiguousRemapConflicts();
			this.syncEditorState();
		} else {
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
		return {
			leader: typeof vimConfig.leader === 'string' ? vimConfig.leader : undefined,
			useCtrlKeys: typeof useCtrlKeys === 'boolean'
				? useCtrlKeys
				: typeof vimConfig.useCtrlKeys === 'boolean' ? vimConfig.useCtrlKeys : undefined,
			useSystemClipboard: typeof useSystemClipboard === 'boolean'
				? useSystemClipboard
				: typeof vimConfig.useSystemClipboard === 'boolean' ? vimConfig.useSystemClipboard : undefined,
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
		if (!this.enabled) {
			return;
		}
		const handlerKey = keyForExternalHandlerFromEvent(event);
		const keyHandlers = handlerKey === undefined ? [] : vimcodeKeyHandlerRegistry.matchingHandlers(this.contextKeyService);
		const vimKey = keyFromEvent(event);
		if (keyHandlers.length === 0 && (!vimKey || !this.vim.shouldHandleKey(vimKey))) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		const keyEvent = handlerKey === undefined ? undefined : vimcodeKeyEventFromKeyboardEvent(handlerKey, event);
		void this.asyncKeyQueue.enqueue(async () => {
			if (keyEvent !== undefined) {
				for (const handler of keyHandlers) {
					let result: unknown;
					try {
						result = await this.commandService.executeCommand(handler.command, keyEvent);
					} catch (error) {
						this.logService.warn(`[vimcode] Key handler ${handler.id} failed: ${String(error)}`);
						continue;
					}
					if (result !== null && result !== undefined) {
						this.syncStatus();
						return;
					}
				}
			}

			if (!vimKey || !this.vim.shouldHandleKey(vimKey)) {
				this.logService.warn(`[vimcode] Key ${handlerKey ?? '<unknown>'} was captured by vimcode key handlers, but none handled it and Vim does not handle it.`);
				this.syncStatus();
				return;
			}

			await this.handleVimKey(vimKey);
		}).then(undefined, () => this.syncStatus());
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

	private handleCursorSelectionChanged(source: string): void {
		if (!this.enabled) return;
		// VSCode-specific synchronization path: unlike Zed, VSCode selection state
		// can be changed outside the Vim state machine (mouse selections, undo/redo
		// recovery, multicursor commands, other editor contributions). Ignore changes
		// that this Vim adapter originated, and also ignore native cursor movement while
		// insert/replace mode is intentionally letting VSCode handle typed input.
		if (source.startsWith('vim') || this.vim.mode.kind === 'insert' || this.vim.mode.kind === 'replace') {
			return;
		}
		this.handleExternalEditorStateChanged();
	}

	private handleExternalEditorStateChanged(): void {
		if (!this.enabled) return;
		this.vimEditor.invalidateCachedSelections();
		this.vim.syncFromEditorState({ render: false });
		this.syncEditorState();
	}

	private syncEditorState(): void {
		if (!this.enabled) {
			this.syncDisabledStatus();
			return;
		}
		this.syncStatus();
	}

	private syncDisabledStatus(): void {
		this.vimModeContext.set('disabled');
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
		this.vimModeContext.set(status.mode);
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

function formatKeySequence(keys: readonly string[]): string {
	return keys.join(' ');
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

function keyNameFromKeyCode(keyCode: KeyCode, shiftKey: boolean, escapeKey: string): string | undefined {
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
			return escapeKey;
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

function keyForExternalHandlerFromEvent(event: IKeyboardEvent): string | undefined {
	if (event.metaKey) {
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

	return keyNameFromKeyCode(event.keyCode, event.shiftKey, 'escape');
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

	return keyNameFromKeyCode(event.keyCode, event.shiftKey, '<escape>');
}
