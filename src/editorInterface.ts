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

export function rangeOfSelection(sel: Selection) {
  function comparePos(a: Pos, b: Pos): number {
    return a.l === b.l ? a.c - b.c : a.l - b.l;
  }
  const [start, end] = [sel.anchor, sel.active].sort(comparePos);
  return { start, end };
}

export type Cursor =
  | { type: "line" }
  | { type: "block" }
  | { type: "halfBlock" };

export interface Editor {
  selections: Selection[];
  cursor: Cursor;

  getLines: () => number;
  getLine: (l: number) => string;
  getText: (selection?: Selection) => string;

  /** This takes care of code folding */
  getSiblingLine: (l: number, offset: number) => number;

  editText: (range: Selection, text: string) => void;

  // TODO visible lines
}
