import { IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
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
		clipboardService: IClipboardService
	) {
		super();
		this.vimClipboard = new VSCodeVimClipboard(clipboardService);
		this.vimEditor = new VSCodeVimEditor(editor, this.vimClipboard);
		this.vim = new Vim(this.vimEditor);
		this.vimModeContext = VimModeContext.bindTo(contextKeyService);
		this.vimNormalContext = VimNormalContext.bindTo(contextKeyService);
		this.vimInsertContext = VimInsertContext.bindTo(contextKeyService);
		this.vimPendingContext = VimPendingContext.bindTo(contextKeyService);
		this.vimOperatorContext = VimOperatorContext.bindTo(contextKeyService);
		this.vimChordContext = VimChordContext.bindTo(contextKeyService);
		this.syncEditorState();
		this._register(this.editor.onKeyDown(event => this.handleKeyDown(event)));
		this._register(this.editor.onDidFocusEditorText(() => {
			this.vimEditor.refreshClipboardFromSystemClipboard();
			this.syncEditorState();
		}));
		this._register(this.editor.onDidChangeModel(() => this.syncEditorState()));
	}

	getStatus(): VimStatus {
		return this.vim.status;
	}

	override dispose(): void {
		this.editor.updateOptions({ cursorStyle: this.originalCursorStyle });
		super.dispose();
	}

	private handleKeyDown(event: IKeyboardEvent): void {
		const key = keyFromEvent(event);
		if (!key) {
			return;
		}

		if (this.vim.mode.kind === 'insert' && !isEscapeKey(key)) {
			return;
		}

		const result = this.vim.onKey(key);
		this.syncEditorState();
		if (result === 'handled') {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	private syncEditorState(): void {
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

function keyFromEvent(event: IKeyboardEvent): string | undefined {
	if (event.altKey || event.metaKey) {
		return undefined;
	}
	if (event.ctrlKey) {
		if (event.keyCode === KeyCode.BracketLeft) {
			return 'ctrl-[';
		}
		if (event.keyCode === KeyCode.KeyV) {
			return 'ctrl-v';
		}
		return undefined;
	}

	if (event.keyCode >= KeyCode.KeyA && event.keyCode <= KeyCode.KeyZ) {
		const letter = String.fromCharCode('a'.charCodeAt(0) + event.keyCode - KeyCode.KeyA);
		return event.shiftKey ? letter.toUpperCase() : letter;
	}

	if (event.keyCode >= KeyCode.Digit0 && event.keyCode <= KeyCode.Digit9) {
		return String(event.keyCode - KeyCode.Digit0);
	}

	switch (event.keyCode) {
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
