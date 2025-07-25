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
  function comparePos(a: Pos, b: Pos): number {
    return a.l === b.l ? a.c - b.c : a.l - b.l;
  }
  const [start, end] = [sel.anchor, sel.active].sort(comparePos);
  return { start, end };
}

// TODO two versions: accept end or not, also depending on if the line is empty
export function fixPos(editor: Editor, p: Pos, offset?: number) {
  return {
    l: p.l,
    c: Math.max(0, Math.min(editor.getLineLength(p.l), p.c + (offset ?? 0))),
  };
}

export type Cursor =
  | { type: "line" }
  | { type: "block" }
  // | { type: "blockBefore" }
  | { type: "halfBlock" };

export interface Editor {
  selections: Selection[];
  cursor: Cursor;

  getLines: () => number;
  getLine: (l: number) => string;
  getLineLength: (l: number) => number;
  getText: (selection?: Selection) => string;

  /** This takes care of code folding */
  getSiblingLine: (l: number, offset: number) => number;

  editText: (range: Selection, text: string) => void;

  isFake: boolean;

  // TODO visible lines

  // only implemented in real editors (VSCode)
  real_undo: () => void;
  real_redo: () => void;
  real_putClipboard: (content: string) => void;
  real_getClipboard: () => string | undefined;
}
