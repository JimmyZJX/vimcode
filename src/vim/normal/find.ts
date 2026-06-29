// Zed reference:
// - source: crates/vim/src/motion.rs (the `f`/`t`/`F`/`T` find motions and the
//   `;`/`,` repeats that re-run the last find)
// - translated concepts: the per-buffer "last find motion" state, stored so `;`
//   repeats it and `,` repeats it reversed.

import { FindMotion, reverseFindMotion } from "../motion.js";

// The last `f`/`t`/`F`/`T` find, remembered so `;`/`,` can repeat it. Injected
// into the pure grammar like the editor/registers/marks capabilities.
export class FindState {
  private lastFind: FindMotion | undefined;

  record(motion: FindMotion): void {
    this.lastFind = motion;
  }

  // The motion `;` (reversed = false) or `,` (reversed = true) should apply, or
  // undefined when no find has run yet.
  repeat(reversed: boolean): FindMotion | undefined {
    if (this.lastFind === undefined) return undefined;
    return reversed ? reverseFindMotion(this.lastFind) : this.lastFind;
  }
}
