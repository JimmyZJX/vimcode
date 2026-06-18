import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import * as nls from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationPropertySchema, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IExtensionManagementService, IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight, KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorCommand, EditorContributionInstantiation, ServicesAccessor, registerEditorCommand, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { IEditorContribution } from '../../../common/editorCommon.js';
import { VimController } from './vimController.js';

// List/tree widgets evaluate keybinding when-clauses against their own
// context scope, which chains to the workbench root — never to any editor's
// scope. `vim.active` is editor-scoped (VimController is an editor
// contribution and binds its keys to the editor-scoped IContextKeyService),
// so it is invisible from a focused list and rules gated on it never match.
// Configuration-backed `config.*` keys live at the root context and are
// visible in every scope.
const VimActiveListFocusContext = ContextKeyExpr.and(
	ContextKeyExpr.has('config.vim.enabled'),
	ContextKeyExpr.has('listFocus'),
	ContextKeyExpr.not('inputFocus')
);
const VimActiveNavigableListFocusContext = ContextKeyExpr.and(
	VimActiveListFocusContext,
	ContextKeyExpr.has('listSupportsKeyboardNavigation')
);
const VimActiveNormalContext = ContextKeyExpr.and(
	ContextKeyExpr.has('vim.active'),
	ContextKeyExpr.has('vim.normal')
);
const VimActiveNormalNotebookInputContext = ContextKeyExpr.and(
	VimActiveNormalContext,
	ContextKeyExpr.has('inputFocus'),
	ContextKeyExpr.has('notebookEditorFocused')
);

function remappingSchema(description: string): IConfigurationPropertySchema {
	return {
		type: 'array',
		default: [],
		scope: ConfigurationScope.APPLICATION,
		description,
		items: {
			type: 'object',
			properties: {
				before: {
					type: 'array',
					items: { type: 'string' },
					description: nls.localize('vim.remap.before', "Input key sequence, using VSCodeVim key notation."),
				},
				after: {
					type: 'array',
					items: { type: 'string' },
					description: nls.localize('vim.remap.after', "Output key sequence, using VSCodeVim key notation."),
				},
				commands: {
					type: 'array',
					description: nls.localize('vim.remap.commands', "VS Code commands or Vim command-line commands to run."),
				},
				when: {
					type: 'string',
					description: nls.localize('vim.remap.when', "VS Code when-clause expression that must be true for this remapping to be active."),
				},
				silent: { type: 'boolean' },
				recursive: { type: 'boolean' },
			},
		},
	};
}

function registerVimListKeybindings(): void {
	const weight = KeybindingWeight.WorkbenchContrib + 50;
	KeybindingsRegistry.registerKeybindingRule({ id: 'list.focusFirst', weight, when: VimActiveListFocusContext, primary: KeyChord(KeyCode.KeyG, KeyCode.KeyG) });
	KeybindingsRegistry.registerKeybindingRule({ id: 'list.collapse', weight, when: VimActiveListFocusContext, primary: KeyCode.KeyH });
	KeybindingsRegistry.registerKeybindingRule({ id: 'list.focusDown', weight, when: VimActiveListFocusContext, primary: KeyCode.KeyJ });
	KeybindingsRegistry.registerKeybindingRule({ id: 'list.focusUp', weight, when: VimActiveListFocusContext, primary: KeyCode.KeyK });
	KeybindingsRegistry.registerKeybindingRule({ id: 'list.select', weight, when: VimActiveListFocusContext, primary: KeyCode.KeyL });
	KeybindingsRegistry.registerKeybindingRule({ id: 'list.toggleExpand', weight, when: VimActiveListFocusContext, primary: KeyCode.KeyO });
	KeybindingsRegistry.registerKeybindingRule({ id: 'list.toggleKeyboardNavigation', weight, when: VimActiveNavigableListFocusContext, primary: KeyCode.Slash });
	KeybindingsRegistry.registerKeybindingRule({
		id: 'list.focusPageDown',
		weight,
		when: VimActiveListFocusContext,
		primary: KeyMod.CtrlCmd | KeyCode.KeyD,
		mac: { primary: KeyMod.WinCtrl | KeyCode.KeyD },
	});
	KeybindingsRegistry.registerKeybindingRule({
		id: 'list.focusPageUp',
		weight,
		when: VimActiveListFocusContext,
		primary: KeyMod.CtrlCmd | KeyCode.KeyU,
		mac: { primary: KeyMod.WinCtrl | KeyCode.KeyU },
	});
	KeybindingsRegistry.registerKeybindingRule({ id: 'list.focusLast', weight, when: VimActiveListFocusContext, primary: KeyMod.Shift | KeyCode.KeyG });
}

function registerVimCompletionKeybindings(): void {
	const weight = KeybindingWeight.WorkbenchContrib + 50;
	for (const modeContext of [ContextKeyExpr.has('vim.insert'), ContextKeyExpr.equals('vim.mode', 'Replace')]) {
		for (const [visibleContext, nextCommand, previousCommand] of [
			[ContextKeyExpr.has('suggestWidgetVisible'), 'selectNextSuggestion', 'selectPrevSuggestion'],
			[ContextKeyExpr.has('parameterHintsVisible'), 'showNextParameterHint', 'showPrevParameterHint'],
		] as const) {
			const when = ContextKeyExpr.and(ContextKeyExpr.has('vim.active'), modeContext, visibleContext);
			KeybindingsRegistry.registerKeybindingRule({
				id: nextCommand,
				weight,
				when,
				primary: KeyMod.CtrlCmd | KeyCode.KeyN,
				mac: { primary: KeyMod.WinCtrl | KeyCode.KeyN },
			});
			KeybindingsRegistry.registerKeybindingRule({
				id: previousCommand,
				weight,
				when,
				primary: KeyMod.CtrlCmd | KeyCode.KeyP,
				mac: { primary: KeyMod.WinCtrl | KeyCode.KeyP },
			});
		}
	}
}

function registerVimNotebookKeybindings(): void {
	const weight = KeybindingWeight.WorkbenchContrib + 50;
	KeybindingsRegistry.registerKeybindingRule({
		id: 'notebook.cell.quitEdit',
		weight,
		when: ContextKeyExpr.and(
			VimActiveNormalNotebookInputContext,
			ContextKeyExpr.not('editorHasSelection'),
			ContextKeyExpr.not('editorHoverVisible')
		),
		primary: KeyCode.Escape,
	});
	KeybindingsRegistry.registerKeybindingRule({
		id: 'notebook.focusNextEditor',
		weight,
		when: ContextKeyExpr.and(
			VimActiveNormalNotebookInputContext,
			ContextKeyExpr.has('editorTextFocus'),
			ContextKeyExpr.notEquals('notebookEditorCursorAtBoundary', 'none'),
			ContextKeyExpr.notEquals('notebookEditorCursorAtBoundary', 'top')
		),
		primary: KeyCode.KeyJ,
	});
	KeybindingsRegistry.registerKeybindingRule({
		id: 'notebook.focusPreviousEditor',
		weight,
		when: ContextKeyExpr.and(
			VimActiveNormalNotebookInputContext,
			ContextKeyExpr.has('editorTextFocus'),
			ContextKeyExpr.notEquals('notebookEditorCursorAtBoundary', 'bottom'),
			ContextKeyExpr.notEquals('notebookEditorCursorAtBoundary', 'none')
		),
		primary: KeyCode.KeyK,
	});
}

registerVimListKeybindings();
registerVimCompletionKeybindings();
registerVimNotebookKeybindings();

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vim',
	title: nls.localize('vim.configuration.title', "Vim"),
	type: 'object',
	properties: {
		'vim.enabled': {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: nls.localize('vim.enabled', "Enable vimcode's built-in Vim key handling."),
		},
		'vim.useSystemClipboard': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: nls.localize('vim.useSystemClipboard', "Use system clipboard for the unnamed register."),
		},
		'vim.leader': {
			type: 'string',
			default: '\\',
			scope: ConfigurationScope.APPLICATION,
			description: nls.localize('vim.leader', "Leader key used by VSCodeVim-compatible remappings."),
		},
		'vim.useCtrlKeys': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: nls.localize('vim.useCtrlKeys', "Enable Vim Ctrl key commands that override common VS Code operations."),
		},
		'vim.debugUndo': {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: nls.localize('vim.debugUndo', "Log vimcode undo transaction and VS Code undo/redo synchronization details."),
		},
		'vim.debugVisual': {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: nls.localize('vim.debugVisual', "Log vimcode mouse-selection and visual-mode synchronization decisions."),
		},
		'vim.timeout': {
			type: 'number',
			default: 1000,
			minimum: 0,
			scope: ConfigurationScope.APPLICATION,
			description: nls.localize('vim.timeout', "Timeout in milliseconds for remapped key sequences."),
		},
		'vim.visualMultilineInsert': {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: nls.localize('vim.visualMultilineInsert', "Use VSCodeVim-compatible multi-cursor insertion for I/A in Visual and Visual Line modes."),
		},
		'vim.easymotion': {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: nls.localize('vim.easymotion', "Enable VSCodeVim-compatible EasyMotion commands."),
		},
		'vim.easymotionKeys': {
			type: 'string',
			default: 'hklyuiopnm,qwertzxcvbasdgjf;',
			scope: ConfigurationScope.APPLICATION,
			description: nls.localize('vim.easymotionKeys', "Keys used to label EasyMotion targets."),
		},
		'vim.easymotionJumpToAnywhereRegex': {
			type: 'string',
			default: '\\b[A-Za-z0-9]|[A-Za-z0-9]\\b|_.|#.|[a-z][A-Z]',
			scope: ConfigurationScope.APPLICATION,
			description: nls.localize('vim.easymotionJumpToAnywhereRegex', "Regular expression used by EasyMotion jump-to-anywhere commands."),
		},
		'vim.handleKeys': {
			type: 'object',
			default: {},
			scope: ConfigurationScope.APPLICATION,
			additionalProperties: { type: 'boolean' },
			description: nls.localize('vim.handleKeys', "Override whether vimcode handles individual keys, using VSCodeVim key notation."),
		},
		'vim.normalModeKeyBindings': remappingSchema(nls.localize('vim.normalModeKeyBindings', "Recursive key remappings in Normal mode.")),
		'vim.normalModeKeyBindingsNonRecursive': remappingSchema(nls.localize('vim.normalModeKeyBindingsNonRecursive', "Non-recursive key remappings in Normal mode.")),
		'vim.insertModeKeyBindings': remappingSchema(nls.localize('vim.insertModeKeyBindings', "Recursive key remappings in Insert mode.")),
		'vim.insertModeKeyBindingsNonRecursive': remappingSchema(nls.localize('vim.insertModeKeyBindingsNonRecursive', "Non-recursive key remappings in Insert mode.")),
		'vim.visualModeKeyBindings': remappingSchema(nls.localize('vim.visualModeKeyBindings', "Recursive key remappings in Visual modes.")),
		'vim.visualModeKeyBindingsNonRecursive': remappingSchema(nls.localize('vim.visualModeKeyBindingsNonRecursive', "Non-recursive key remappings in Visual modes.")),
		'vim.operatorPendingModeKeyBindings': remappingSchema(nls.localize('vim.operatorPendingModeKeyBindings', "Recursive key remappings in Operator-pending mode.")),
		'vim.operatorPendingModeKeyBindingsNonRecursive': remappingSchema(nls.localize('vim.operatorPendingModeKeyBindingsNonRecursive', "Non-recursive key remappings in Operator-pending mode.")),
	},
});

// Same command id and title as VSCodeVim's `toggleVim` so muscle memory and
// existing keybindings carry over.
class ToggleVimAction extends Action2 {
	static readonly ID = 'toggleVim';

	constructor() {
		super({
			id: ToggleVimAction.ID,
			title: nls.localize2('vim.toggleVim', "Toggle Vim Mode"),
			category: nls.localize2('vim.category', "Vim"),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const enabled = configurationService.getValue<unknown>('vim.enabled') === true;
		return configurationService.updateValue('vim.enabled', !enabled, ConfigurationTarget.USER);
	}
}

registerAction2(ToggleVimAction);

class VimContribution extends VimController implements IEditorContribution {
	constructor(
		editor: ICodeEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IClipboardService clipboardService: IClipboardService,
		@ICommandService commandService: ICommandService,
		@IConfigurationService configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IExtensionManagementService extensionManagementService: IExtensionManagementService,
		@IGlobalExtensionEnablementService extensionEnablementService: IGlobalExtensionEnablementService,
		@INotificationService notificationService: INotificationService,
		@ILogService logService: ILogService
	) {
		super(editor, contextKeyService, clipboardService, commandService, configurationService, keybindingService, extensionManagementService, extensionEnablementService, notificationService, logService);
	}
}

const VimCommand = EditorCommand.bindToContribution<VimContribution>(editor => editor.getContribution<VimContribution>(VimController.ID));

registerEditorCommand(new VimCommand({
	id: 'vim.remap',
	precondition: undefined,
	handler: (controller, args) => controller.runRemapCommand(args),
}));

registerEditorContribution(VimController.ID, VimContribution, EditorContributionInstantiation.Eager);
