// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: assets/keymaps/vim.json dispatching to `motion::Motion` and `normal::scroll` actions
// - translated concepts: key actions that are shared across normal and visual modes
// - intentional differences: this is a tiny resolver until the local keymap becomes fully data-driven.

export type SharedAction =
  | { type: "motion"; key: "gg" | "gj" | "gk" | "g_" | "ge" | "gE" }
  | { type: "normalGKey"; key: "u" | "U" | "~" | "J" }
  | { type: "changeList"; direction: "older" | "newer" }
  | { type: "insertAtPrevious" }
  | { type: "page"; key: "ctrl-d" | "ctrl-u" | "ctrl-f" | "ctrl-b" }
  | { type: "restoreVisualSelection" }
  | { type: "searchSelection"; reversed: boolean }
  | { type: "multiCursor"; command: string }
  | { type: "native"; command: string };

export type SharedActionResolution =
  | { kind: "pending"; chord: string }
  | { kind: "action"; action: SharedAction }
  | { kind: "cancelled" }
  | { kind: "noMatch" };

const bindings: ReadonlyMap<string, SharedAction> = new Map([
  ["g g", { type: "motion", key: "gg" }],
  ["g j", { type: "motion", key: "gj" }],
  ["g k", { type: "motion", key: "gk" }],
  ["g _", { type: "motion", key: "g_" }],
  ["g e", { type: "motion", key: "ge" }],
  ["g E", { type: "motion", key: "gE" }],
  ["g v", { type: "restoreVisualSelection" }],
  ["g i", { type: "insertAtPrevious" }],
  ["g u", { type: "normalGKey", key: "u" }],
  ["g U", { type: "normalGKey", key: "U" }],
  ["g ~", { type: "normalGKey", key: "~" }],
  ["g J", { type: "normalGKey", key: "J" }],
  ["g ;", { type: "changeList", direction: "older" }],
  ["g ,", { type: "changeList", direction: "newer" }],
  ["g n", { type: "searchSelection", reversed: false }],
  ["g N", { type: "searchSelection", reversed: true }],
  // `ctrl-n` is a VSCodeVim-style alias for VSCode's native Ctrl+D action.
  ["ctrl-n", { type: "multiCursor", command: "editor.action.addSelectionToNextFindMatch" }],
  // Zed: assets/keymaps/vim.json binds these to `vim::SelectNext`,
  // `vim::SelectPrevious`, editor select-next/previous with `replace_newest`,
  // and `editor::SelectAllMatches`. In VSCode, the native multicursor
  // controller already implements the same selection sessions, so the first
  // slice delegates to those editor actions.
  ["g l", { type: "multiCursor", command: "editor.action.addSelectionToNextFindMatch" }],
  ["g L", { type: "multiCursor", command: "editor.action.addSelectionToPreviousFindMatch" }],
  ["g >", { type: "multiCursor", command: "editor.action.moveSelectionToNextFindMatch" }],
  ["g <", { type: "multiCursor", command: "editor.action.moveSelectionToPreviousFindMatch" }],
  ["g a", { type: "multiCursor", command: "editor.action.selectHighlights" }],
  ["ctrl-d", { type: "page", key: "ctrl-d" }],
  ["ctrl-u", { type: "page", key: "ctrl-u" }],
  ["ctrl-f", { type: "page", key: "ctrl-f" }],
  ["ctrl-b", { type: "page", key: "ctrl-b" }],
  ["K", { type: "native", command: "editor.action.showHover" }],
  ["g d", { type: "native", command: "editor.action.revealDefinition" }],
  ["g D", { type: "native", command: "editor.action.goToDeclaration" }],
  ["g y", { type: "native", command: "editor.action.goToTypeDefinition" }],
  ["g I", { type: "native", command: "editor.action.goToImplementation" }],
  ["g r r", { type: "native", command: "editor.action.referenceSearch.trigger" }],
  ["g r n", { type: "native", command: "editor.action.rename" }],
  ["g r a", { type: "native", command: "editor.action.quickFix" }],
  ["g ]", { type: "native", command: "editor.action.marker.next" }],
  ["g [", { type: "native", command: "editor.action.marker.prev" }],
  ["g x", { type: "native", command: "editor.action.openLink" }],
]);

const prefixes = new Set<string>();
for (const chord of bindings.keys()) {
  const keys = chord.split(" ");
  for (let length = 1; length < keys.length; length++) {
    prefixes.add(keys.slice(0, length).join(" "));
  }
}

export class SharedActionResolver {
  private pendingKeys: string[] = [];

  isPending(): boolean {
    return this.pendingKeys.length > 0;
  }

  pendingChord(): string {
    return this.pendingKeys.join(" ");
  }

  clearPending(): void {
    this.pendingKeys = [];
  }

  handleKey(key: string): SharedActionResolution {
    const keys = [...this.pendingKeys, key];
    const chord = keys.join(" ");
    const action = bindings.get(chord);
    if (action !== undefined) {
      this.pendingKeys = [];
      return { kind: "action", action };
    }

    if (prefixes.has(chord)) {
      this.pendingKeys = keys;
      return { kind: "pending", chord };
    }

    const hadPending = this.pendingKeys.length > 0;
    this.pendingKeys = [];
    return hadPending ? { kind: "cancelled" } : { kind: "noMatch" };
  }
}
