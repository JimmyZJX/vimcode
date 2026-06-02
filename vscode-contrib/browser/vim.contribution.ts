import * as nls from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationPropertySchema, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IExtensionManagementService, IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { IEditorContribution } from '../../../common/editorCommon.js';
import { VimController } from './vimController.js';

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
				silent: { type: 'boolean' },
				recursive: { type: 'boolean' },
			},
		},
	};
}

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
			default: false,
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
		'vim.visualMultilineInsert': {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: nls.localize('vim.visualMultilineInsert', "Use VSCodeVim-compatible multi-cursor insertion for I/A in Visual and Visual Line modes."),
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

registerEditorContribution(VimController.ID, VimContribution, EditorContributionInstantiation.Eager);
