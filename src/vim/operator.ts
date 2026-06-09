// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: state::Operator and vim::Vim::operator_stack
// - translated concepts: one central pending/operator stack owned by Vim, plus
//   helpers for status text and waiting-input classification.
// - intentional differences: some variants still carry local fields (counts, visual
//   undo selections, command input) so existing normal/visual execution helpers can
//   keep their behavior while the architecture converges on Zed's operator_stack.

import type { PendingSearch } from "./normal/search.js";
import type { ConvertTarget } from "./normal/convert.js";
import type { IndentDirection } from "./normal/indent.js";
import type { Operator, TextRange, VimSelection } from "./state.js";

export type PendingEditOperator =
  | { type: "change"; count: number }
  | { type: "delete"; count: number }
  | { type: "yank"; count: number };

export type PendingObjectOperator = { type: "object"; around: boolean };

export type PendingConvertOperator =
  | { type: "lowercase"; count: number }
  | { type: "uppercase"; count: number }
  | { type: "oppositeCase"; count: number };

export type PendingIndentOperator =
  | { type: "indent"; count: number }
  | { type: "outdent"; count: number }
  | { type: "autoIndent"; count: number };

export type PendingSurroundTarget =
  | { type: "object"; around: boolean }
  | { type: "ranges"; ranges: readonly TextRange[]; linewise: boolean };

export type PendingSurroundOperator =
  | { type: "addSurrounds"; count: number; target?: PendingSurroundTarget }
  | { type: "deleteSurrounds" }
  | { type: "changeSurrounds"; fromKey?: string };

export type PendingReplaceOperator = { type: "replace"; count: number };
export type PendingDigraphOperator = { type: "digraph"; count: number; first?: string };

export type NormalPendingOperator =
  | PendingEditOperator
  | PendingObjectOperator
  | PendingConvertOperator
  | PendingIndentOperator
  | PendingSurroundOperator
  | PendingReplaceOperator
  | PendingDigraphOperator;

export type VisualPendingOperator =
  | PendingObjectOperator
  | { type: "visualAddSurrounds"; ranges: readonly TextRange[]; linewise: boolean; undoSelectionsBefore: readonly VimSelection[] };

export type PendingFindOperator =
  | { type: "findForward"; before: boolean; count: number }
  | { type: "findBackward"; after: boolean; count: number };

export type PendingInsertDigraphOperator =
  | { type: "insertDigraph"; target: "insert" | "replace"; first?: string }
  | { type: "insertDigraph"; target: "find"; pending: PendingFindOperator; first?: string };

export type PendingLiteralOperator =
  | { type: "literal"; kind: "plain" }
  | { type: "literal"; kind: "decimal"; digits: string }
  | { type: "literal"; kind: "hex"; digits: string; maxDigits: number };

export type PendingInsertRegisterOperator = { type: "insertRegister" };
export type PendingMarkOperator = { type: "mark" };
export type PendingJumpOperator = { type: "jump"; line: boolean };
export type PendingUnmatchedOperator = { type: "unmatchedForward" | "unmatchedBackward"; count: number };
export type PendingRegisterOperator = { type: "register" };
export type PendingRecordRegisterOperator = { type: "recordRegister" };
export type PendingReplayRegisterOperator = { type: "replayRegister"; count: number };
export type PendingCommandOperator = { type: "command"; input: string };

export type TopLevelPendingOperator =
  | PendingSearch
  | PendingFindOperator
  | PendingInsertDigraphOperator
  | PendingLiteralOperator
  | PendingInsertRegisterOperator
  | PendingMarkOperator
  | PendingJumpOperator
  | PendingUnmatchedOperator
  | PendingRegisterOperator
  | PendingRecordRegisterOperator
  | PendingReplayRegisterOperator
  | PendingCommandOperator;

export type VimOperator = TopLevelPendingOperator | NormalPendingOperator | VisualPendingOperator;

const editOperatorTypes = new Set<PendingEditOperator["type"]>(["change", "delete", "yank"]);
const convertOperatorTypes = new Set<PendingConvertOperator["type"]>(["lowercase", "uppercase", "oppositeCase"]);
const indentOperatorTypes = new Set<PendingIndentOperator["type"]>(["indent", "outdent", "autoIndent"]);
const surroundOperatorTypes = new Set<PendingSurroundOperator["type"]>(["addSurrounds", "deleteSurrounds", "changeSurrounds"]);
const replaceOperatorTypes = new Set<PendingReplaceOperator["type"]>(["replace"]);
const digraphOperatorTypes = new Set<PendingDigraphOperator["type"]>(["digraph"]);

function isVisualPendingOperator(operator: VimOperator | undefined): operator is VisualPendingOperator {
  switch (operator?.type) {
    case "object":
    case "visualAddSurrounds":
      return true;
    default:
      return false;
  }
}

function isNormalPendingOperator(operator: VimOperator | undefined): operator is NormalPendingOperator {
  switch (operator?.type) {
    case "change":
    case "delete":
    case "yank":
    case "object":
    case "lowercase":
    case "uppercase":
    case "oppositeCase":
    case "indent":
    case "outdent":
    case "autoIndent":
    case "addSurrounds":
    case "deleteSurrounds":
    case "changeSurrounds":
    case "replace":
    case "digraph":
      return true;
    default:
      return false;
  }
}

type NormalChordKey = {
  key: string;
  includeCount?: boolean;
  countText: string;
  hasSelectedRegister: boolean;
};

export type WaitingInput =
  | { type: "normalDigraph" }
  | { type: "normalReplace" }
  | { type: "normalSurround" }
  | { type: "normalConvert" }
  | { type: "normalIndent" }
  | { type: "normalTextObject" }
  | { type: "normalSurroundPrefix" }
  | { type: "visualSurround" }
  | { type: "visualTextObject" };

export class VimOperatorStack {
  private readonly stack: VimOperator[] = [];
  private readonly chordKeys: string[] = [];

  get length(): number {
    return this.stack.length;
  }

  top(): VimOperator | undefined {
    return this.stack[this.stack.length - 1];
  }

  push(operator: VimOperator): void {
    this.stack.push(operator);
  }

  pop(): VimOperator | undefined {
    return this.stack.pop();
  }

  clear(): void {
    this.stack.length = 0;
    this.chordKeys.length = 0;
  }

  replaceTop(operator: VimOperator): void {
    if (this.stack.length === 0) this.push(operator);
    else this.stack[this.stack.length - 1] = operator;
  }

  waitingInput(mode: "normal" | "visual" | "visualLine" | "visualBlock", key: string): WaitingInput | undefined {
    switch (mode) {
      case "normal":
        if (this.activeDigraph() !== undefined) return { type: "normalDigraph" };
        if (this.activeReplace() !== undefined) return { type: "normalReplace" };
        if (this.activeSurround() !== undefined) return { type: "normalSurround" };
        if (this.activeConvert() !== undefined && this.activeObject() === undefined) return { type: "normalConvert" };
        if (this.activeIndent() !== undefined && this.activeObject() === undefined) return { type: "normalIndent" };
        if (this.activeObject() !== undefined) return { type: "normalTextObject" };
        if (this.activeEditOperator() !== undefined && key === "s") return { type: "normalSurroundPrefix" };
        return undefined;
      case "visual":
      case "visualLine":
      case "visualBlock":
        if (this.activeVisualOperator("visualAddSurrounds") !== undefined) return { type: "visualSurround" };
        if (this.activeObject() !== undefined) return { type: "visualTextObject" };
        return undefined;
    }
  }

  active<Type extends VimOperator["type"]>(type: Type): Extract<VimOperator, { type: Type }> | undefined {
    const item = this.top();
    return item?.type === type ? item as Extract<VimOperator, { type: Type }> : undefined;
  }

  activeOfTypes<const Type extends VimOperator["type"]>(types: ReadonlySet<Type>): Extract<VimOperator, { type: Type }> | undefined {
    for (let index = this.stack.length - 1; index >= 0; index--) {
      const item = this.stack[index];
      if (types.has(item.type as Type)) return item as Extract<VimOperator, { type: Type }>;
    }
    return undefined;
  }

  popOfTypes<const Type extends VimOperator["type"]>(types: ReadonlySet<Type>): Extract<VimOperator, { type: Type }> | undefined {
    for (let index = this.stack.length - 1; index >= 0; index--) {
      const item = this.stack[index];
      if (types.has(item.type as Type)) {
        this.stack.splice(index, 1);
        return item as Extract<VimOperator, { type: Type }>;
      }
    }
    return undefined;
  }

  replaceActiveOfTypes<const Type extends VimOperator["type"]>(
    types: ReadonlySet<Type>,
    operator: Extract<VimOperator, { type: Type }>
  ): boolean {
    for (let index = this.stack.length - 1; index >= 0; index--) {
      if (types.has(this.stack[index].type as Type)) {
        this.stack[index] = operator;
        return true;
      }
    }
    return false;
  }

  activeTopLevel<Type extends TopLevelPendingOperator["type"]>(type: Type): Extract<TopLevelPendingOperator, { type: Type }> | undefined {
    const item = this.active(type);
    return isTopLevelPendingOperator(item) ? item as Extract<TopLevelPendingOperator, { type: Type }> : undefined;
  }

  popTopLevel<Type extends TopLevelPendingOperator["type"]>(type: Type): Extract<TopLevelPendingOperator, { type: Type }> | undefined {
    const item = this.activeTopLevel(type);
    if (item === undefined) return undefined;
    this.pop();
    return item;
  }

  activeFind(): PendingFindOperator | undefined {
    const item = this.top();
    return item?.type === "findForward" || item?.type === "findBackward" ? item : undefined;
  }

  popFind(): PendingFindOperator | undefined {
    const item = this.activeFind();
    if (item === undefined) return undefined;
    this.pop();
    return item;
  }

  activeUnmatched(): PendingUnmatchedOperator | undefined {
    const item = this.top();
    return item?.type === "unmatchedForward" || item?.type === "unmatchedBackward" ? item : undefined;
  }

  popUnmatched(): PendingUnmatchedOperator | undefined {
    const item = this.activeUnmatched();
    if (item === undefined) return undefined;
    this.pop();
    return item;
  }

  replaceActiveInsertDigraph(digraph: PendingInsertDigraphOperator): void {
    if (this.activeTopLevel("insertDigraph") === undefined) this.push(digraph);
    else this.replaceTop(digraph);
  }

  replaceActiveLiteral(literal: PendingLiteralOperator): void {
    if (this.activeTopLevel("literal") === undefined) this.push(literal);
    else this.replaceTop(literal);
  }

  replaceActiveCommand(input: string): void {
    const command = { type: "command" as const, input };
    if (this.activeTopLevel("command") === undefined) this.push(command);
    else this.replaceTop(command);
  }

  activeEditOperator(): PendingEditOperator | undefined {
    return this.activeNormalOperatorOfTypes(editOperatorTypes);
  }

  activeConvert(): PendingConvertOperator | undefined {
    return this.activeNormalOperatorOfTypes(convertOperatorTypes);
  }

  activeIndent(): PendingIndentOperator | undefined {
    return this.activeNormalOperatorOfTypes(indentOperatorTypes);
  }

  activeSurround(): PendingSurroundOperator | undefined {
    return this.activeNormalOperatorOfTypes(surroundOperatorTypes);
  }

  activeReplace(): PendingReplaceOperator | undefined {
    return this.activeNormalOperatorOfTypes(replaceOperatorTypes);
  }

  activeDigraph(): PendingDigraphOperator | undefined {
    return this.activeNormalOperatorOfTypes(digraphOperatorTypes);
  }

  activeObject(): PendingObjectOperator | undefined {
    return this.active("object");
  }

  popEditOperator(): PendingEditOperator | undefined {
    return this.popNormalOperatorOfTypes(editOperatorTypes);
  }

  popConvert(): PendingConvertOperator | undefined {
    return this.popNormalOperatorOfTypes(convertOperatorTypes);
  }

  popIndent(): PendingIndentOperator | undefined {
    return this.popNormalOperatorOfTypes(indentOperatorTypes);
  }

  popSurround(): PendingSurroundOperator | undefined {
    return this.popNormalOperatorOfTypes(surroundOperatorTypes);
  }

  popReplace(): PendingReplaceOperator | undefined {
    return this.popNormalOperatorOfTypes(replaceOperatorTypes);
  }

  popDigraph(): PendingDigraphOperator | undefined {
    return this.popNormalOperatorOfTypes(digraphOperatorTypes);
  }

  popObject(): PendingObjectOperator | undefined {
    const item = this.activeObject();
    if (item === undefined) return undefined;
    this.pop();
    return item;
  }

  activeVisualOperator<Type extends VisualPendingOperator["type"]>(type: Type): Extract<VisualPendingOperator, { type: Type }> | undefined {
    const item = this.active(type);
    return isVisualPendingOperator(item) ? item as Extract<VisualPendingOperator, { type: Type }> : undefined;
  }

  popVisualOperator<Type extends VisualPendingOperator["type"]>(type: Type): Extract<VisualPendingOperator, { type: Type }> | undefined {
    const item = this.activeVisualOperator(type);
    if (item === undefined) return undefined;
    this.pop();
    return item;
  }

  pushVisualAddSurrounds(args: Omit<Extract<VisualPendingOperator, { type: "visualAddSurrounds" }>, "type">): void {
    this.push({ type: "visualAddSurrounds", ...args });
  }

  pushEditOperator(operator: Operator, count: number, chord?: NormalChordKey): void {
    this.pushNormalChordKey(chord);
    this.push(pendingEditOperator(operator, count));
  }

  pushObject(around: boolean, chord?: NormalChordKey): void {
    this.pushNormalChordKey(chord);
    this.push({ type: "object", around });
  }

  pushConvert(target: ConvertTarget, count: number, chord?: NormalChordKey): void {
    this.pushNormalChordKey(chord);
    this.push(pendingConvertOperator(target, count));
  }

  pushIndent(direction: IndentDirection, count: number, chord?: NormalChordKey): void {
    this.pushNormalChordKey(chord);
    this.push(pendingIndentOperator(direction, count));
  }

  pushSurround(surround: PendingSurroundOperator): void {
    if (surround.type === "addSurrounds" && surround.target === undefined) {
      this.pushNormalChordKey({ key: "s", countText: "", hasSelectedRegister: true });
    }
    this.push(surround);
  }

  pushReplace(count: number, chord?: NormalChordKey): void {
    this.pushNormalChordKey(chord);
    this.push({ type: "replace", count });
  }

  pushDigraph(count: number, chord?: NormalChordKey): void {
    this.pushNormalChordKey(chord);
    this.push({ type: "digraph", count });
  }

  replaceActiveDigraph(digraph: PendingDigraphOperator): void {
    if (!this.replaceActiveOfTypes(digraphOperatorTypes, digraph)) this.push(digraph);
  }

  replaceActiveSurround(surround: PendingSurroundOperator): boolean {
    return this.replaceActiveOfTypes(surroundOperatorTypes, surround);
  }

  private pushNormalChordKey(chord: NormalChordKey | undefined): void {
    if (chord === undefined) return;
    if (this.length === 0 && !chord.hasSelectedRegister) this.clearChordKeys();
    if (chord.includeCount && chord.countText.length > 0) this.pushChordKeys(chord.countText);
    this.pushChordKey(chord.key);
  }

  private activeNormalOperatorOfTypes<const Type extends NormalPendingOperator["type"]>(types: ReadonlySet<Type>): Extract<NormalPendingOperator, { type: Type }> | undefined {
    const item = this.activeOfTypes(types);
    return isNormalPendingOperator(item) ? item : undefined;
  }

  private popNormalOperatorOfTypes<const Type extends NormalPendingOperator["type"]>(types: ReadonlySet<Type>): Extract<NormalPendingOperator, { type: Type }> | undefined {
    const item = this.popOfTypes(types);
    return isNormalPendingOperator(item) ? item : undefined;
  }

  clearChordKeys(): void {
    this.chordKeys.length = 0;
  }

  pushChordKeys(keys: Iterable<string>): void {
    this.chordKeys.push(...keys);
  }

  pushChordKey(key: string): void {
    this.chordKeys.push(key);
  }

  chordText(): string {
    return this.chordKeys.join("");
  }
}

export function isTopLevelPendingOperator(operator: VimOperator | undefined): operator is TopLevelPendingOperator {
  switch (operator?.type) {
    case "search":
    case "findForward":
    case "findBackward":
    case "insertDigraph":
    case "literal":
    case "insertRegister":
    case "mark":
    case "jump":
    case "unmatchedForward":
    case "unmatchedBackward":
    case "register":
    case "recordRegister":
    case "replayRegister":
    case "command":
      return true;
    case undefined:
    case "change":
    case "delete":
    case "yank":
    case "object":
    case "lowercase":
    case "uppercase":
    case "oppositeCase":
    case "indent":
    case "outdent":
    case "autoIndent":
    case "addSurrounds":
    case "deleteSurrounds":
    case "changeSurrounds":
    case "replace":
    case "digraph":
    case "visualAddSurrounds":
      return false;
  }
}

export function pendingOperatorStatus(operator: TopLevelPendingOperator): string {
  switch (operator.type) {
    case "search":
      return operator.backwards ? "?" : "/";
    case "findForward":
      return operator.before ? "t" : "f";
    case "findBackward":
      return operator.after ? "T" : "F";
    case "insertDigraph":
      return operator.first === undefined ? "ctrl-k" : `ctrl-k${operator.first}`;
    case "literal":
      return operator.kind === "plain" ? "ctrl-v" : `ctrl-v${operator.digits}`;
    case "insertRegister":
      return "ctrl-r";
    case "mark":
      return "m";
    case "jump":
      return operator.line ? "'" : "`";
    case "unmatchedForward":
      return "]";
    case "unmatchedBackward":
      return "[";
    case "register":
      return "\"";
    case "recordRegister":
      return "q";
    case "replayRegister":
      return "@";
    case "command":
      return `:${operator.input}`;
  }
}

export function pendingEditOperator(operator: Operator, count: number): PendingEditOperator {
  switch (operator) {
    case "change":
      return { type: "change", count };
    case "delete":
      return { type: "delete", count };
    case "yank":
      return { type: "yank", count };
  }
}

export function editOperatorForPending(operator: PendingEditOperator): Operator {
  switch (operator.type) {
    case "change":
      return "change";
    case "delete":
      return "delete";
    case "yank":
      return "yank";
  }
}

export function pendingConvertOperator(target: ConvertTarget, count: number): PendingConvertOperator {
  switch (target) {
    case "lower":
      return { type: "lowercase", count };
    case "upper":
      return { type: "uppercase", count };
    case "toggle":
      return { type: "oppositeCase", count };
  }
}

export function convertTargetForPending(operator: PendingConvertOperator): ConvertTarget {
  switch (operator.type) {
    case "lowercase":
      return "lower";
    case "uppercase":
      return "upper";
    case "oppositeCase":
      return "toggle";
  }
}

export function pendingIndentOperator(direction: IndentDirection, count: number): PendingIndentOperator {
  switch (direction) {
    case "in":
      return { type: "indent", count };
    case "out":
      return { type: "outdent", count };
    case "auto":
      return { type: "autoIndent", count };
  }
}

export function indentDirectionForPending(operator: PendingIndentOperator): IndentDirection {
  switch (operator.type) {
    case "indent":
      return "in";
    case "outdent":
      return "out";
    case "autoIndent":
      return "auto";
  }
}
