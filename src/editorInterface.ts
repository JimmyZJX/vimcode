export type Pos = {
  l: number;
  c: number;
};

export type Selection = {
  anchor: Pos;
  active: Pos;
};

export type Range = {
  start: Pos;
  end: Pos;
};

export function comparePos(a: Pos, b: Pos): number {
  return a.l === b.l ? a.c - b.c : a.l - b.l;
}

export function rangeOfSelection(sel: Selection) {
  const [start, end] = [sel.anchor, sel.active].sort(comparePos);
  return { start, end };
}

export type Cursor =
  | { type: "line" }
  | { type: "block" }
  // | { type: "blockBefore" }
  | { type: "halfBlock" };

export interface Editor {
  selections: Selection[];
  cursor: Cursor;

  /**
   * Get the total number of lines in the editor.
   * @returns Number of lines (minimum 1 for empty document)
   */
  getLines: () => number;

  /**
   * Get the content of a line.
   * @param l - Line number (0-indexed)
   * @returns Line content, or empty string "" if line is out of bounds
   * @contract Implementations MUST return "" for out-of-bounds access (l < 0 or l >= getLines())
   */
  getLine: (l: number) => string;

  /**
   * Get the length of a line.
   * @param l - Line number (0-indexed)
   * @returns Length of the line, or 0 if line is out of bounds
   * @contract Implementations MUST return 0 for out-of-bounds access (l < 0 or l >= getLines())
   */
  getLineLength: (l: number) => number;

  /**
   * Get text content from a selection range.
   * @param selection - Optional selection range. If omitted, returns entire document text.
   * @returns Text content
   */
  getText: (selection?: Selection) => string;

  /** This takes care of code folding */
  getSiblingLine: (l: number, offset: number) => number;

  editText: (range: Selection, text: string) => void;

  isFake: boolean;

  // TODO visible lines

  // only implemented in real editors (VSCode)
  real_undo: () => void;
  real_redo: () => void;
  real_putClipboard: (content: string) => Promise<void>;
  real_getClipboard: () => Promise<string | undefined>;
}
