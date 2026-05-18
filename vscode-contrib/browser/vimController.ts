import { IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { RawContextKey, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ICodeEditor } from '../../../browser/editorBrowser.js';
import { Vim, VimStatus } from '../common/vim.js';
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

	private readonly vimClipboard: VSCodeVimClipboard;
	private readonly vimEditor: VSCodeVimEditor;
	private readonly vim: Vim;
	private readonly vimModeContext: IContextKey<string>;
	private readonly vimNormalContext: IContextKey<boolean>;
	private readonly vimInsertContext: IContextKey<boolean>;
	private readonly vimPendingContext: IContextKey<boolean>;
	private readonly vimOperatorContext: IContextKey<string>;
	private readonly vimChordContext: IContextKey<string>;
	private readonly originalCursorStyle = this.editor.getRawOptions().cursorStyle;
	private readonly _onDidChangeStatus = this._register(new Emitter<VimStatus>());
	readonly onDidChangeStatus: Event<VimStatus> = this._onDidChangeStatus.event;

	constructor(
		private readonly editor: ICodeEditor,
		contextKeyService: IContextKeyService,
		clipboardService: IClipboardService,
		commandService: ICommandService
	) {
		super();
		this.vimClipboard = new VSCodeVimClipboard(clipboardService);
		this.vimEditor = new VSCodeVimEditor(editor, this.vimClipboard, commandService);
		this.vim = new Vim(this.vimEditor);
		this.vimModeContext = VimModeContext.bindTo(contextKeyService);
		this.vimNormalContext = VimNormalContext.bindTo(contextKeyService);
		this.vimInsertContext = VimInsertContext.bindTo(contextKeyService);
		this.vimPendingContext = VimPendingContext.bindTo(contextKeyService);
		this.vimOperatorContext = VimOperatorContext.bindTo(contextKeyService);
		this.vimChordContext = VimChordContext.bindTo(contextKeyService);
		this.editor.getContainerDomNode().classList.add('vim-cursor-rendering-enabled');
		this.syncEditorState();
		this._register(this.editor.onKeyDown(event => this.handleKeyDown(event)));
		this._register(this.editor.onDidFocusEditorText(() => {
			this.vimEditor.refreshClipboardFromSystemClipboard();
			this.syncEditorState();
		}));
		this._register(this.editor.onDidChangeCursorSelection(event => this.handleCursorSelectionChanged(event.source)));
		this._register(this.editor.onDidChangeModel(() => this.handleExternalEditorStateChanged()));
	}

	getStatus(): VimStatus {
		return this.vim.status;
	}

	override dispose(): void {
		this.editor.getContainerDomNode().classList.remove('vim-cursor-rendering-enabled');
		this.editor.updateOptions({ cursorStyle: this.originalCursorStyle });
		super.dispose();
	}

	private handleKeyDown(event: IKeyboardEvent): void {
		const key = keyFromEvent(event);
		if (!key) {
			return;
		}

		if ((this.vim.mode.kind === 'insert' || this.vim.mode.kind === 'replace') && !isEscapeKey(key) && key !== 'ctrl-r' && key !== 'ctrl-w' && key !== 'ctrl-u' && !this.vim.status.pending) {
			return;
		}

		const result = this.vim.onKey(key);
		if (!this.vim.status.pending) {
			this.vimEditor.revealPrimaryCursorIfOutsideViewport();
			this.syncEditorState();
		} else {
			this.syncStatus();
		}
		if (result === 'handled') {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	private handleCursorSelectionChanged(source: string): void {
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
		this.vimEditor.invalidateCachedSelections();
		this.vim.syncFromEditorState({ render: false });
		this.syncEditorState();
	}

	private syncEditorState(): void {
		this.syncStatus();
	}

	private syncStatus(): void {
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

function isEscapeKey(key: string): boolean {
	return key === '<escape>' || key === 'escape' || key === 'ctrl-[';
}

function shiftedDigitKey(digit: number): string {
	const shiftedDigits = [')', '!', '@', '#', '$', '%', '^', '&', '*', '('];
	return shiftedDigits[digit] ?? String(digit);
}

function isSupportedCtrlKey(key: string): boolean {
	switch (key) {
		case 'ctrl-b':
		case 'ctrl-d':
		case 'ctrl-e':
		case 'ctrl-f':
		case 'ctrl-i':
		case 'ctrl-o':
		case 'ctrl-r':
		case 'ctrl-u':
		case 'ctrl-v':
		case 'ctrl-w':
		case 'ctrl-y':
			return true;
		default:
			return false;
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
			const key = `ctrl-${letter}`;
			return isSupportedCtrlKey(key) ? key : undefined;
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

	switch (event.keyCode) {
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
		case KeyCode.Space:
			return 'space';
		case KeyCode.Semicolon:
			return event.shiftKey ? ':' : ';';
		case KeyCode.Quote:
			return event.shiftKey ? '"' : '\'';
		case KeyCode.Comma:
			return event.shiftKey ? '<' : ',';
		case KeyCode.Period:
			return event.shiftKey ? '>' : '.';
		case KeyCode.Slash:
			return event.shiftKey ? '?' : '/';
		case KeyCode.Backquote:
			return event.shiftKey ? '~' : '`';
		case KeyCode.BracketLeft:
			return event.shiftKey ? '{' : '[';
		case KeyCode.BracketRight:
			return event.shiftKey ? '}' : ']';
		case KeyCode.Backslash:
			return event.shiftKey ? '|' : '\\';
		case KeyCode.Minus:
			return event.shiftKey ? '_' : '-';
		case KeyCode.Equal:
			return event.shiftKey ? '+' : '=';
		default:
			return undefined;
	}
}
