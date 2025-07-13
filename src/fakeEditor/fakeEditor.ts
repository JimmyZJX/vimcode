import {
  Cursor,
  Editor,
  rangeOfSelection,
  Selection,
} from "../editorInterface";

export class FakeEditor implements Editor {
  private lines: string[];
  private _selections: Selection[];
  private _cursor: Cursor;

  constructor(text: string = "") {
    this.lines = text.split("\n");
    this._selections = [
      {
        anchor: { l: 0, c: 0 },
        active: { l: 0, c: 0 },
      },
    ];
    this._cursor = { type: "line" };
  }

  get selections() {
    return this._selections;
  }
  set selections(val: Selection[]) {
    if (val.length === 0) throw new Error("selections being set to empty!");
    this._selections = val;
  }

  get cursor() {
    return this._cursor;
  }
  set cursor(val: Cursor) {
    this._cursor = val;
  }

  getLines() {
    return this.lines.length;
  }

  getLine(l: number) {
    return this.lines[l] ?? "";
  }

  getText(selection?: Selection) {
    if (!selection) {
      return this.lines.join("\n");
    }
    const { start, end } = rangeOfSelection(selection);
    const lines = [
      this.lines[start.l]?.slice(start.c) ?? "",
      ...this.lines.slice(start.l + 1, end.l),
      this.lines[end.l]?.slice(0, end.c) ?? "",
    ];
    return lines.join("\n");
  }

  getSiblingLine(l: number, offset: number) {
    let sibling = l + offset;
    if (sibling < 0) sibling = 0;
    if (sibling >= this.lines.length) sibling = this.lines.length - 1;
    return sibling;
  }

  editText(range: Selection, text: string) {
    const { start, end } = rangeOfSelection(range);
    const first = this.lines[start.l].slice(0, start.c) + text;
    const last = this.lines[end.l].slice(end.c);
    this.lines.splice(
      start.l,
      end.l - start.l + 1,
      ...(first + last).split("\n")
    );
  }

  private static withTableBorder(lines: string[]): string {
    const maxWidth = lines.reduce((w, line) => Math.max(w, line.length), 0);
    let out = "";
    out += "┌" + "─".repeat(maxWidth) + "┐\n";
    for (const line of lines) {
      out += "│" + line.padEnd(maxWidth, " ") + "│\n";
    }
    out += "└" + "─".repeat(maxWidth) + "┘\n";
    return out;
  }

  dump(): string {
    // Render lines with cursor(s) and selection(s)
    let out = "";
    // First, mark selections (so cursor can overwrite if needed)
    const cursorMarkers: { [l: number]: { [c: number]: string } } = {};
    for (const sel of this._selections) {
      const { start, end } = rangeOfSelection(sel);
      for (let l = start.l; l <= end.l; l++) {
        let from = l === start.l ? start.c : 0;
        let to = l === end.l ? end.c : this.lines[l]?.length ?? 0;
        if (from === to) continue;
        cursorMarkers[l] = cursorMarkers[l] || {};
        for (let c = from; c < to; c++) {
          if (l === sel.anchor.l && c === sel.anchor.c) {
            cursorMarkers[l][c] = "▅";
          } else {
            cursorMarkers[l][c] = "▂";
          }
        }
      }
    }
    // Then, mark cursor (overwriting selection if overlap)
    const cursorChar =
      this._cursor.type === "line"
        ? "▏"
        : this._cursor.type === "block"
        ? "█"
        : "▄";
    for (const {
      anchor: _,
      active: { l, c },
    } of this.selections) {
      cursorMarkers[l] = cursorMarkers[l] || {};
      cursorMarkers[l][c] = cursorChar;
    }
    // Prepare lines with markers
    let linesWithMarkers: string[] = [];
    for (let l = 0; l < this.lines.length; l++) {
      let line = this.lines[l];
      let markerLine = "";
      if (cursorMarkers[l]) {
        for (let c = 0; c <= line.length; c++) {
          markerLine += cursorMarkers[l][c] || " ";
        }
      } else {
        markerLine = "";
      }
      linesWithMarkers.push(line + "⏎");
      if (markerLine.trim()) {
        linesWithMarkers.push(markerLine);
      }
    }
    return FakeEditor.withTableBorder(linesWithMarkers);
  }
}

export default FakeEditor;
