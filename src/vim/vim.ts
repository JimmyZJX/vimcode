// Zed reference:
// - commit: e727080af232cec481bafb2d080585091c3f5db7
// - sources: crates/vim/src/vim.rs, crates/vim/src/normal.rs, crates/vim/src/motion.rs
// - translated concepts: modes, counts, pending operators, semantic motion dispatch
// - intentional differences: this is a small VSCode-oriented first slice with a synchronous
//   editor capability interface; GPUI action registration is replaced by direct key dispatch.

import { VimEditorCapabilities, normalCursorPosition, rangeText } from "./editor.js";
import { Motion, applyMotion, lineRange, linewiseCursorAfterDelete, motionRange } from "./motion.js";
import {
  Operator,
  Position,
  TextEdit,
  VimMode,
  VimSelection,
  charwiseSelection,
  comparePositions,
  orderedRange,
  rangeOfSelection,
  selectionHead,
} from "./state.js";

type PendingOperator = {
  operator: Operator;
  count: number;
};

type PendingPrefix = "g";

export type KeyResult = "handled" | "not-handled";

// Zed: `vim::Vim`. This class is the local main
// state holder; GPUI entity/window fields are intentionally replaced by the
// injected `VimEditorCapabilities`.
export class Vim {
  private modeState: VimMode = { dialect: "vim", kind: "normal" };
  private countBuffer = "";
  private pendingOperator: PendingOperator | undefined;
  private pendingPrefix: PendingPrefix | undefined;

  constructor(private readonly editor: VimEditorCapabilities) {
    this.editor.setCursorStyle("block");
  }

  get mode(): VimMode {
    return this.modeState;
  }

  get modeName(): string {
    const suffix = this.pendingOperator !== undefined || this.pendingPrefix !== undefined ? "+" : "";
    return `${this.modeState.dialect}:${this.modeState.kind}${suffix}`;
  }

  // Zed: key dispatch normally arrives through GPUI actions registered by
  // `vim::Vim::action` and key contexts from `vim::Vim::extend_key_context`.
  // The VSCode patch calls
  // this direct key entry point instead.
  onKey(key: string): KeyResult {
    if (this.isEscape(key)) {
      this.clearPending();
      if (this.modeState.kind !== "normal") {
        this.enterNormalMode({ moveLeft: this.modeState.kind === "insert" });
      }
      return "handled";
    }

    if (this.modeState.kind === "insert") {
      if (key.length === 1 || key === "\n") {
        this.insertText(key);
        return "handled";
      }
      return "not-handled";
    }

    if (this.modeState.kind !== "normal") {
      return "not-handled";
    }

    return this.onNormalKey(key);
  }

  // Zed: assets/keymaps/vim.json plus `vim_operator` / `vim_mode` contexts.
  // This first slice hard-codes the tiny keymap until we introduce a Zed-like
  // declarative keymap file.
  private onNormalKey(key: string): KeyResult {
    if (this.pendingPrefix === "g") {
      this.pendingPrefix = undefined;
      if (key === "g") {
        const count = this.takeCount(1);
        this.moveToLine(count - 1);
        return "handled";
      }
      this.clearPending();
      return "not-handled";
    }

    if (this.isCountKey(key)) {
      this.countBuffer += key;
      return "handled";
    }

    if (key === "g") {
      this.pendingPrefix = "g";
      return "handled";
    }

    const motion = motionForKey(key);
    if (motion !== undefined) {
      this.handleMotion(motion);
      return "handled";
    }

    if (key === "G") {
      const maybeLine = this.takeCount(undefined);
      this.moveToLine(maybeLine === undefined ? this.editor.lineCount() - 1 : maybeLine - 1);
      return "handled";
    }

    if (isOperatorKey(key)) {
      if (this.pendingOperator?.operator === operatorForKey(key)) {
        this.handleLineOperator(this.pendingOperator.operator);
      } else {
        // Zed: `vim::Vim::push_operator`.
        this.pendingOperator = { operator: operatorForKey(key), count: this.takeCount(1) };
      }
      return "handled";
    }

    switch (key) {
      case "i":
        this.enterInsertAtSelections((pos) => pos);
        return "handled";
      case "a":
        this.enterInsertAtSelections((pos) => ({
          row: pos.row,
          column: Math.min(pos.column + 1, this.editor.lineLength(pos.row)),
        }));
        return "handled";
      case "I":
        this.enterInsertAtSelections((pos) => firstNonWhitespace(this.editor.line(pos.row), pos.row));
        return "handled";
      case "A":
        this.enterInsertAtSelections((pos) => ({ row: pos.row, column: this.editor.lineLength(pos.row) }));
        return "handled";
      case "o":
        this.openLine({ above: false });
        return "handled";
      case "O":
        this.openLine({ above: true });
        return "handled";
      case "x":
        this.deleteCharacters(this.takeCount(1));
        return "handled";
      case "p":
        this.paste({ before: false });
        return "handled";
      case "P":
        this.paste({ before: true });
        return "handled";
      default:
        this.clearPending();
        return "not-handled";
    }
  }

  // Zed: `motion::Vim::motion`, which combines counts,
  // forced-motion state, active operators, and mode-specific motion handling.
  private handleMotion(motion: Motion): void {
    const postCount = this.takeCount(1);
    const pending = this.pendingOperator;
    this.pendingOperator = undefined;

    if (pending === undefined) {
      this.moveSelections(motion, postCount);
    } else {
      this.applyOperatorToMotion(pending.operator, motion, pending.count * postCount);
    }
  }

  private moveSelections(motion: Motion, count: number): void {
    this.editor.setSelections(
      this.editor.getSelections().map((selection) => {
        const head = applyMotion(this.editor, selectionHead(selection), motion, count);
        return charwiseSelection(head);
      })
    );
  }

  private moveToLine(row: number): void {
    const targetRow = Math.max(0, Math.min(row, this.editor.lineCount() - 1));
    this.editor.setSelections(
      this.editor.getSelections().map(() => charwiseSelection(firstNonWhitespace(this.editor.line(targetRow), targetRow)))
    );
  }

  // Zed: `normal::Vim::normal_motion` dispatches active operators to
  // `normal::change::Vim::change_motion`, `normal::delete::Vim::delete_motion`,
  // or `normal::yank::Vim::yank_motion`.
  private applyOperatorToMotion(operator: Operator, motion: Motion, count: number): void {
    const edits: TextEdit[] = [];
    const selectionsAfter: VimSelection[] = [];
    const copied: string[] = [];

    for (const selection of this.editor.getSelections()) {
      const head = selectionHead(selection);
      const range = motionRange(this.editor, head, motion, count);
      if (comparePositions(range.start, range.end) === 0) {
        selectionsAfter.push(charwiseSelection(head));
        continue;
      }
      copied.push(rangeText(this.editor, range));
      if (operator === "yank") {
        selectionsAfter.push(charwiseSelection(head));
      } else {
        edits.push({ range, text: "" });
        selectionsAfter.push(charwiseSelection(normalCursorPosition(this.editor, range.start)));
      }
    }

    if (copied.length > 0) this.editor.writeClipboard(copied.join("\n"));
    if (operator === "yank") {
      this.editor.setSelections(selectionsAfter);
      return;
    }

    this.editor.applyEdits(edits, selectionsAfter);
    if (operator === "change") this.enterInsertMode();
  }

  // Zed: `dd`/`cc`/`yy` are represented as operator + `Motion::CurrentLine`;
  // see assets/keymaps/vim.json `vim_operator == d/y/...` and
  // `motion::Motion::CurrentLine`.
  private handleLineOperator(operator: Operator): void {
    const postCount = this.takeCount(1);
    const pendingCount = this.pendingOperator?.count ?? 1;
    const count = pendingCount * postCount;
    this.pendingOperator = undefined;

    const edits: TextEdit[] = [];
    const selectionsAfter: VimSelection[] = [];
    const copied: string[] = [];

    for (const selection of this.editor.getSelections()) {
      const row = selectionHead(selection).row;
      const range = lineRange(this.editor, row, count);
      copied.push(rangeText(this.editor, range));
      if (operator === "yank") {
        selectionsAfter.push(charwiseSelection(selectionHead(selection)));
      } else {
        edits.push({ range, text: "" });
        selectionsAfter.push(charwiseSelection(linewiseCursorAfterDelete(this.editor, row)));
      }
    }

    if (copied.length > 0) this.editor.writeClipboard(copied.join("\n"));
    if (operator === "yank") {
      this.editor.setSelections(selectionsAfter);
      return;
    }

    this.editor.applyEdits(edits, selectionsAfter);
    if (operator === "change") this.enterInsertMode();
  }

  // Zed: the `normal::DeleteRight` action calls
  // `delete_motion(Motion::Right, ...)`.
  private deleteCharacters(count: number): void {
    const edits: TextEdit[] = [];
    const selectionsAfter: VimSelection[] = [];
    const copied: string[] = [];

    for (const selection of this.editor.getSelections()) {
      const head = selectionHead(selection);
      const end = {
        row: head.row,
        column: Math.min(head.column + count, this.editor.lineLength(head.row)),
      };
      const range = orderedRange(head, end);
      copied.push(rangeText(this.editor, range));
      edits.push({ range, text: "" });
      selectionsAfter.push(charwiseSelection(normalCursorPosition(this.editor, head)));
    }

    if (copied.length > 0) this.editor.writeClipboard(copied.join("\n"));
    this.editor.applyEdits(edits, selectionsAfter);
  }

  private insertText(text: string): void {
    const edits: TextEdit[] = [];
    const selectionsAfter: VimSelection[] = [];

    for (const selection of this.editor.getSelections()) {
      const range = rangeOfSelection(selection);
      edits.push({ range, text });
      selectionsAfter.push(charwiseSelection(positionAfterInsertedText(range.start, text)));
    }

    this.editor.applyEdits(edits, selectionsAfter);
  }

  // Zed: `normal::paste::Vim::paste`. This is a minimal
  // characterwise paste and does not yet implement linewise, visual, counts, or
  // multicursor semantics from Zed.
  private paste({ before }: { before: boolean }): void {
    const text = this.editor.readClipboard();
    if (text.length === 0) return;

    const edits: TextEdit[] = [];
    const selectionsAfter: VimSelection[] = [];
    for (const selection of this.editor.getSelections()) {
      const head = selectionHead(selection);
      const insertAt = before
        ? head
        : { row: head.row, column: Math.min(head.column + 1, this.editor.lineLength(head.row)) };
      edits.push({ range: { start: insertAt, end: insertAt }, text });
      selectionsAfter.push(charwiseSelection(normalCursorPosition(this.editor, positionAfterInsertedText(insertAt, text))));
    }
    this.editor.applyEdits(edits, selectionsAfter);
  }

  // Zed: `normal::Vim::insert_after`, `normal::Vim::insert_before`,
  // `normal::Vim::insert_first_non_whitespace`, and `normal::Vim::insert_end_of_line`.
  private enterInsertAtSelections(map: (pos: Position) => Position): void {
    this.clearPending();
    this.modeState = { dialect: this.modeState.dialect, kind: "insert" };
    this.editor.setCursorStyle("line");
    this.editor.setSelections(
      this.editor.getSelections().map((selection) => charwiseSelection(map(selectionHead(selection))))
    );
  }

  // Zed: `normal::Vim::insert_line_above` and
  // `normal::Vim::insert_line_below`.
  private openLine({ above }: { above: boolean }): void {
    const edits: TextEdit[] = [];
    const selectionsAfter: VimSelection[] = [];
    for (const selection of this.editor.getSelections()) {
      const row = selectionHead(selection).row;
      const insertAt = above ? { row, column: 0 } : { row, column: this.editor.lineLength(row) };
      edits.push({ range: { start: insertAt, end: insertAt }, text: "\n" });
      selectionsAfter.push(charwiseSelection({ row: above ? row : row + 1, column: 0 }));
    }
    this.editor.applyEdits(edits, selectionsAfter);
    this.enterInsertMode();
  }

  private enterInsertMode(): void {
    this.modeState = { dialect: this.modeState.dialect, kind: "insert" };
    this.editor.setCursorStyle("line");
  }

  // Zed: `vim::Vim::switch_mode`. The cursor-left behavior when
  // leaving insert mode mirrors the normal-mode cursor fixup, but is simplified.
  private enterNormalMode({ moveLeft }: { moveLeft: boolean }): void {
    this.modeState = { dialect: this.modeState.dialect, kind: "normal" };
    this.editor.setCursorStyle("block");
    this.editor.setSelections(
      this.editor.getSelections().map((selection) => {
        const head = selectionHead(selection);
        const target = moveLeft ? { row: head.row, column: head.column - 1 } : head;
        return charwiseSelection(normalCursorPosition(this.editor, target));
      })
    );
  }

  // Zed: `vim::Vim::take_count`; count digit accumulation is handled by
  // `vim::Vim::push_count_digit`.
  private takeCount(defaultValue: number): number;
  private takeCount(defaultValue: undefined): number | undefined;
  private takeCount(defaultValue: number | undefined): number | undefined {
    if (this.countBuffer.length === 0) return defaultValue;
    const count = Number(this.countBuffer);
    this.countBuffer = "";
    return count;
  }

  private isCountKey(key: string): boolean {
    if (!/^\d$/.test(key)) return false;
    return key !== "0" || this.countBuffer.length > 0 || this.pendingOperator !== undefined;
  }

  private clearPending(): void {
    this.countBuffer = "";
    this.pendingOperator = undefined;
    this.pendingPrefix = undefined;
  }

  private isEscape(key: string): boolean {
    return key === "<escape>" || key === "escape" || key === "ctrl-[";
  }
}

// Zed: assets/keymaps/vim.json maps keys to action structs, and
// `motion::register` registers those actions to concrete `Motion`
// variants. This local mapping is the temporary minimal equivalent.
function motionForKey(key: string): Motion | undefined {
  switch (key) {
    case "h":
      return { type: "left" };
    case "l":
      return { type: "right" };
    case "k":
      return { type: "up" };
    case "j":
      return { type: "down" };
    case "0":
      return { type: "startOfLine" };
    case "^":
      return { type: "firstNonWhitespace" };
    case "$":
      return { type: "endOfLine" };
    case "w":
      return { type: "nextWordStart", bigWord: false };
    case "W":
      return { type: "nextWordStart", bigWord: true };
    case "e":
      return { type: "nextWordEnd", bigWord: false };
    case "E":
      return { type: "nextWordEnd", bigWord: true };
    case "b":
      return { type: "previousWordStart", bigWord: false };
    case "B":
      return { type: "previousWordStart", bigWord: true };
    default:
      return undefined;
  }
}

function isOperatorKey(key: string): boolean {
  return key === "d" || key === "c" || key === "y";
}

// Zed: assets/keymaps/vim.json maps `d`, `c`, and `y` to `PushDelete`,
// `PushChange`, and `PushYank`, which call `push_operator` in vim.rs.
function operatorForKey(key: string): Operator {
  switch (key) {
    case "d":
      return "delete";
    case "c":
      return "change";
    case "y":
      return "yank";
    default:
      throw new Error(`not an operator key: ${key}`);
  }
}

function firstNonWhitespace(line: string, row: number): Position {
  const column = line.search(/\S/);
  return { row, column: column < 0 ? 0 : column };
}

function positionAfterInsertedText(start: Position, text: string): Position {
  const lines = text.split("\n");
  if (lines.length === 1) return { row: start.row, column: start.column + text.length };
  return {
    row: start.row + lines.length - 1,
    column: lines[lines.length - 1].length,
  };
}

// Local test helper, analogous in spirit to Zed's test harness helpers in
// crates/vim/src/test/vim_test_context.rs rather than a production API.
export function runKeys(vim: Vim, keys: readonly string[]): void {
  for (const key of keys) {
    vim.onKey(key);
  }
}
