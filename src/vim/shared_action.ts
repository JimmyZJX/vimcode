// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: assets/keymaps/vim.json dispatching to `motion::Motion` and `normal::scroll` actions
// - translated concepts: key actions that are shared across normal and visual modes
// - intentional differences: this is a tiny resolver until the local keymap becomes fully data-driven.

export type SharedAction =
  | { type: "motion"; key: "gg" | "gj" | "gk" }
  | { type: "page"; key: "ctrl-d" | "ctrl-u" | "ctrl-f" | "ctrl-b" }
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
