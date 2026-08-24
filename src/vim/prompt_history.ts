// Vim `cmdline-history` for the mini prompts: the `/`?` search prompt and the
// `:` command line each keep a global history, navigated from inside the
// prompt. Semantics pinned by the Neovim-recorded test_search_history /
// test_command_history fixtures:
// - `<Up>`/`<Down>` recall older/newer entries whose beginning matches the
//   text typed before navigation started; `<C-p>`/`<C-n>` ignore the prefix.
// - Stepping newer past the most recent entry restores the typed text.
// - Accepted *and* aborted prompts are added; duplicates move to most recent.
// - Editing the recalled text ends the navigation session (the next `<Up>`
//   matches against the edited text).

// One prompt session's navigation state, created on the first history key and
// dropped on any edit.
export type HistoryNavigation = {
  // The text typed before navigation began: the arrow keys match it as a
  // prefix, and stepping past the newest entry restores it.
  prefix: string;
  // Index of the recalled entry, or undefined when at the "current" (typed,
  // not yet recalled) position.
  index: number | undefined;
};

export type HistoryStep = { direction: "older" | "newer"; matchPrefix: boolean };

// The prompt keys that navigate history (Vim `c_<Up>`/`c_<Down>` with prefix
// matching, `c_CTRL-P`/`c_CTRL-N` without).
export function historyNavigationKey(key: string): HistoryStep | undefined {
  switch (key) {
    case "up":
      return { direction: "older", matchPrefix: true };
    case "down":
      return { direction: "newer", matchPrefix: true };
    case "ctrl-p":
      return { direction: "older", matchPrefix: false };
    case "ctrl-n":
      return { direction: "newer", matchPrefix: false };
    default:
      return undefined;
  }
}

export class PromptHistory {
  // Oldest first, most recent last.
  private entries: string[] = [];

  add(entry: string): void {
    if (entry.length === 0) return;
    const existing = this.entries.indexOf(entry);
    if (existing !== -1) this.entries.splice(existing, 1);
    this.entries.push(entry);
  }

  // Step [nav] through the history. Returns the recalled entry (or the
  // restored typed text when stepping newer past the most recent entry), or
  // undefined when there is nothing further in that direction (Vim beeps and
  // the prompt stays).
  navigate(nav: HistoryNavigation, { direction, matchPrefix }: HistoryStep): string | undefined {
    const filter = matchPrefix ? nav.prefix : "";
    if (direction === "older") {
      for (let index = (nav.index ?? this.entries.length) - 1; index >= 0; index--) {
        if (this.entries[index].startsWith(filter)) {
          nav.index = index;
          return this.entries[index];
        }
      }
      return undefined;
    }
    if (nav.index === undefined) return undefined;
    for (let index = nav.index + 1; index < this.entries.length; index++) {
      if (this.entries[index].startsWith(filter)) {
        nav.index = index;
        return this.entries[index];
      }
    }
    // Past the newest entry: back to the typed text.
    nav.index = undefined;
    return nav.prefix;
  }
}
