// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: assets/keymaps/vim.json, vim::Vim::action, vim::Vim::push_operator
// - translated concepts: resolve keys into Vim actions before executing them against
//   the central Vim state.
// - intentional differences: this is an incremental spine for the VSCode adapter. The
//   existing NormalMode/VisualMode key parsers remain as fallback until their behavior
//   is migrated into action dispatch.

import type { HostCommand, HostDirection, HostFoldCommand, HostRevealTarget } from "./editor.js";
import { Motion, motionForKey } from "./motion.js";
import type { ConvertTarget } from "./normal/convert.js";
import type { IndentDirection } from "./normal/indent.js";
import type { Operator, VimMode } from "./state.js";

export type VisualModeTarget =
  | { mode: "visual"; kind: "charwise" }
  | { mode: "visualLine"; kind: "linewise" }
  | { mode: "visualBlock"; kind: "blockwise" };

export type VisualCommand =
  | { type: "toggleCharwise" }
  | { type: "toggleLinewise" }
  | { type: "toggleBlockwise" }
  | { type: "insertAtSelection"; side: "start" | "end" }
  | { type: "startSurround" }
  | { type: "join"; insertWhitespace: boolean }
  | { type: "indent"; key: ">" | "<" | "=" }
  | { type: "incrementStep"; direction: "increment" | "decrement" }
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
  | { type: "join"; insertWhitespace: boolean }
  | { type: "incrementStep"; direction: "increment" | "decrement" }
  | { type: "toggleCase" }
  | { type: "paste"; before: boolean }
  | { type: "moveLineFirstNonWhitespace"; direction: "up" | "down" }
  | { type: "percentOrMatching" }
  | { type: "goToLineOrEnd" }
  | { type: "moveToNextLineStart" }
  | { type: "moveWrappingLeft" };

export type VimAction =
  | { type: "pushMark" }
  | { type: "pushJump"; line: boolean }
  | { type: "pushUnmatched"; direction: "forward" | "backward" }
  | { type: "repeatLastChange" }
  | { type: "cancelRepeat" }
  | { type: "startCommand" }
  | { type: "enterVisual"; target: VisualModeTarget }
  | { type: "enterReplace" }
  | { type: "changeList"; direction: "older" | "newer" }
  | { type: "insertAtPrevious" }
  | { type: "page"; direction: HostDirection; halfPage: boolean }
  | { type: "restoreVisualSelection" }
  | { type: "searchSelection"; reversed: boolean }
  | { type: "pushConvert"; target: ConvertTarget }
  | { type: "join"; insertWhitespace: boolean }
  | { type: "incrementStep"; direction: "increment" | "decrement" }
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
  | { type: "pushEditOperator"; operator: Operator; key: string }
  | { type: "pushObject"; around: boolean; key: string }
  | { type: "pushIndent"; direction: IndentDirection; key: string }
  | { type: "pushRegister" }
  | { type: "pushCount"; key: string }
  | { type: "normalCommand"; command: NormalCommand }
  | { type: "visualCommand"; command: VisualCommand };

export type VimKeymapPhase = "motionMode" | "beforeRepeat" | "normalFallback";

export type VimKeymapContext = {
  mode: VimMode["kind"];
  normalModeIsPending: boolean;
  normalModeHasPendingOperator: boolean;
  normalModeHasPendingNonCount: boolean;
  normalModeHasOnlySelectedRegisterPending: boolean;
  normalModeCanResolveEditOperator: boolean;
  visualModeHasPendingNonCount: boolean;
  countText: string;
  repeatIsReplaying: boolean;
};

export type FiniteKeymapScope = "shared" | "normal";

export type FiniteKeymapResolution =
  | { kind: "pending"; chord: string; scope: FiniteKeymapScope }
  | { kind: "action"; action: VimAction; scope: FiniteKeymapScope }
  | { kind: "cancelled"; scope: FiniteKeymapScope }
  | { kind: "noMatch" };

type ScopedBinding = { scope: FiniteKeymapScope; action: VimAction };

const finiteBindings: ReadonlyMap<string, ScopedBinding> = new Map([
  ["g g", shared({ type: "motion", motion: { type: "startOfDocument" } })],
  ["g j", shared({ type: "motion", motion: { type: "down", displayLine: true } })],
  ["g k", shared({ type: "motion", motion: { type: "up", displayLine: true } })],
  ["g _", shared({ type: "motion", motion: { type: "lastNonWhitespace" } })],
  ["g e", shared({ type: "motion", motion: { type: "previousWordEnd", bigWord: false } })],
  ["g E", shared({ type: "motion", motion: { type: "previousWordEnd", bigWord: true } })],
  ["g v", shared({ type: "restoreVisualSelection" })],
  ["g i", shared({ type: "insertAtPrevious" })],
  ["g u", shared({ type: "pushConvert", target: "lower" })],
  ["g U", shared({ type: "pushConvert", target: "upper" })],
  ["g ~", shared({ type: "pushConvert", target: "toggle" })],
  ["g J", shared({ type: "join", insertWhitespace: false })],
  ["g ;", shared({ type: "changeList", direction: "older" })],
  ["g ,", shared({ type: "changeList", direction: "newer" })],
  ["g n", shared({ type: "searchSelection", reversed: false })],
  ["g N", shared({ type: "searchSelection", reversed: true })],
  ["g ctrl-a", shared({ type: "incrementStep", direction: "increment" })],
  ["g ctrl-x", shared({ type: "incrementStep", direction: "decrement" })],
  ["ctrl-n", shared({ type: "multiCursor", command: "editor.action.addSelectionToNextFindMatch" })],
  ["g l", shared({ type: "multiCursor", command: "editor.action.addSelectionToNextFindMatch" })],
  ["g L", shared({ type: "multiCursor", command: "editor.action.addSelectionToPreviousFindMatch" })],
  ["g >", shared({ type: "multiCursor", command: "editor.action.moveSelectionToNextFindMatch" })],
  ["g <", shared({ type: "multiCursor", command: "editor.action.moveSelectionToPreviousFindMatch" })],
  ["g a", shared({ type: "multiCursor", command: "editor.action.selectHighlights" })],
  ["ctrl-d", shared({ type: "page", direction: "down", halfPage: true })],
  ["ctrl-u", shared({ type: "page", direction: "up", halfPage: true })],
  ["ctrl-f", shared({ type: "page", direction: "down", halfPage: false })],
  ["ctrl-b", shared({ type: "page", direction: "up", halfPage: false })],
  ["K", shared({ type: "native", command: "editor.action.showHover" })],
  ["g h", shared({ type: "native", command: "editor.action.showHover" })],
  ["g d", shared({ type: "native", command: "editor.action.revealDefinition" })],
  ["g D", shared({ type: "native", command: "editor.action.goToDeclaration" })],
  ["g y", shared({ type: "native", command: "editor.action.goToTypeDefinition" })],
  ["g I", shared({ type: "native", command: "editor.action.goToImplementation" })],
  ["g r r", shared({ type: "native", command: "editor.action.referenceSearch.trigger" })],
  ["g r n", shared({ type: "native", command: "editor.action.rename" })],
  ["g r a", shared({ type: "native", command: "editor.action.quickFix" })],
  ["g ]", shared({ type: "native", command: "editor.action.marker.next" })],
  ["g [", shared({ type: "native", command: "editor.action.marker.prev" })],
  ["g x", shared({ type: "native", command: "editor.action.openLink" })],

  ["ctrl-o", normal({ type: "hostCommand", command: "navigateBack" })],
  ["ctrl-i", normal({ type: "hostCommand", command: "navigateForward" })],
  ["u", normal({ type: "hostCommand", command: "undo" })],
  ["ctrl-r", normal({ type: "hostCommand", command: "redo" })],
  ["ctrl-y", normal({ type: "scrollLines", direction: "up" })],
  ["ctrl-e", normal({ type: "scrollLines", direction: "down" })],
  ["z z", normal({ type: "revealCurrentLine", target: "center" })],
  ["z t", normal({ type: "revealCurrentLine", target: "top" })],
  ["z b", normal({ type: "revealCurrentLine", target: "bottom" })],
  ["z a", normal({ type: "fold", command: "toggle" })],
  ["z o", normal({ type: "fold", command: "open" })],
  ["z c", normal({ type: "fold", command: "close" })],
  ["z O", normal({ type: "fold", command: "openRecursive" })],
  ["z C", normal({ type: "fold", command: "closeRecursive" })],
  ["z R", normal({ type: "fold", command: "openAll" })],
  ["z M", normal({ type: "fold", command: "closeAll" })],
]);

function shared(action: VimAction): ScopedBinding {
  return { scope: "shared", action };
}

function normal(action: VimAction): ScopedBinding {
  return { scope: "normal", action };
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
  switch (phase) {
    case "motionMode":
      return resolveMotionModeAction(key);
    case "beforeRepeat":
      return resolveBeforeRepeatAction(key, context);
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

function resolveBeforeRepeatAction(key: string, context: VimKeymapContext): VimAction | undefined {
  if (context.mode !== "normal") return undefined;

  if (!context.normalModeIsPending && key === "m") return { type: "pushMark" };

  if ((!context.normalModeIsPending || context.normalModeHasPendingOperator) && (key === "'" || key === "`")) {
    return { type: "pushJump", line: key === "'" };
  }

  if (!context.normalModeHasPendingNonCount) {
    if (key === "]") return { type: "pushUnmatched", direction: "forward" };
    if (key === "[") return { type: "pushUnmatched", direction: "backward" };
  }

  if (key === "." && !context.repeatIsReplaying) {
    return !context.normalModeHasPendingNonCount || context.normalModeHasOnlySelectedRegisterPending
      ? { type: "repeatLastChange" }
      : { type: "cancelRepeat" };
  }

  return undefined;
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
    case "v":
      return { type: "toggleCharwise" };
    case "V":
      return { type: "toggleLinewise" };
    case "ctrl-v":
      return { type: "toggleBlockwise" };
    case "I":
      return { type: "insertAtSelection", side: "start" };
    case "A":
      return { type: "insertAtSelection", side: "end" };
    case "S":
      return { type: "startSurround" };
    case "J":
      return { type: "join", insertWhitespace: true };
    case ">":
    case "<":
    case "=":
      return { type: "indent", key };
    case "ctrl-a":
      return { type: "incrementStep", direction: "increment" };
    case "ctrl-x":
      return { type: "incrementStep", direction: "decrement" };
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
    case "J":
      return { type: "join", insertWhitespace: true };
    case "ctrl-a":
      return { type: "incrementStep", direction: "increment" };
    case "ctrl-x":
      return { type: "incrementStep", direction: "decrement" };
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
    case "backspace":
      return { type: "moveWrappingLeft" };
    default:
      return undefined;
  }
}

function resolveNormalFallbackAction(key: string, context: VimKeymapContext): VimAction | undefined {
  if (context.mode === "visual" || context.mode === "visualLine" || context.mode === "visualBlock") {
    if (context.visualModeHasPendingNonCount) return undefined;
    if (isCountKey(key, context.countText)) return { type: "pushCount", key };
    if (key === "\"") return { type: "pushRegister" };
    const command = visualCommandForKey(key);
    return command === undefined ? undefined : { type: "visualCommand", command };
  }

  if (context.mode !== "normal") return undefined;

  if (isCountKey(key, context.countText)
    && (!context.normalModeHasPendingNonCount
      || context.normalModeCanResolveEditOperator
      || context.normalModeHasOnlySelectedRegisterPending)) {
    return { type: "pushCount", key };
  }

  if (!context.normalModeHasPendingNonCount && key === ":") return { type: "startCommand" };
  if (!context.normalModeHasPendingNonCount && key === "\"") return { type: "pushRegister" };

  const operator = editOperatorForKey(key);
  if (operator !== undefined
    && context.normalModeCanResolveEditOperator
    && (!context.normalModeHasPendingNonCount
      || context.normalModeHasPendingOperator
      || context.normalModeHasOnlySelectedRegisterPending)) {
    return { type: "pushEditOperator", operator, key };
  }

  if (context.normalModeHasPendingOperator
    && context.normalModeCanResolveEditOperator
    && (key === "i" || key === "a")) {
    return { type: "pushObject", around: key === "a", key };
  }

  const indentDirection = indentDirectionForKey(key);
  if (indentDirection !== undefined && !context.normalModeHasPendingNonCount) {
    return { type: "pushIndent", direction: indentDirection, key };
  }

  const command = normalCommandForKey(key);
  if (command !== undefined && (!context.normalModeHasPendingNonCount || context.normalModeHasOnlySelectedRegisterPending)) {
    return { type: "normalCommand", command };
  }

  switch (key) {
    case "v":
      return { type: "enterVisual", target: { mode: "visual", kind: "charwise" } };
    case "V":
      return { type: "enterVisual", target: { mode: "visualLine", kind: "linewise" } };
    case "ctrl-v":
      return { type: "enterVisual", target: { mode: "visualBlock", kind: "blockwise" } };
    case "R":
      return { type: "enterReplace" };
    default:
      return undefined;
  }
}
