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

/**
 * Moves a position backward by one character, handling line wrapping.
 *
 * This handles the edge case where moving backward from column 0 should
 * wrap to the end of the previous line (like Vim's cursor behavior).
 *
 * @param editor - The editor instance
 * @param pos - The position to move backward from
 * @returns The position one character before, or (0,0) if at document start
 *
 * @example
 * // Middle of line: (0, 5) -> (0, 4)
 * // Start of line: (1, 0) -> (0, <end of line 0>)
 * // Document start: (0, 0) -> (0, 0)
 */
function moveBackwardOneChar(editor: Editor, pos: Pos): Pos {
  if (pos.c === 0) {
    // At start of line - need to wrap to previous line
    if (pos.l === 0) {
      // Already at document start - can't go back further
      return { l: 0, c: 0 };
    } else {
      // Wrap to end of previous line
      const prevLine = pos.l - 1;
      return { l: prevLine, c: editor.getLineLength(prevLine) };
    }
  } else {
    // Normal case: just move back one column
    return { l: pos.l, c: pos.c - 1 };
  }
}

/**
 * Moves a position forward by one character, handling line wrapping.
 *
 * This handles the edge case where moving forward from end of line should
 * wrap to the start of the next line (like VSCode's cursor behavior).
 *
 * @param editor - The editor instance
 * @param pos - The position to move forward from
 * @returns The position one character after, or same pos if at document end
 *
 * @example
 * // Middle of line: (0, 5) -> (0, 6)
 * // End of line: (0, <end>) -> (1, 0)
 * // Document end: (<last>, <end>) -> (<last>, <end>)
 */
function moveForwardOneChar(editor: Editor, pos: Pos): Pos {
  const lineLength = editor.getLineLength(pos.l);

  if (pos.c >= lineLength) {
    // At or past end of line - need to wrap to next line
    if (pos.l >= editor.getLines() - 1) {
      // Already at last line - can't go forward further
      return { l: pos.l, c: pos.c };
    } else {
      // Wrap to start of next line
      return { l: pos.l + 1, c: 0 };
    }
  } else {
    // Normal case: just move forward one column
    return { l: pos.l, c: pos.c + 1 };
  }
}

/**
 * Converts a VSCode-style exclusive selection to Vim-style inclusive selection.
 *
 * VSCode/Editors: Selections are EXCLUSIVE - the active position is AFTER the last selected character.
 *   Example: Selecting "abc" means anchor=0, active=3 (active is past 'c')
 *
 * Vim: Selections are INCLUSIVE - the cursor is ON the last selected character.
 *   Example: Selecting "abc" means anchor=0, active=2 (active is on 'c')
 *
 * This function converts from VSCode's model to Vim's model by moving the "far end"
 * of the selection backward by one character.
 *
 * @param editor - The editor instance
 * @param sel - VSCode-style exclusive selection
 * @returns Vim-style inclusive selection
 *
 * @example
 * // Forward selection "abc": {anchor: (0,0), active: (0,3)} -> {anchor: (0,0), active: (0,2)}
 * // Backward selection "abc": {anchor: (0,3), active: (0,0)} -> {anchor: (0,2), active: (0,0)}
 */
export function visualFromEditor(editor: Editor, sel: Selection): Selection {
  const selectionDirection = comparePos(sel.active, sel.anchor);

  if (selectionDirection === 0) {
    // Degenerate case: anchor and active are the same (zero-width selection)
    // This shouldn't normally happen, but we handle it gracefully
    return { anchor: sel.active, active: sel.active };
  } else if (selectionDirection > 0) {
    // Forward selection: active > anchor
    // Move active backward to make it inclusive
    return {
      anchor: sel.anchor,
      active: moveBackwardOneChar(editor, sel.active)
    };
  } else {
    // Backward selection: active < anchor
    // Move anchor backward to make it inclusive (anchor is the "far end" here)
    return {
      anchor: moveBackwardOneChar(editor, sel.anchor),
      active: sel.active
    };
  }
}

/**
 * Converts a Vim-style inclusive selection to VSCode-style exclusive selection.
 *
 * Vim: Selections are INCLUSIVE - the cursor is ON the last selected character.
 *   Example: Selecting "abc" means anchor=0, active=2 (active is on 'c')
 *
 * VSCode/Editors: Selections are EXCLUSIVE - the active position is AFTER the last selected character.
 *   Example: Selecting "abc" means anchor=0, active=3 (active is past 'c')
 *
 * This function converts from Vim's model to VSCode's model by moving the "far end"
 * of the selection forward by one character.
 *
 * @param editor - The editor instance
 * @param sel - Vim-style inclusive selection
 * @returns VSCode-style exclusive selection
 *
 * @example
 * // Forward selection "abc": {anchor: (0,0), active: (0,2)} -> {anchor: (0,0), active: (0,3)}
 * // Backward selection "abc": {anchor: (0,2), active: (0,0)} -> {anchor: (0,3), active: (0,0)}
 */
export function visualToEditor(editor: Editor, sel: Selection): Selection {
  const selectionDirection = comparePos(sel.active, sel.anchor);

  if (selectionDirection >= 0) {
    // Forward selection (or equal): active >= anchor
    // Move active forward to make it exclusive
    return {
      anchor: sel.anchor,
      active: moveForwardOneChar(editor, sel.active)
    };
  } else {
    // Backward selection: active < anchor
    // Move anchor forward to make it exclusive (anchor is the "far end" here)
    return {
      anchor: moveForwardOneChar(editor, sel.anchor),
      active: sel.active
    };
  }
}
