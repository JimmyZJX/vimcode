import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { IEditorContribution } from '../../../common/editorCommon.js';
import { VimController } from './vimController.js';

class VimContribution extends VimController implements IEditorContribution {
	constructor(
		editor: ICodeEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IClipboardService clipboardService: IClipboardService,
		@ICommandService commandService: ICommandService,
		@IConfigurationService configurationService: IConfigurationService
	) {
		super(editor, contextKeyService, clipboardService, commandService, configurationService);
	}
}

registerEditorContribution(VimController.ID, VimContribution, EditorContributionInstantiation.Eager);
