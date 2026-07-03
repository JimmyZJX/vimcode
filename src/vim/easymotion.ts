import { EasyMotionMarker, VimEditorCapabilities, normalCursorPosition } from "./editor.js";
import { VimConfiguration } from "./config.js";
import { Position, samePosition, selectionHead } from "./state.js";

type SearchBounds = "forward" | "backward" | "bidirectional";
type LabelPosition = "start" | "before" | "after";

type EasyMotionSpec = {
  keys: readonly string[];
  leaderCount?: number;
  search: "word" | "line" | "jumpToAnywhere" | "char" | "nchar";
  bounds: SearchBounds;
  labelPosition: LabelPosition;
  charCount?: number;
};

type EasyMotionMatch = {
  position: Position;
  text: string;
  index: number;
};

type PendingState =
  | { type: "trigger"; keys: string[] }
  | { type: "input"; spec: EasyMotionSpec; input: string }
  | { type: "label"; markers: readonly EasyMotionMarker[]; input: string };

// The result of evaluating one key against the easyMotion state ([decide]).
// [pending] keeps the overlay open (advancing to [next], optionally repainting
// [markers]); [jump] moves the cursor/extends the selection to [position] and
// ends the overlay; [clear] ends the overlay without a jump (invalid trigger,
// no/empty match). [decide] is pure; [commit] applies the outcome's side
// effects (mutating [pending] + showing/clearing markers).
export type EasyMotionOutcome =
  | { type: "pending"; next: PendingState; markers?: readonly EasyMotionMarker[] }
  | { type: "jump"; position: Position }
  | { type: "clear" };

const defaultTriggerLeaderCount = 2;

const specs: readonly EasyMotionSpec[] = [
  { keys: ["/"], search: "nchar", bounds: "bidirectional", labelPosition: "start" },
  { keys: ["s"], search: "char", bounds: "bidirectional", labelPosition: "start", charCount: 1 },
  { keys: ["f"], search: "char", bounds: "forward", labelPosition: "start", charCount: 1 },
  { keys: ["F"], search: "char", bounds: "backward", labelPosition: "start", charCount: 1 },
  { keys: ["t"], search: "char", bounds: "forward", labelPosition: "before", charCount: 1 },
  { keys: ["T"], search: "char", bounds: "backward", labelPosition: "after", charCount: 1 },
  { keys: ["2", "s"], search: "char", bounds: "bidirectional", labelPosition: "start", charCount: 2 },
  { keys: ["2", "f"], search: "char", bounds: "forward", labelPosition: "start", charCount: 2 },
  { keys: ["2", "F"], search: "char", bounds: "backward", labelPosition: "start", charCount: 2 },
  { keys: ["2", "t"], search: "char", bounds: "forward", labelPosition: "before", charCount: 2 },
  { keys: ["2", "T"], search: "char", bounds: "backward", labelPosition: "after", charCount: 2 },
  { keys: ["b", "d", "2", "t"], leaderCount: 3, search: "char", bounds: "bidirectional", labelPosition: "before", charCount: 2 },
  { keys: ["b", "d", "t"], leaderCount: 3, search: "char", bounds: "bidirectional", labelPosition: "before", charCount: 1 },
  { keys: ["w"], search: "word", bounds: "forward", labelPosition: "start" },
  { keys: ["b"], search: "word", bounds: "backward", labelPosition: "start" },
  { keys: ["e"], search: "word", bounds: "forward", labelPosition: "after" },
  { keys: ["g", "e"], search: "word", bounds: "backward", labelPosition: "after" },
  { keys: ["b", "d", "w"], leaderCount: 3, search: "word", bounds: "bidirectional", labelPosition: "start" },
  { keys: ["b", "d", "e"], leaderCount: 3, search: "word", bounds: "bidirectional", labelPosition: "after" },
  { keys: ["j"], search: "line", bounds: "forward", labelPosition: "start" },
  { keys: ["k"], search: "line", bounds: "backward", labelPosition: "start" },
  { keys: ["b", "d", "j", "k"], leaderCount: 3, search: "line", bounds: "bidirectional", labelPosition: "start" },
  { keys: ["l"], search: "jumpToAnywhere", bounds: "forward", labelPosition: "after" },
  { keys: ["h"], search: "jumpToAnywhere", bounds: "backward", labelPosition: "after" },
  { keys: ["j"], leaderCount: 3, search: "jumpToAnywhere", bounds: "bidirectional", labelPosition: "after" },
];

export class EasyMotionState {
  private pending: PendingState | undefined;

  isPending(): boolean {
    return this.pending !== undefined;
  }

  pendingChord(): string {
    switch (this.pending?.type) {
      case "trigger":
        return this.pending.keys.join("");
      case "input":
        return `${this.pending.spec.keys.join("")}${this.pending.input}`;
      case "label":
        return this.pending.input;
      case undefined:
        return "";
    }
  }

  clear(editor: VimEditorCapabilities): void {
    this.pending = undefined;
    editor.clearEasyMotionMarkers();
  }

  // Evaluate [key] against the current overlay state *without side effects*,
  // returning the [EasyMotionOutcome] the owner should [commit] (or [undefined]
  // when easyMotion does not claim the key: disabled, or a non-leader key while
  // idle). Pure so it can run in a framework handler body; the state advance and
  // marker repaint happen in [commit]. Escape is intentionally not special-cased
  // here — the caller declines it so the owner's escape handling cancels the
  // overlay, matching the legacy dispatcher where escape never reached easyMotion.
  decide(
    editor: VimEditorCapabilities,
    configuration: VimConfiguration,
    key: string
  ): EasyMotionOutcome | undefined {
    if (!configuration.easymotion) return undefined;

    switch (this.pending?.type) {
      case "trigger":
        return decideTriggerKey(editor, configuration, key, this.pending);
      case "input":
        return decideInputKey(editor, configuration, key, this.pending);
      case "label":
        return decideLabelKey(key, this.pending);
      case undefined:
        if (key !== configuration.leader) return undefined;
        return { type: "pending", next: { type: "trigger", keys: [key] } };
    }
  }

  // Apply an [EasyMotionOutcome] from [decide]: advance/clear [pending] and
  // repaint the marker overlay. A [jump] clears the overlay too — the owner
  // applies the cursor motion separately.
  commit(editor: VimEditorCapabilities, outcome: EasyMotionOutcome): void {
    switch (outcome.type) {
      case "pending":
        this.pending = outcome.next;
        if (outcome.markers !== undefined) editor.showEasyMotionMarkers(outcome.markers);
        break;
      case "jump":
      case "clear":
        this.clear(editor);
        break;
    }
  }
}

function decideTriggerKey(
  editor: VimEditorCapabilities,
  configuration: VimConfiguration,
  key: string,
  pending: Extract<PendingState, { type: "trigger" }>
): EasyMotionOutcome {
  const keys = [...pending.keys, key];
  const exact = specs.find(spec => sameKeys(triggerKeys(configuration, spec), keys));
  if (exact !== undefined) {
    if (exact.search === "char" || exact.search === "nchar") {
      return { type: "pending", next: { type: "input", spec: exact, input: "" } };
    }
    return labelOutcome(editor, configuration, exact, "");
  }

  if (specs.some(spec => isPrefixOrEqual(keys, triggerKeys(configuration, spec)))) {
    return { type: "pending", next: { type: "trigger", keys } };
  }

  return { type: "clear" };
}

function decideInputKey(
  editor: VimEditorCapabilities,
  configuration: VimConfiguration,
  key: string,
  pending: Extract<PendingState, { type: "input" }>
): EasyMotionOutcome {
  if (key === "backspace") {
    return { type: "pending", next: { ...pending, input: pending.input.slice(0, -1) } };
  }

  if (pending.spec.search === "nchar") {
    if (key === "enter") {
      if (pending.input.length === 0) return { type: "clear" };
      return labelOutcome(editor, configuration, pending.spec, pending.input);
    }
    const text = inputTextForKey(key);
    const next = text === undefined ? pending : { ...pending, input: pending.input + text };
    return { type: "pending", next };
  }

  const text = inputTextForKey(key);
  if (text === undefined) return { type: "pending", next: pending };
  const input = pending.input + text;
  if (input.length >= (pending.spec.charCount ?? 1)) {
    return labelOutcome(editor, configuration, pending.spec, input);
  }
  return { type: "pending", next: { ...pending, input } };
}

function decideLabelKey(
  key: string,
  pending: Extract<PendingState, { type: "label" }>
): EasyMotionOutcome {
  const text = inputTextForKey(key);
  if (text === undefined) return { type: "pending", next: pending };
  const input = pending.input + text;
  const matching = pending.markers.filter(marker => marker.label.startsWith(input));
  if (matching.length === 0) return { type: "clear" };
  if (matching.length === 1) return { type: "jump", position: matching[0].position };
  return {
    type: "pending",
    next: { ...pending, input },
    markers: matching.map(marker => ({ ...marker, label: marker.label.slice(input.length) })),
  };
}

// Generate the label markers for [spec]/[input] and pick the outcome: no matches
// clears, a single match jumps, multiple matches open label mode showing the
// markers. Pure (reads the editor to collect matches); [commit] paints them.
function labelOutcome(
  editor: VimEditorCapabilities,
  configuration: VimConfiguration,
  spec: EasyMotionSpec,
  input: string
): EasyMotionOutcome {
  const markers = generateMarkers(collectMatches(editor, configuration, spec, input), configuration.easymotionKeys);
  if (markers.length === 0) return { type: "clear" };
  if (markers.length === 1) return { type: "jump", position: markers[0].position };
  return { type: "pending", next: { type: "label", markers, input: "" }, markers };
}

function collectMatches(
  editor: VimEditorCapabilities,
  configuration: VimConfiguration,
  spec: EasyMotionSpec,
  input: string
): readonly Position[] {
  const cursor = selectionHead(editor.getSelections()[0]);
  const rowRange = visibleSearchRows(editor, cursor);
  const rawMatches = rawMatchesForSpec(editor, configuration, spec, input, rowRange)
    .filter(match => withinBounds(match.position, cursor, spec.bounds))
    .map(match => ({ ...match, position: labelPosition(editor, match, spec) }))
    .filter(match => !samePosition(match.position, cursor));
  return sortMatches(rawMatches, cursor).map(match => normalCursorPosition(editor, match.position));
}

function rawMatchesForSpec(
  editor: VimEditorCapabilities,
  configuration: VimConfiguration,
  spec: EasyMotionSpec,
  input: string,
  rowRange: { top: number; bottom: number }
): readonly EasyMotionMatch[] {
  switch (spec.search) {
    case "word":
      return regexMatches(editor, /\w+/g, rowRange);
    case "line":
      return lineStartMatches(editor, rowRange);
    case "jumpToAnywhere":
      return regexMatches(editor, safeRegex(configuration.easymotionJumpToAnywhereRegex), rowRange);
    case "char":
    case "nchar":
      return input.length === 0 ? [] : regexMatches(editor, escapedRegex(input), rowRange);
  }
}

function visibleSearchRows(editor: VimEditorCapabilities, cursor: Position): { top: number; bottom: number } {
  const visible = editor.visibleRowRange();
  const top = visible?.top ?? 0;
  const bottom = visible?.bottom ?? editor.lineCount() - 1;
  return {
    top: Math.max(0, Math.max(top, cursor.row - 100)),
    bottom: Math.min(editor.lineCount() - 1, Math.min(bottom, cursor.row + 100)),
  };
}

function regexMatches(editor: VimEditorCapabilities, regex: RegExp, rowRange: { top: number; bottom: number }): readonly EasyMotionMatch[] {
  const matches: EasyMotionMatch[] = [];
  for (let row = rowRange.top; row <= rowRange.bottom && matches.length < 1000; row++) {
    const line = editor.line(row);
    regex.lastIndex = 0;
    let result = regex.exec(line);
    while (result !== null && matches.length < 1000) {
      matches.push({ position: { row, column: result.index }, text: result[0], index: matches.length });
      if (result[0].length === 0) regex.lastIndex++;
      result = regex.exec(line);
    }
  }
  return matches;
}

function lineStartMatches(editor: VimEditorCapabilities, rowRange: { top: number; bottom: number }): readonly EasyMotionMatch[] {
  const matches: EasyMotionMatch[] = [];
  for (let row = rowRange.top; row <= rowRange.bottom && matches.length < 1000; row++) {
    const column = firstNonWhitespace(editor.line(row));
    matches.push({ position: { row, column }, text: editor.line(row).slice(column, column + 1), index: matches.length });
  }
  return matches;
}

function labelPosition(editor: VimEditorCapabilities, match: EasyMotionMatch, spec: EasyMotionSpec): Position {
  switch (spec.labelPosition) {
    case "start":
      return match.position;
    case "before":
      return { row: match.position.row, column: Math.max(0, match.position.column - 1) };
    case "after":
      return { row: match.position.row, column: Math.min(editor.lineLength(match.position.row), match.position.column + match.text.length - 1) };
  }
}

function withinBounds(position: Position, cursor: Position, bounds: SearchBounds): boolean {
  switch (bounds) {
    case "bidirectional":
      return true;
    case "forward":
      return comparePosition(position, cursor) >= 0;
    case "backward":
      return comparePosition(position, cursor) <= 0;
  }
}

function sortMatches(matches: readonly EasyMotionMatch[], cursor: Position): readonly EasyMotionMatch[] {
  let cursorIndex = 0;
  for (const match of matches) {
    if (comparePosition(match.position, cursor) < 0) cursorIndex = match.index + 1;
  }
  return [...matches].sort((left, right) => distanceFromCursor(left.index, cursorIndex) - distanceFromCursor(right.index, cursorIndex));
}

function distanceFromCursor(index: number, cursorIndex: number): number {
  const distance = Math.abs(cursorIndex - index);
  return index < cursorIndex ? distance - 0.5 : distance;
}

function generateMarkers(positions: readonly Position[], keys: string): readonly EasyMotionMarker[] {
  const keyTable = keys.length === 0 ? ["h", "j", "k", "l"] : keys.split("");
  const prefixKeyTable = createPrefixKeyTable(positions.length, keyTable);
  return positions.flatMap((position, index) => {
    const label = markerLabel(index, keyTable, prefixKeyTable);
    return label === undefined ? [] : [{ label, position }];
  });
}

function createPrefixKeyTable(matchCount: number, keyTable: readonly string[]): readonly string[] {
  const totalRemainder = Math.max(matchCount - keyTable.length, 0);
  const totalSteps = Math.ceil(totalRemainder / keyTable.length);
  return [...keyTable].reverse().slice(0, Math.min(totalSteps, keyTable.length));
}

function markerLabel(index: number, keyTable: readonly string[], prefixKeyTable: readonly string[]): string | undefined {
  if (index < keyTable.length - prefixKeyTable.length) return keyTable[index];
  const remainder = index - (keyTable.length - prefixKeyTable.length);
  const currentStep = Math.floor(remainder / keyTable.length) + 1;
  if (currentStep > prefixKeyTable.length) return undefined;
  return `${prefixKeyTable[currentStep - 1]}${keyTable[remainder % keyTable.length]}`;
}

function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "g");
  } catch (_error) {
    return /\w+/g;
  }
}

function escapedRegex(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
}

function inputTextForKey(key: string): string | undefined {
  if (key === "space") return " ";
  if (key.length === 1) return key;
  return undefined;
}

function firstNonWhitespace(line: string): number {
  const index = line.search(/\S/);
  return index < 0 ? 0 : index;
}

function comparePosition(left: Position, right: Position): number {
  return left.row === right.row ? left.column - right.column : left.row - right.row;
}

function triggerKeys(configuration: VimConfiguration, spec: EasyMotionSpec): readonly string[] {
  const leaderCount = spec.leaderCount ?? defaultTriggerLeaderCount;
  return [...Array.from({ length: leaderCount }, () => configuration.leader), ...spec.keys];
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function isPrefixOrEqual(prefix: readonly string[], full: readonly string[]): boolean {
  return prefix.length <= full.length && prefix.every((key, index) => key === full[index]);
}
