export type Pos = {
  l: number;
  c: number;
};

export type Selection = {
  anchor: Pos;
  active: Pos;
};

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

  getSiblingLine: (l: number, offset: number) => number;

  editText: (selection: Selection, text: string) => void;

  // TODO visible lines
}
