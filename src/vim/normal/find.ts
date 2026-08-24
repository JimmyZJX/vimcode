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
    const motion = reversed ? reverseFindMotion(this.lastFind) : this.lastFind;
    if (motion.type === "findForward" || motion.type === "findBackward") {
      // A repeated till must move the cursor even when it already sits next to
      // a match (Vim 'cpo' without ';'); the flag lets motion application skip
      // the adjacent match. Zed models the same by wrapping the stored motion
      // in `RepeatFind`/`RepeatFindReversed`.
      return { ...motion, repeated: true };
    }
    return motion;
  }
}
