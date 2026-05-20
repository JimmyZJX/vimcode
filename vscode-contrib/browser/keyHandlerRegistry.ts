import { IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, ContextKeyExpression, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';

export interface VimcodeKeyHandlerRegistration {
	readonly id: string;
	readonly when?: string;
	readonly command: string;
	readonly priority?: number;
}

export interface VimcodeKeyEvent {
	readonly key: string;
	readonly code: string;
	readonly keyCode: number;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
}

export interface StoredVimcodeKeyHandler extends VimcodeKeyHandlerRegistration {
	readonly whenExpression: ContextKeyExpression | undefined;
}

function isRegistration(value: unknown): value is VimcodeKeyHandlerRegistration {
	if (typeof value !== 'object' || value === null) return false;
	const registration = value as Partial<VimcodeKeyHandlerRegistration>;
	return typeof registration.id === 'string'
		&& registration.id.length > 0
		&& typeof registration.command === 'string'
		&& registration.command.length > 0
		&& (registration.when === undefined || typeof registration.when === 'string')
		&& (registration.priority === undefined || typeof registration.priority === 'number');
}

function storedRegistration(registration: VimcodeKeyHandlerRegistration): StoredVimcodeKeyHandler {
	return {
		...registration,
		priority: registration.priority ?? 0,
		whenExpression: ContextKeyExpr.deserialize(registration.when),
	};
}

class VimcodeKeyHandlerRegistry {
	private readonly handlers = new Map<string, StoredVimcodeKeyHandler>();

	register(registration: VimcodeKeyHandlerRegistration): void {
		this.handlers.set(registration.id, storedRegistration(registration));
	}

	unregister(id: string): void {
		this.handlers.delete(id);
	}

	matchingHandlers(contextKeyService: IContextKeyService): StoredVimcodeKeyHandler[] {
		return [...this.handlers.values()]
			.filter(handler => contextKeyService.contextMatchesRules(handler.whenExpression))
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
	}
}

export const vimcodeKeyHandlerRegistry = new VimcodeKeyHandlerRegistry();

export function vimcodeKeyEventFromKeyboardEvent(key: string, event: IKeyboardEvent): VimcodeKeyEvent {
	return {
		key,
		code: event.code,
		keyCode: event.keyCode,
		ctrlKey: event.ctrlKey,
		shiftKey: event.shiftKey,
		altKey: event.altKey,
		metaKey: event.metaKey,
	};
}

CommandsRegistry.registerCommand('vimcode.registerKeyHandler', (_accessor, registration: unknown) => {
	if (!isRegistration(registration)) {
		throw new Error('vimcode.registerKeyHandler expects { id: string, command: string, when?: string, priority?: number }');
	}
	vimcodeKeyHandlerRegistry.register(registration);
});

CommandsRegistry.registerCommand('vimcode.unregisterKeyHandler', (_accessor, id: unknown) => {
	if (typeof id !== 'string') {
		throw new Error('vimcode.unregisterKeyHandler expects an id string');
	}
	vimcodeKeyHandlerRegistry.unregister(id);
});
