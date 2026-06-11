// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: assets/keymaps/vim.json, vim::Vim::action, vim::Vim::push_operator
// - translated concepts: key sequences resolve to semantic Vim actions, which are
//   executed by Vim against central mode/operator state.
// - intentional differences: VSCode key ownership is decided before this resolver runs,
//   and a few legacy fallback paths remain while behavior is migrated into actions.

import type { HostCommand, HostDirection, HostFoldCommand, HostRevealTarget } from "./editor.js";
import { Motion, motionForKey } from "./motion.js";
import type { ConvertTarget } from "./normal/convert.js";
import type { IndentDirection } from "./normal/indent.js";
import { isRangeOperatorContext, type OperatorContext } from "./operator.js";
import { isVisualModeKind, type Operator, type VimMode } from "./state.js";

export type VisualModeKind = "visual" | "visualLine" | "visualBlock";

export type VisualCommand =
  | { type: "insertAtSelection"; side: "start" | "end" }
  | { type: "startSurround" }
  | { type: "indent"; key: ">" | "<" | "=" }
  | { type: "convert"; key: "u" | "U" | "~" }
  | { type: "startTextObject"; around: boolean }
  | { type: "otherEnd"; rowAware: boolean }
  | { type: "yankLinewise" }
  | { type: "yank" }
  | { type: "deleteToLineEnd" }
  | { type: "delete" }
  | { type: "change" }
  | { type: "paste" }
  | { type: "percentOrMatching" };

export type NormalCommand =
  | { type: "insertBefore" }
  | { type: "insertAfter" }
  | { type: "insertFirstNonWhitespace" }
  | { type: "insertEndOfLine" }
  | { type: "openLine"; above: boolean }
  | { type: "pushReplace" }
  | { type: "substituteCharacters" }
  | { type: "substituteLines" }
  | { type: "changeToEndOfLine" }
  | { type: "deleteToEndOfLine" }
  | { type: "deleteLeft" }
  | { type: "deleteRight" }
  | { type: "toggleCase" }
  | { type: "paste"; before: boolean }
  | { type: "moveLineFirstNonWhitespace"; direction: "up" | "down" }
  | { type: "percentOrMatching" }
  | { type: "goToLineOrEnd" }
  | { type: "moveToNextLineStart" };

export type VimAction =
  | { type: "pushMark" }
  | { type: "pushJump"; line: boolean }
  | { type: "insertEmptyLines"; side: "above" | "below" }
  | { type: "repeatLastChange" }
  | { type: "cancelRepeat" }
  | { type: "startCommand" }
  | { type: "toggleVisual"; mode: VisualModeKind }
  | { type: "forceMotion"; force: "charwise" | "linewise" }
  | { type: "enterReplace" }
  | { type: "changeList"; direction: "older" | "newer" }
  | { type: "insertAtPrevious" }
  | { type: "page"; direction: HostDirection; halfPage: boolean }
  | { type: "restoreVisualSelection" }
  | { type: "searchSelection"; reversed: boolean }
  | { type: "pushConvert"; target: ConvertTarget }
  | { type: "join"; insertWhitespace: boolean }
  | { type: "incrementStep"; direction: "increment" | "decrement"; cumulative: boolean }
  | { type: "multiCursor"; command: string }
  | { type: "native"; command: string }
  | { type: "hostCommand"; command: HostCommand }
  | { type: "scrollLines"; direction: HostDirection }
  | { type: "revealCurrentLine"; target: HostRevealTarget }
  | { type: "fold"; command: HostFoldCommand }
  | { type: "repeatSearch"; reversed: boolean }
  | { type: "repeatFind"; reversed: boolean }
  | { type: "pushFindForward"; before: boolean }
  | { type: "pushFindBackward"; after: boolean }
  | { type: "startSearch"; backwards: boolean }
  | { type: "searchUnderCursor"; backwards: boolean }
  | { type: "motion"; motion: Motion }
  | { type: "lineOperation" }
  | { type: "pushEditOperator"; operator: Operator; key: string }
  | { type: "pushObject"; around: boolean; key: string }
  | { type: "pushIndent"; direction: IndentDirection; key: string }
  | { type: "pushRegister" }
  | { type: "pushCount"; key: string }
  | { type: "normalCommand"; command: NormalCommand }
  | { type: "visualCommand"; command: VisualCommand };

export type VimKeymapPhase = "motionMode" | "normalFallback";

// Zed: the key context from `vim::Vim::extend_key_context` (`vim_mode`,
// `vim_operator`). Binding conditions are written against this vocabulary
// instead of pre-combined booleans.
export type VimKeymapContext = {
  mode: VimMode["kind"];
  /** Operator-stack summary: "none" when empty, the range operator awaiting a
      motion/object ("delete"/"change"/"yank"/"convert"/"indent"), "object"
      when a text-object selector owns the next key, "other" for any other
      pending operator input. */
  operator: OperatorContext;
  /** The pending range operator's final key (`d`, `u` for `gu`, `>`, ...).
      Repeating it is the one doubling rule: `dd`/`yy`/`guu`/`>>` all resolve
      to a whole-line operation (Zed: `vim::CurrentLine` bindings under the
      per-operator `vim_operator` contexts). */
  operatorPendingKey: string | undefined;
  hasSelectedRegister: boolean;
  countText: string;
  repeatIsReplaying: boolean;
};

/** Nothing is pending at all: no operator input and no selected register. */
function nothingPending(context: VimKeymapContext): boolean {
  return context.operator === "none" && !context.hasSelectedRegister;
}

export type FiniteKeymapScope = "shared" | "normal";

export type FiniteKeymapResolution =
  | { kind: "pending"; chord: string; scope: FiniteKeymapScope }
  | { kind: "action"; action: VimAction; scope: FiniteKeymapScope }
  | { kind: "cancelled"; scope: FiniteKeymapScope }
  | { kind: "noMatch" };

type ScopedBinding = { scope: FiniteKeymapScope; action: VimAction };

const finiteBindings = bindingMap([
  sharedBinding("g g", move({ type: "startOfDocument" })),
  sharedBinding("g j", move({ type: "down", displayLine: true })),
  sharedBinding("g k", move({ type: "up", displayLine: true })),
  sharedBinding("g _", move({ type: "lastNonWhitespace" })),
  sharedBinding("g M", move({ type: "middleOfLine" })),
  sharedBinding("g e", move({ type: "previousWordEnd", bigWord: false })),
  sharedBinding("g E", move({ type: "previousWordEnd", bigWord: true })),
  sharedBinding("g v", { type: "restoreVisualSelection" }),
  sharedBinding("g i", { type: "insertAtPrevious" }),
  sharedBinding("g u", pushConvert("lower")),
  sharedBinding("g U", pushConvert("upper")),
  sharedBinding("g ~", pushConvert("toggle")),
  sharedBinding("g ?", pushConvert("rot13")),
  sharedBinding("g J", join({ insertWhitespace: false })),
  sharedBinding("g ;", { type: "changeList", direction: "older" }),
  sharedBinding("g ,", { type: "changeList", direction: "newer" }),
  sharedBinding("g n", { type: "searchSelection", reversed: false }),
  sharedBinding("g N", { type: "searchSelection", reversed: true }),
  sharedBinding("J", join({ insertWhitespace: true })),
  sharedBinding("ctrl-a", incrementStep("increment", { cumulative: false })),
  sharedBinding("ctrl-x", incrementStep("decrement", { cumulative: false })),
  sharedBinding("g ctrl-a", incrementStep("increment", { cumulative: true })),
  sharedBinding("g ctrl-x", incrementStep("decrement", { cumulative: true })),
  sharedBinding("ctrl-n", multiCursor("editor.action.addSelectionToNextFindMatch")),
  sharedBinding("g l", multiCursor("editor.action.addSelectionToNextFindMatch")),
  sharedBinding("g L", multiCursor("editor.action.addSelectionToPreviousFindMatch")),
  sharedBinding("g >", multiCursor("editor.action.moveSelectionToNextFindMatch")),
  sharedBinding("g <", multiCursor("editor.action.moveSelectionToPreviousFindMatch")),
  sharedBinding("g a", multiCursor("editor.action.selectHighlights")),
  sharedBinding("ctrl-d", page({ direction: "down", halfPage: true })),
  sharedBinding("ctrl-u", page({ direction: "up", halfPage: true })),
  sharedBinding("ctrl-f", page({ direction: "down", halfPage: false })),
  sharedBinding("ctrl-b", page({ direction: "up", halfPage: false })),
  sharedBinding("K", native("editor.action.showHover")),
  sharedBinding("g h", native("editor.action.showHover")),
  sharedBinding("g d", native("editor.action.revealDefinition")),
  sharedBinding("g D", native("editor.action.goToDeclaration")),
  sharedBinding("g y", native("editor.action.goToTypeDefinition")),
  sharedBinding("g I", native("editor.action.goToImplementation")),
  sharedBinding("g r r", native("editor.action.referenceSearch.trigger")),
  sharedBinding("g r n", native("editor.action.rename")),
  sharedBinding("g r a", native("editor.action.quickFix")),
  sharedBinding("g ]", native("editor.action.marker.next")),
  sharedBinding("g [", native("editor.action.marker.prev")),
  sharedBinding("g x", native("editor.action.openLink")),

  normalBinding("] }", move({ type: "unmatchedForward", char: "}" })),
  normalBinding("] )", move({ type: "unmatchedForward", char: ")" })),
  normalBinding("[ {", move({ type: "unmatchedBackward", char: "{" })),
  normalBinding("[ (", move({ type: "unmatchedBackward", char: "(" })),
  normalBinding("] space", { type: "insertEmptyLines", side: "below" }),
  normalBinding("[ space", { type: "insertEmptyLines", side: "above" }),
  normalBinding("ctrl-o", hostCommand("navigateBack")),
  normalBinding("ctrl-i", hostCommand("navigateForward")),
  normalBinding("u", hostCommand("undo")),
  normalBinding("ctrl-r", hostCommand("redo")),
  normalBinding("ctrl-y", scrollLines("up")),
  normalBinding("ctrl-e", scrollLines("down")),
  normalBinding("z z", revealCurrentLine("center")),
  normalBinding("z t", revealCurrentLine("top")),
  normalBinding("z b", revealCurrentLine("bottom")),
  normalBinding("z a", fold("toggle")),
  normalBinding("z o", fold("open")),
  normalBinding("z c", fold("close")),
  normalBinding("z O", fold("openRecursive")),
  normalBinding("z C", fold("closeRecursive")),
  normalBinding("z R", fold("openAll")),
  normalBinding("z M", fold("closeAll")),
]);

type Binding = readonly [string, ScopedBinding];

function bindingMap(bindings: readonly Binding[]): ReadonlyMap<string, ScopedBinding> {
  return new Map(bindings);
}

function sharedBinding(key: string, action: VimAction): Binding {
  return [key, { scope: "shared", action }];
}

function normalBinding(key: string, action: VimAction): Binding {
  return [key, { scope: "normal", action }];
}

function move(motion: Motion): VimAction {
  return { type: "motion", motion };
}

function pushConvert(target: ConvertTarget): VimAction {
  return { type: "pushConvert", target };
}

function join({ insertWhitespace }: { insertWhitespace: boolean }): VimAction {
  return { type: "join", insertWhitespace };
}

function incrementStep(direction: "increment" | "decrement", { cumulative }: { cumulative: boolean }): VimAction {
  return { type: "incrementStep", direction, cumulative };
}

function multiCursor(command: string): VimAction {
  return { type: "multiCursor", command };
}

function page({ direction, halfPage }: { direction: HostDirection; halfPage: boolean }): VimAction {
  return { type: "page", direction, halfPage };
}

function native(command: string): VimAction {
  return { type: "native", command };
}

function hostCommand(command: HostCommand): VimAction {
  return { type: "hostCommand", command };
}

function scrollLines(direction: HostDirection): VimAction {
  return { type: "scrollLines", direction };
}

function revealCurrentLine(target: HostRevealTarget): VimAction {
  return { type: "revealCurrentLine", target };
}

function fold(command: HostFoldCommand): VimAction {
  return { type: "fold", command };
}

const prefixesByScope: ReadonlyMap<FiniteKeymapScope, ReadonlySet<string>> = (() => {
  const prefixes = {
    shared: new Set<string>(),
    normal: new Set<string>(),
  };
  for (const [chord, { scope }] of finiteBindings) {
    const keys = chord.split(" ");
    for (let length = 1; length < keys.length; length++) {
      prefixes[scope].add(keys.slice(0, length).join(" "));
    }
  }
  return new Map([
    ["shared", prefixes.shared],
    ["normal", prefixes.normal],
  ]);
})();

export class VimKeymapResolver {
  private pendingKeys: string[] = [];
  private pendingScope: FiniteKeymapScope | undefined;

  isPending(): boolean {
    return this.pendingKeys.length > 0;
  }

  pendingChord(): string {
    return this.pendingKeys.join(" ");
  }

  clearPending(): void {
    this.pendingKeys = [];
    this.pendingScope = undefined;
  }

  handleKey(
    key: string,
    { allowShared, allowNormal }: { allowShared: boolean; allowNormal: boolean }
  ): FiniteKeymapResolution {
    const scopes = this.pendingScope !== undefined
      ? [this.pendingScope]
      : allowedScopes({ allowShared, allowNormal });
    if (scopes.length === 0) return { kind: "noMatch" };

    const keys = [...this.pendingKeys, key];
    const chord = keys.join(" ");
    const binding = finiteBindings.get(chord);
    if (binding !== undefined && scopes.includes(binding.scope)) {
      this.clearPending();
      return { kind: "action", action: binding.action, scope: binding.scope };
    }

    const prefixScope = scopes.find(scope => prefixesByScope.get(scope)?.has(chord));
    if (prefixScope !== undefined) {
      this.pendingKeys = keys;
      this.pendingScope = prefixScope;
      return { kind: "pending", chord, scope: prefixScope };
    }

    const pendingScope = this.pendingScope;
    this.clearPending();
    return pendingScope !== undefined ? { kind: "cancelled", scope: pendingScope } : { kind: "noMatch" };
  }
}

function allowedScopes({ allowShared, allowNormal }: { allowShared: boolean; allowNormal: boolean }): FiniteKeymapScope[] {
  const scopes: FiniteKeymapScope[] = [];
  if (allowShared) scopes.push("shared");
  if (allowNormal) scopes.push("normal");
  return scopes;
}

export function resolveVimAction(
  key: string,
  phase: VimKeymapPhase,
  context: VimKeymapContext
): VimAction | undefined {
  // The one doubling rule: `dd`/`cc`/`yy`/`guu`/`gUU`/`g~~`/`g??`/`>>`/`<<`/
  // `==`/`yss`. Checked ahead of every phase because a doubling key can shadow
  // a motion-mode key (`?` would otherwise start a backward search); Zed gives
  // the per-operator `vim_operator` contexts the same precedence.
  if (context.operatorPendingKey !== undefined && key === context.operatorPendingKey) {
    return { type: "lineOperation" };
  }
  switch (phase) {
    case "motionMode":
      return resolveMotionModeAction(key);
    case "normalFallback":
      return resolveNormalFallbackAction(key, context);
  }
}

function resolveMotionModeAction(key: string): VimAction | undefined {
  switch (key) {
    case "n":
      return { type: "repeatSearch", reversed: false };
    case "N":
      return { type: "repeatSearch", reversed: true };
    case ";":
      return { type: "repeatFind", reversed: false };
    case ",":
      return { type: "repeatFind", reversed: true };
    case "f":
      return { type: "pushFindForward", before: false };
    case "t":
      return { type: "pushFindForward", before: true };
    case "F":
      return { type: "pushFindBackward", after: false };
    case "T":
      return { type: "pushFindBackward", after: true };
    case "/":
      return { type: "startSearch", backwards: false };
    case "?":
      return { type: "startSearch", backwards: true };
    case "*":
      return { type: "searchUnderCursor", backwards: false };
    case "#":
      return { type: "searchUnderCursor", backwards: true };
    default:
      return motionActionForKey(key);
  }
}

function motionActionForKey(key: string): VimAction | undefined {
  if (key === "0" || key === "%") return undefined;
  const motion = motionForKey(key);
  return motion === undefined ? undefined : { type: "motion", motion };
}

function indentDirectionForKey(key: string): IndentDirection | undefined {
  switch (key) {
    case ">":
      return "in";
    case "<":
      return "out";
    case "=":
      return "auto";
    default:
      return undefined;
  }
}

function editOperatorForKey(key: string): Operator | undefined {
  switch (key) {
    case "d":
      return "delete";
    case "c":
      return "change";
    case "y":
      return "yank";
    default:
      return undefined;
  }
}

function isCountKey(key: string, countText: string): boolean {
  return /^\d$/.test(key) && (key !== "0" || countText.length > 0);
}

function visualCommandForKey(key: string): VisualCommand | undefined {
  switch (key) {
    case "I":
      return { type: "insertAtSelection", side: "start" };
    case "A":
      return { type: "insertAtSelection", side: "end" };
    case "S":
      return { type: "startSurround" };
    case ">":
    case "<":
    case "=":
      return { type: "indent", key };
    case "u":
    case "U":
    case "~":
      return { type: "convert", key };
    case "i":
      return { type: "startTextObject", around: false };
    case "a":
      return { type: "startTextObject", around: true };
    case "o":
      return { type: "otherEnd", rowAware: true };
    case "O":
      return { type: "otherEnd", rowAware: false };
    case "Y":
      return { type: "yankLinewise" };
    case "y":
      return { type: "yank" };
    case "D":
      return { type: "deleteToLineEnd" };
    case "d":
    case "x":
      return { type: "delete" };
    case "c":
    case "s":
      return { type: "change" };
    case "p":
    case "P":
      return { type: "paste" };
    case "%":
      return { type: "percentOrMatching" };
    default:
      return undefined;
  }
}

function normalCommandForKey(key: string): NormalCommand | undefined {
  switch (key) {
    case "i":
      return { type: "insertBefore" };
    case "a":
      return { type: "insertAfter" };
    case "I":
      return { type: "insertFirstNonWhitespace" };
    case "A":
      return { type: "insertEndOfLine" };
    case "o":
      return { type: "openLine", above: false };
    case "O":
      return { type: "openLine", above: true };
    case "r":
      return { type: "pushReplace" };
    case "s":
      return { type: "substituteCharacters" };
    case "S":
      return { type: "substituteLines" };
    case "C":
      return { type: "changeToEndOfLine" };
    case "D":
      return { type: "deleteToEndOfLine" };
    case "X":
      return { type: "deleteLeft" };
    case "x":
    case "delete":
      return { type: "deleteRight" };
    case "~":
      return { type: "toggleCase" };
    case "p":
      return { type: "paste", before: false };
    case "P":
      return { type: "paste", before: true };
    case "+":
      return { type: "moveLineFirstNonWhitespace", direction: "down" };
    case "-":
      return { type: "moveLineFirstNonWhitespace", direction: "up" };
    case "%":
      return { type: "percentOrMatching" };
    case "G":
      return { type: "goToLineOrEnd" };
    case "enter":
      return { type: "moveToNextLineStart" };
    default:
      return undefined;
  }
}

function normalCommandIsAllowed(command: NormalCommand, context: VimKeymapContext): boolean {
  switch (command.type) {
    case "percentOrMatching":
    case "goToLineOrEnd":
    case "moveToNextLineStart":
      // Motion-like commands also serve as operator targets (`dG`, `d%`).
      return context.operator !== "object";
    default:
      return context.operator === "none";
  }
}

function resolveNormalFallbackAction(key: string, context: VimKeymapContext): VimAction | undefined {
  if (isVisualModeKind(context.mode)) {
    if (context.operator !== "none") return undefined;
    if (isCountKey(key, context.countText)) return { type: "pushCount", key };
    if (key === "0") return { type: "motion", motion: { type: "startOfLine" } };
    if (key === "G") return { type: "motion", motion: { type: "endOfDocument" } };
    if (key === "\"") return { type: "pushRegister" };
    const visualMode = visualModeForKey(key);
    if (visualMode !== undefined) return { type: "toggleVisual", mode: visualMode };
    const command = visualCommandForKey(key);
    return command === undefined ? undefined : { type: "visualCommand", command };
  }

  if (context.mode !== "normal") return undefined;

  const idle = context.operator === "none" && context.countText.length === 0;

  if (idle && key === "m") return { type: "pushMark" };

  // Jumps are plain motions when idle and motion targets for a pending range
  // operator (`d'a`). A pending text object owns the quote/backtick key
  // instead (`di'`, `da\``).
  if ((idle || isRangeOperatorContext(context.operator)) && (key === "'" || key === "`")) {
    return { type: "pushJump", line: key === "'" };
  }

  if (key === "." && !context.repeatIsReplaying) {
    return context.operator === "none"
      ? { type: "repeatLastChange" }
      : { type: "cancelRepeat" };
  }

  if (isCountKey(key, context.countText) && context.operator !== "object") {
    return { type: "pushCount", key };
  }

  if (key === "0") return { type: "motion", motion: { type: "startOfLine" } };

  if (nothingPending(context) && key === ":") return { type: "startCommand" };
  if (nothingPending(context) && key === "\"") return { type: "pushRegister" };

  const operator = editOperatorForKey(key);
  if (operator !== undefined && context.operator === "none") {
    return { type: "pushEditOperator", operator, key };
  }

  if (isRangeOperatorContext(context.operator) && (key === "i" || key === "a")) {
    return { type: "pushObject", around: key === "a", key };
  }

  const indentDirection = indentDirectionForKey(key);
  if (indentDirection !== undefined && nothingPending(context)) {
    return { type: "pushIndent", direction: indentDirection, key };
  }

  const command = normalCommandForKey(key);
  if (command !== undefined && normalCommandIsAllowed(command, context)) {
    return { type: "normalCommand", command };
  }

  // Vim `o_v`/`o_V`: with a pending operator, `v`/`V` force the motion
  // charwise/linewise instead of entering visual mode.
  if (isRangeOperatorContext(context.operator)) {
    if (key === "v") return { type: "forceMotion", force: "charwise" };
    if (key === "V") return { type: "forceMotion", force: "linewise" };
    return undefined;
  }

  const visualMode = visualModeForKey(key);
  if (visualMode !== undefined) return { type: "toggleVisual", mode: visualMode };

  return key === "R" ? { type: "enterReplace" } : undefined;
}

function visualModeForKey(key: string): VisualModeKind | undefined {
  switch (key) {
    case "v":
      return "visual";
    case "V":
      return "visualLine";
    case "ctrl-v":
      return "visualBlock";
    default:
      return undefined;
  }
}
