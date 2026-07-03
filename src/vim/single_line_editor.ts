// Reference: /home/jimzhao/vscode-extensions/leaderkey/src/common/singleLineEditor.ts
// This is the adapter-neutral core of leaderkey's production single-line editor.

function findWordBoundary(text: string, direction: "left" | "right"): number {
  if (text.length === 0) return 0;

  if (direction === "left") {
    const match = text.match(/(^|\s)\S+\s*$/);
    if (match === null) return 0;
    return (match.index ?? 0) + match[1].length;
  }

  const match = text.match(/^(\s*)($|\S+)(\s|$)/);
  if (match === null) return 0;
  return match[1].length + match[2].length;
}

export type SingleLineEditorKey =
  | "left"
  | "right"
  | "ctrl-left"
  | "ctrl-right"
  | "home"
  | "end"
  | "space"
  | "backspace"
  | "delete"
  | "ctrl-backspace"
  | "ctrl-delete";

export class SingleLineEditor {
  private input: string;
  private cursor: number;

  constructor(initInput: string) {
    this.input = initInput;
    this.cursor = initInput.length;
  }

  value(): string {
    return this.input;
  }

  cursorPosition(): number {
    return this.cursor;
  }

  insert(content: string): void {
    const sanitized = content.replace(/\r|\n/g, "");
    this.edit(lr => {
      lr.l += sanitized;
    });
  }

  /** Replace the whole input (a history recall), cursor at the end. */
  reset(value: string): void {
    this.input = value.replace(/\r|\n/g, "");
    this.cursor = this.input.length;
  }

  tryKey(key: SingleLineEditorKey): "handled" | undefined {
    switch (key) {
      case "left":
        this.moveCursor(-1);
        return "handled";
      case "right":
        this.moveCursor(1);
        return "handled";
      case "ctrl-left":
        this.cursor = this.edit(lr => findWordBoundary(lr.l, "left"));
        return "handled";
      case "ctrl-right":
        this.cursor += this.edit(lr => findWordBoundary(lr.r, "right"));
        return "handled";
      case "home":
        this.cursor = 0;
        return "handled";
      case "end":
        this.cursor = this.input.length;
        return "handled";
      case "space":
        this.insert(" ");
        return "handled";
      case "backspace":
        this.edit(lr => {
          lr.l = lr.l.slice(0, -1);
        });
        return "handled";
      case "delete":
        this.edit(lr => {
          lr.r = lr.r.slice(1);
        });
        return "handled";
      case "ctrl-backspace":
        this.edit(lr => {
          lr.l = lr.l.slice(0, findWordBoundary(lr.l, "left"));
        });
        return "handled";
      case "ctrl-delete":
        this.edit(lr => {
          lr.r = lr.r.slice(findWordBoundary(lr.r, "right"));
        });
        return "handled";
    }
  }

  private moveCursor(delta: number): void {
    if (delta > 0) {
      this.cursor = Math.min(this.input.length, this.cursor + delta);
    } else {
      this.cursor = Math.max(0, this.cursor + delta);
    }
  }

  private edit<T>(f: (lr: { l: string; r: string }) => T): T {
    const lr = { l: this.input.slice(0, this.cursor), r: this.input.slice(this.cursor) };
    const result = f(lr);
    this.input = lr.l + lr.r;
    this.cursor = lr.l.length;
    return result;
  }
}
