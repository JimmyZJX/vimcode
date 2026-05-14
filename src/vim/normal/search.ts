// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - source: crates/vim/src/normal/search.rs
// - translated concepts: pending `/` / `?` query state and repeated search motions
// - intentional differences: this first slice stores plain string queries and delegates
//   matching to model-buffer `Motion.search*` helpers instead of VSCode/Zed search UI.

import { Motion } from "../motion.js";
import { Registers } from "../registers.js";

export type PendingSearch = { backwards: boolean; query: string };

export class SearchState {
  private pending: PendingSearch | undefined;
  private last: { query: string; backwards: boolean } | undefined;

  isPending(): boolean {
    return this.pending !== undefined;
  }

  pendingChord(): string {
    return this.pending === undefined ? "" : `${this.pending.backwards ? "?" : "/"}${this.pending.query}`;
  }

  start(backwards: boolean): void {
    this.pending = { backwards, query: "" };
  }

  clearPending(): void {
    this.pending = undefined;
  }

  handleKey(key: string, registers: Registers): Motion | undefined {
    const pending = this.pending;
    if (pending === undefined) return undefined;
    if (key === "enter") {
      const query = pending.query.length > 0 ? pending.query : this.last?.query;
      const backwards = pending.query.length > 0 ? pending.backwards : this.last?.backwards ?? pending.backwards;
      this.pending = undefined;
      if (query !== undefined && query.length > 0) {
        this.last = { query, backwards };
        registers.writeSearch(query);
        return { type: backwards ? "searchBackward" : "searchForward", query };
      }
      return undefined;
    }
    if (key === "backspace") {
      this.pending = { ...pending, query: pending.query.slice(0, -1) };
      return undefined;
    }
    this.pending = { ...pending, query: pending.query + (key === "space" ? " " : key) };
    return undefined;
  }

  repeat({ reversed }: { reversed: boolean }): Motion | undefined {
    if (this.last === undefined) return undefined;
    const backwards = reversed ? !this.last.backwards : this.last.backwards;
    return { type: backwards ? "searchBackward" : "searchForward", query: this.last.query };
  }
}
