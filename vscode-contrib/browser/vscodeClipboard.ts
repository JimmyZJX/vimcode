import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';

export class VSCodeVimClipboard {
	private cachedText = '';

	constructor(private readonly clipboardService: IClipboardService) { }

	async readTextAsync(): Promise<string> {
		try {
			this.cachedText = await this.clipboardService.readText();
		} catch {
			// Keep using the cached text if the browser rejects the read.
		}
		return this.cachedText;
	}

	async writeTextAsync(text: string): Promise<void> {
		this.cachedText = text;
		try {
			await this.clipboardService.writeText(text);
		} catch {
			// Keep the in-memory Vim register authoritative for the current session.
		}
	}
}
