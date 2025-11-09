import { comparePos, Editor, Pos, Selection } from "../editorInterface.js";

/**
 * Fixes cursor position to be within valid bounds for the given mode.
 *
 * @param editor - The editor instance
 * @param pos - The position to fix
 * @param options - Configuration options
 * @param options.mode - The mode to fix the cursor for (REQUIRED):
 *   - 'normal': Cursor must be ON a character (max column = line.length - 1)
 *   - 'insert': Cursor can be AFTER the last character (max column = line.length)
 * @param options.offset - Optional offset to apply to the column (e.g., -1 for left, 1 for right)
 * @returns The fixed position with column clamped to valid bounds
 *
 * @example
 * // Fix cursor for normal mode (on a character)
 * fixCursorPosition(editor, pos, { mode: 'normal' })
 *
 * @example
 * // Move right and fix for insert mode
 * fixCursorPosition(editor, pos, { mode: 'insert', offset: 1 })
 *
 * @example
 * // Move left in normal mode
 * fixCursorPosition(editor, pos, { mode: 'normal', offset: -1 })
 */
export function fixCursorPosition(
  editor: Editor,
  pos: Pos,
  options: { mode: 'normal' | 'insert'; offset?: number }
): Pos {
  const mode = options.mode;
  const offset = options.offset ?? 0;
  const line = editor.getLine(pos.l);

  // In normal mode, cursor must be ON a character (max = line.length - 1)
  // In insert mode, cursor can be AFTER the last character (max = line.length)
  const maxColumn = mode === 'normal' ? Math.max(0, line.length - 1) : line.length;

  const c = Math.max(0, Math.min(maxColumn, pos.c + offset));
  return { l: pos.l, c };
}

export function visualFromEditor(editor: Editor, sel: Selection) {
  function backward(pos: Pos) {
    if (pos.c === 0) {
      if (pos.l === 0) {
        return { l: 0, c: 0 };
      } else {
        const l = pos.l - 1;
        return { l, c: editor.getLineLength(l) };
      }
    } else {
      return { l: pos.l, c: pos.c - 1 };
    }
  }

  const isForward = comparePos(sel.active, sel.anchor);
  let anchor: Pos, active: Pos;
  if (isForward === 0) {
    // TODO LOG invalid... but fix it anyways
    anchor = sel.active;
    active = sel.active;
  } else if (isForward > 0) {
    anchor = sel.anchor;
    active = backward(sel.active);
  } else {
    // backward
    anchor = backward(sel.anchor);
    active = sel.active;
  }
  return { anchor, active };
}

export function visualToEditor(editor: Editor, sel: Selection) {
  function forward(pos: Pos) {
    const l = editor.getLineLength(pos.l);
    if (pos.c >= l) {
      if (pos.l >= editor.getLines() - 1) {
        return { l: pos.l, c: pos.c };
      } else {
        return { l: pos.l + 1, c: 0 };
      }
    } else {
      return { l: pos.l, c: pos.c + 1 };
    }
  }

  const isForward = comparePos(sel.active, sel.anchor);
  let anchor: Pos, active: Pos;
  if (isForward >= 0) {
    anchor = sel.anchor;
    active = forward(sel.active);
  } else {
    // backward
    anchor = forward(sel.anchor);
    active = sel.active;
  }
  return { anchor, active };
}
