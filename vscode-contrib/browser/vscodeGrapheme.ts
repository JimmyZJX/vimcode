import { getCharContainingOffset, prevCharLength } from '../../../../base/common/strings.js';
import { setGraphemeProvider } from '../common/grapheme.js';

// Vim character cells must agree with the host's character-column mapping:
// this provider backs the core's grapheme boundaries with the same
// `vs/base/common/strings.ts` helpers native cursor movement uses
// (`MoveOperations` steps by `nextCharLength`/`prevCharLength`), so `l` and
// the right-arrow key stop on identical columns by construction — including
// on the host table's known simplifications (adjacent regional-indicator
// flags merge; the data predates newer emoji). Installed once when the Vim
// controller starts; tests and standalone use keep the core's
// `Intl.Segmenter` default, which differs only on those corners.
let installed = false;

export function installVSCodeGraphemeProvider(): void {
	if (installed) {
		return;
	}
	installed = true;
	setGraphemeProvider({
		nextBoundary(text: string, column: number): number {
			if (column >= text.length) {
				return text.length;
			}
			// End of the cluster containing [column]: the smallest boundary
			// strictly greater than it, also when [column] sits mid-cluster.
			return getCharContainingOffset(text, Math.max(0, column))[1];
		},

		previousBoundary(text: string, column: number): number {
			if (column <= 0) {
				return 0;
			}
			const clamped = Math.min(column, text.length);
			if (clamped === text.length) {
				return clamped - prevCharLength(text, clamped);
			}
			const start = getCharContainingOffset(text, clamped)[0];
			// Mid-cluster: the containing cluster's start is the previous
			// boundary; on a boundary: step one whole cluster back.
			return start < clamped ? start : clamped - prevCharLength(text, clamped);
		},

		clusterStart(text: string, column: number): number {
			if (column <= 0) {
				return 0;
			}
			if (column >= text.length) {
				return column;
			}
			return getCharContainingOffset(text, column)[0];
		},
	});
}
