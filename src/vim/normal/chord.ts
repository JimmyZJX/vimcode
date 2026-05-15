// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: assets/keymaps/vim.json
// - translated concepts: declarative normal-mode chord resolution for multi-key bindings
// - intentional differences: this is a small local resolver for currently supported
//   normal-mode host chords; Zed's keymap system is workspace-wide and data-driven.

export type NormalChordAction =
  | { type: "host"; key: string }
  | { type: "z"; key: string };

export type NormalChordResolution =
  | { kind: "pending"; chord: string }
  | { kind: "action"; action: NormalChordAction }
  | { kind: "noMatch" };

const bindings: ReadonlyMap<string, NormalChordAction> = new Map([
  ["ctrl-o", { type: "host", key: "ctrl-o" }],
  ["ctrl-i", { type: "host", key: "ctrl-i" }],
  ["u", { type: "host", key: "u" }],
  ["ctrl-r", { type: "host", key: "ctrl-r" }],
  ["ctrl-y", { type: "host", key: "ctrl-y" }],
  ["ctrl-e", { type: "host", key: "ctrl-e" }],
  ["ctrl-u", { type: "host", key: "ctrl-u" }],
  ["ctrl-d", { type: "host", key: "ctrl-d" }],
  ["ctrl-b", { type: "host", key: "ctrl-b" }],
  ["ctrl-f", { type: "host", key: "ctrl-f" }],
  ["z z", { type: "z", key: "z" }],
  ["z t", { type: "z", key: "t" }],
  ["z b", { type: "z", key: "b" }],
  ["z a", { type: "z", key: "a" }],
  ["z o", { type: "z", key: "o" }],
  ["z c", { type: "z", key: "c" }],
  ["z O", { type: "z", key: "O" }],
  ["z C", { type: "z", key: "C" }],
  ["z R", { type: "z", key: "R" }],
  ["z M", { type: "z", key: "M" }],
]);

const prefixes = new Set<string>();
for (const chord of bindings.keys()) {
  const keys = chord.split(" ");
  for (let length = 1; length < keys.length; length++) {
    prefixes.add(keys.slice(0, length).join(" "));
  }
}

export class NormalChordResolver {
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

  handleKey(key: string): NormalChordResolution {
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

    this.pendingKeys = [];
    return { kind: "noMatch" };
  }
}
