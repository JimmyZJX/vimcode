// Zed reference:
// - source: crates/vim/src/motion.rs and assets/keymaps/vim.json
// - translated concepts: key-to-motion parsing as a typed handler that returns
//   semantic Motion values instead of editing the editor directly.

import { Handler, unhandled, value } from "./key_handler.js";
import { Motion, motionForKey } from "./motion.js";

export function motionHandler(): Handler<Motion> {
  return (key, state) => {
    const motion = motionForKey(key);
    if (motion === undefined) return unhandled();
    return value(state.mode, motion);
  };
}
