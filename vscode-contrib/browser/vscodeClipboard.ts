import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';

export class VSCodeVimClipboard {
	private cachedText = '';

	constructor(private readonly clipboardService: IClipboardService) { }

	readText(): string {
		return this.cachedText;
	}

	writeText(text: string): void {
		this.cachedText = text;
		this.clipboardService.writeText(text).then(undefined, () => {
			// Clipboard writes can fail in web contexts if the browser rejects access.
			// Keep the in-memory Vim register authoritative for the current session.
		});
	}

	refreshFromSystemClipboard(): void {
		this.clipboardService.readText().then(text => {
			this.cachedText = text;
		}, () => {
			// Ignore clipboard read failures for the same reason as write failures.
		});
	}
}
