// Grapheme-cluster boundaries for character-cell arithmetic. The model core
// stores positions in UTF-16 code units (VSCode's coordinate system), but a
// Vim "character cell" must not split rendered characters: stepping by ±1
// code unit lands inside surrogate pairs (😀) or splits multi-codepoint
// clusters (🇬🇧 flags, e + combining accent, ZWJ emoji).
//
// The boundary logic is pluggable ([setGraphemeProvider]): the VSCode
// integration registers a provider backed by the host's own character-column
// machinery (`vs/base/common/strings.ts` `nextCharLength`/`prevCharLength`/
// `getCharContainingOffset` — the functions native cursor movement uses), so
// Vim cells agree with the host cursor *by construction*, including on the
// host's known simplifications (its grapheme table merges adjacent
// regional-indicator flags and predates newer emoji). The default provider
// (tests, standalone use) is `Intl.Segmenter` with a surrogate-pair fallback —
// behaviorally identical except on those corners.
//
// Semantics note (deliberate, host-faithful): Neovim treats a regional-
// indicator pair as TWO cells (`l` over 🇬🇧 stops between the indicators;
// `x` deletes half the flag). VSCode renders the flag as one glyph and its
// cursor steps over it atomically — a Vim cursor parked invisibly mid-glyph
// is unusable, so vimcode follows the host: one cluster = one cell
// (multibyte.test.ts). Combining accents and plain astral characters behave
// identically under both models (nvim-pinned in test_multibyte).

/** Boundary primitives over one line of text; columns are UTF-16 indices. */
export type GraphemeProvider = {
  /** The smallest cluster boundary strictly greater than [column] (≤ length). */
  nextBoundary(text: string, column: number): number;
  /** The largest cluster boundary strictly smaller than [column] (≥ 0). */
  previousBoundary(text: string, column: number): number;
  /** The start of the cluster containing [column] (largest boundary ≤ it). */
  clusterStart(text: string, column: number): number;
};

// Minimal local typing: the project's TS lib target predates the
// `Intl.Segmenter` declarations, but the runtime (Node ≥ 16 / VSCode's
// Electron / evergreen browsers) has it.
type GraphemeSegment = { index: number; segment: string };
type GraphemeSegmenter = { segment(input: string): Iterable<GraphemeSegment> };

const segmenter: GraphemeSegmenter | undefined = (() => {
  const intl = typeof Intl === "undefined"
    ? undefined
    : (Intl as unknown as { Segmenter?: new (locale?: undefined, options?: { granularity: "grapheme" }) => GraphemeSegmenter });
  return intl !== undefined && typeof intl.Segmenter === "function"
    ? new intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;
})();

const defaultProvider: GraphemeProvider = {
  nextBoundary(text: string, column: number): number {
    if (column >= text.length) return text.length;
    if (segmenter === undefined) return column + surrogatePairWidth(text, Math.max(0, column));
    for (const segment of segmenter.segment(text)) {
      const end = segment.index + segment.segment.length;
      if (end > column) return end;
    }
    return text.length;
  },

  previousBoundary(text: string, column: number): number {
    if (column <= 0) return 0;
    const clamped = Math.min(column, text.length);
    if (segmenter === undefined) {
      return clamped - (clamped >= 2 && isLowSurrogate(text, clamped - 1) ? 2 : 1);
    }
    let previous = 0;
    for (const segment of segmenter.segment(text)) {
      if (segment.index >= clamped) break;
      previous = segment.index;
    }
    return previous;
  },

  clusterStart(text: string, column: number): number {
    if (column <= 0) return 0;
    if (column >= text.length) return column;
    if (segmenter === undefined) return isLowSurrogate(text, column) ? column - 1 : column;
    let start = 0;
    for (const segment of segmenter.segment(text)) {
      if (segment.index > column) break;
      start = segment.index;
    }
    return start;
  },
};

let activeProvider: GraphemeProvider = defaultProvider;

/** Install the host's boundary implementation (undefined restores the
    default). The VSCode integration calls this once at startup so Vim cells
    match native cursor movement exactly. */
export function setGraphemeProvider(provider: GraphemeProvider | undefined): void {
  activeProvider = provider ?? defaultProvider;
}

export function nextGraphemeBoundary(line: string, column: number): number {
  return activeProvider.nextBoundary(line, column);
}

export function previousGraphemeBoundary(line: string, column: number): number {
  return activeProvider.previousBoundary(line, column);
}

export function graphemeStart(line: string, column: number): number {
  return activeProvider.clusterStart(line, column);
}

function surrogatePairWidth(line: string, column: number): number {
  const code = line.charCodeAt(column);
  return code >= 0xd800 && code <= 0xdbff && column + 1 < line.length ? 2 : 1;
}

function isLowSurrogate(line: string, column: number): boolean {
  const code = line.charCodeAt(column);
  return code >= 0xdc00 && code <= 0xdfff;
}
