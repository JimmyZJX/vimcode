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
import type { RangeOperator } from "./operator_target.js";
import type { Operator, TextRange, VimMode, VimSelection } from "./state.js";

/** Vim `o_v`/`o_V`: `v`/`V` between an operator and its motion force the
    motion charwise (toggling inclusivity) or linewise. */
export type ForcedMotion = "charwise" | "linewise";

export type PendingEditOperator =
  | { type: "change"; count: number; forcedMotion?: ForcedMotion }
  | { type: "delete"; count: number; forcedMotion?: ForcedMotion }
  | { type: "yank"; count: number; forcedMotion?: ForcedMotion };

export type PendingObjectOperator = { type: "object"; around: boolean };

export type PendingConvertOperator =
  | { type: "lowercase"; count: number; forcedMotion?: ForcedMotion }
  | { type: "uppercase"; count: number; forcedMotion?: ForcedMotion }
  | { type: "oppositeCase"; count: number; forcedMotion?: ForcedMotion }
  | { type: "rot13"; count: number; forcedMotion?: ForcedMotion };

export type PendingIndentOperator =
  | { type: "indent"; count: number; forcedMotion?: ForcedMotion }
  | { type: "outdent"; count: number; forcedMotion?: ForcedMotion }
  | { type: "autoIndent"; count: number; forcedMotion?: ForcedMotion };

// Zed: `state::Operator` — every operator that consumes a motion, object,
// line doubling, or `G`-style row target resolves through one pending shape.
export type PendingRangeOperator = PendingEditOperator | PendingConvertOperator | PendingIndentOperator;

export type PendingSurroundTarget = { ranges: readonly TextRange[]; linewise: boolean };

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
  | PendingRegisterOperator
  | PendingRecordRegisterOperator
  | PendingReplayRegisterOperator
  | PendingCommandOperator;

export type VimOperator = TopLevelPendingOperator | NormalPendingOperator | VisualPendingOperator;

const editOperatorTypes = new Set<PendingEditOperator["type"]>(["change", "delete", "yank"]);
const convertOperatorTypes = new Set<PendingConvertOperator["type"]>(["lowercase", "uppercase", "oppositeCase", "rot13"]);
const indentOperatorTypes = new Set<PendingIndentOperator["type"]>(["indent", "outdent", "autoIndent"]);
const rangeOperatorTypes = new Set<PendingRangeOperator["type"]>([...editOperatorTypes, ...convertOperatorTypes, ...indentOperatorTypes]);
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
    case "rot13":
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

// Zed: the `vim_operator` key-context value computed in
// `vim::Vim::extend_key_context`. Summarizes what the operator stack is
// currently waiting for, so keymap conditions can read like Zed context
// expressions instead of combining overlapping booleans.
export type OperatorContext = "none" | Operator | "convert" | "indent" | "surround" | "object" | "other";

export function isEditOperatorContext(operator: OperatorContext): operator is Operator {
  return operator === "delete" || operator === "change" || operator === "yank";
}

/** A range-consuming operator (d/c/y/gu/gU/g~/>/</=/ys) is awaiting its
    motion/object/line target. Zed: `vim_operator` matching any of the
    range-operator contexts. */
export function isRangeOperatorContext(operator: OperatorContext): boolean {
  return isEditOperatorContext(operator) || operator === "convert" || operator === "indent" || operator === "surround";
}

// Zed: `vim_mode == waiting` plus the per-operator contexts; one classification
// of "what input is the operator stack waiting for". The variant order in
// [VimOperatorStack.waitingInput] is the single source of truth for
// waiting-input precedence.
export type WaitingInput =
  // Self-escape-handling waiting inputs: these consume the escape key
  // themselves instead of letting the central escape handling cancel them.
  | { type: "insertDigraph" }
  | { type: "literal" }
  | { type: "insertRegister" }
  // Other top-level waiting inputs (mode-gated where Vim requires it).
  | { type: "recordRegister" }
  | { type: "replayRegister" }
  | { type: "register" }
  | { type: "command" }
  | { type: "search" }
  | { type: "find" }
  | { type: "mark" }
  | { type: "jump" }
  // Normal/visual-mode operator inputs.
  | { type: "normalDigraph" }
  | { type: "normalReplace" }
  | { type: "normalSurround" }
  | { type: "normalTextObject" }
  | { type: "normalSurroundPrefix" }
  | { type: "visualSurround" }
  | { type: "visualTextObject" };

export function isSelfEscapingWaitingInput(waiting: WaitingInput): boolean {
  switch (waiting.type) {
    case "insertDigraph":
    case "literal":
    case "insertRegister":
      return true;
    default:
      return false;
  }
}

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

  // Zed: `vim::Vim::extend_key_context` exposing `vim_operator`.
  // "object" wins over the range operator because the object selector is on top
  // of the stack and owns the next key (e.g. the quote in `di'`).
  operatorContext(): OperatorContext {
    if (this.length === 0) return "none";
    if (this.activeObject() !== undefined) return "object";
    if (this.surroundAwaitingRange() !== undefined) return "surround";
    const pending = this.activeRangeOperator();
    if (pending === undefined) return "other";
    switch (pending.type) {
      case "change":
      case "delete":
      case "yank":
        return pending.type;
      case "lowercase":
      case "uppercase":
      case "oppositeCase":
      case "rot13":
        return "convert";
      case "indent":
      case "outdent":
      case "autoIndent":
        return "indent";
    }
  }

  // Zed: the per-operator `vim_operator` contexts that bind `vim::CurrentLine`
  // ("u" under `vim_operator == gu`, ">" under `vim_operator == gt`, ...).
  // Doubling is one rule: repeating the pending operator's final key targets
  // whole lines.
  operatorPendingKey(): string | undefined {
    if (this.activeObject() !== undefined) return undefined;
    // vim-surround `yss`: doubling the `s` of a pending `ys` targets the line.
    if (this.surroundAwaitingRange() !== undefined) return "s";
    const pending = this.activeRangeOperator();
    if (pending === undefined) return undefined;
    switch (pending.type) {
      case "change":
        return "c";
      case "delete":
        return "d";
      case "yank":
        return "y";
      case "lowercase":
        return "u";
      case "uppercase":
        return "U";
      case "oppositeCase":
        return "~";
      case "rot13":
        return "?";
      case "indent":
        return ">";
      case "outdent":
        return "<";
      case "autoIndent":
        return "=";
    }
  }

  waitingInput(mode: VimMode["kind"], key: string): WaitingInput | undefined {
    if (this.activeTopLevel("insertDigraph") !== undefined) return { type: "insertDigraph" };
    if (this.activeTopLevel("literal") !== undefined) return { type: "literal" };
    if (this.activeTopLevel("insertRegister") !== undefined) return { type: "insertRegister" };
    if (mode === "normal" && this.activeTopLevel("recordRegister") !== undefined) return { type: "recordRegister" };
    if (mode === "normal" && this.activeTopLevel("replayRegister") !== undefined) return { type: "replayRegister" };
    if (this.activeTopLevel("register") !== undefined) return { type: "register" };
    if (this.activeTopLevel("command") !== undefined) return { type: "command" };
    if (this.activeTopLevel("search") !== undefined) return { type: "search" };
    if (this.activeFind() !== undefined) return { type: "find" };
    if (mode === "normal" && this.activeTopLevel("mark") !== undefined) return { type: "mark" };
    if (mode === "normal" && this.activeTopLevel("jump") !== undefined) return { type: "jump" };

    switch (mode) {
      case "normal":
        if (this.activeDigraph() !== undefined) return { type: "normalDigraph" };
        if (this.activeReplace() !== undefined) return { type: "normalReplace" };
        // Surrounds are only waiting input while they consume pair characters
        // (`ds(`, `cs('`, the closing char of `ysiw)`); a `ys` awaiting its
        // range resolves motions/objects/counts through the keymap instead.
        if (this.activeSurround() !== undefined && this.surroundAwaitingRange() === undefined && this.activeObject() === undefined) {
          return { type: "normalSurround" };
        }
        if (this.activeObject() !== undefined) return { type: "normalTextObject" };
        if (this.activeEditOperator() !== undefined && key === "s") return { type: "normalSurroundPrefix" };
        return undefined;
      case "visual":
      case "visualLine":
      case "visualBlock":
        if (this.activeVisualOperator("visualAddSurrounds") !== undefined) return { type: "visualSurround" };
        if (this.activeObject() !== undefined) return { type: "visualTextObject" };
        return undefined;
      default:
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

  activeSurround(): PendingSurroundOperator | undefined {
    return this.activeNormalOperatorOfTypes(surroundOperatorTypes);
  }

  /** A pending `ys` that has not captured its range yet. */
  surroundAwaitingRange(): Extract<PendingSurroundOperator, { type: "addSurrounds" }> | undefined {
    const pending = this.activeSurround();
    return pending?.type === "addSurrounds" && pending.target === undefined ? pending : undefined;
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

  activeRangeOperator(): PendingRangeOperator | undefined {
    return this.activeNormalOperatorOfTypes(rangeOperatorTypes);
  }

  popRangeOperator(): PendingRangeOperator | undefined {
    return this.popNormalOperatorOfTypes(rangeOperatorTypes);
  }

  popEditOperator(): PendingEditOperator | undefined {
    return this.popNormalOperatorOfTypes(editOperatorTypes);
  }

  forceMotion(force: ForcedMotion): void {
    const pending = this.activeRangeOperator();
    if (pending === undefined) return;
    this.replaceActiveOfTypes(rangeOperatorTypes, { ...pending, forcedMotion: force });
    this.pushChordKey(force === "charwise" ? "v" : "V");
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
    case "rot13":
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

// Zed: the `state::Operator` value dispatched by `normal_motion` /
// `normal_object`; pending stack entries lower to the one `RangeOperator`
// vocabulary consumed by `applyOperatorToTarget`.
export function rangeOperatorForPending(pending: PendingRangeOperator): RangeOperator {
  switch (pending.type) {
    case "change":
    case "delete":
    case "yank":
      return { type: pending.type };
    case "lowercase":
      return { type: "convert", target: "lower" };
    case "uppercase":
      return { type: "convert", target: "upper" };
    case "oppositeCase":
      return { type: "convert", target: "toggle" };
    case "rot13":
      return { type: "convert", target: "rot13" };
    case "indent":
      return { type: "indent", direction: "in" };
    case "outdent":
      return { type: "indent", direction: "out" };
    case "autoIndent":
      return { type: "indent", direction: "auto" };
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
    case "rot13":
      return { type: "rot13", count };
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
    case "rot13":
      return "rot13";
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


