import { Editor, Pos } from "../../editorInterface.js";
import { MotionResult } from "./motion.js";

type CharType = "word" | "white" | "other";

const RE_IS_WORD = /\w/;
const RE_IS_WHITE = /\s/;
export function getCharType(char: string): CharType {
  if (RE_IS_WORD.test(char[0])) return "word";
  if (RE_IS_WHITE.test(char[0])) return "white";
  return "other";
}

function* iterChar(editor: Editor, p: Pos) {
  const totalLines = editor.getLines();
  for (let l = p.l; l < totalLines; l++) {
    const line = editor.getLine(l);
    let startC = l === p.l ? p.c : 0;
    for (let c = startC; c < line.length; c++) {
      yield { char: line[c], pos: { l, c } };
    }
    if (l + 1 < totalLines) {
      yield { char: "\n", pos: { l, c: line.length } };
    }
  }
}

function* iterCharBack(editor: Editor, p: Pos) {
  for (let l = p.l; l >= 0; l--) {
    const line = editor.getLine(l);
    if (l !== p.l) {
      yield { char: "\n", pos: { l, c: line.length } };
    }
    let startC: number;
    if (l === p.l) {
      if (line.length === 0) {
        yield { char: "\n", pos: { l, c: 0 } };
        startC = -1;
      } else {
        startC = Math.min(line.length - 1, p.c);
      }
    } else {
      startC = line.length - 1;
    }
    for (let c = startC; c >= 0; c--) {
      yield { char: line[c], pos: { l, c } };
    }
  }
}

function editorEndPos(editor: Editor): Pos {
  const lastLine = editor.getLines() - 1;
  return { l: lastLine, c: Math.max(0, editor.getLineLength(lastLine) - 1) };
}

function doForwardWord(
  editor: Editor,
  p: Pos,
  whiteOnly: boolean,
  stopOnWhite: boolean,
  stopOnLF: boolean
) {
  let charType: CharType | null = null;
  for (const { char, pos } of iterChar(editor, p)) {
    const t = getCharType(char);
    if (charType !== null) {
      if (char === "\n" && (stopOnLF || pos.c === 0)) {
        // empty new line
        return pos;
      }
      const isDifferentType = whiteOnly
        ? (charType === "white") !== (t === "white")
        : charType !== t;
      if (isDifferentType && (stopOnWhite || t !== "white")) {
        return pos;
      }
    }
    charType = t;
  }
  return editorEndPos(editor);
}

export function forwardWord(
  editor: Editor,
  p: Pos,
  {
    whiteOnly,
    stopOnWhite,
    stopOnLF,
  }: { whiteOnly: boolean; stopOnWhite?: boolean; stopOnLF?: boolean }
): MotionResult {
  const pos = doForwardWord(editor, p, whiteOnly, !!stopOnWhite, !!stopOnLF);
  return { pos, range: { active: p, anchor: pos } };
}

export function forwardEnd(
  editor: Editor,
  p: Pos,
  whiteSpaceOnly: boolean
): MotionResult {
  let charType: CharType | null = null;
  let lastPos: Pos = { l: p.l, c: p.c };
  let skipFirst = true;
  for (const { char, pos } of iterChar(editor, p)) {
    if (skipFirst) {
      skipFirst = false;
    } else {
      const t = getCharType(char);
      if (charType !== null) {
        const isDifferentType = whiteSpaceOnly
          ? (charType === "white") !== (t === "white")
          : charType !== t;
        if (isDifferentType && charType !== "white") {
          return { pos: lastPos };
        }
      }
      charType = t;
    }
    lastPos = pos;
  }
  return { pos: editorEndPos(editor) };
}

export function back(
  editor: Editor,
  p: Pos,
  whiteSpaceOnly: boolean
): MotionResult {
  let charType: CharType | null = null;
  let lastPos: Pos = { l: p.l, c: p.c };
  let skipFirst = true;
  for (const { char, pos } of iterCharBack(editor, p)) {
    if (skipFirst) {
      skipFirst = false;
    } else {
      if (char === "\n" && pos.c === 0) {
        // empty new line
        return { pos };
      }
      const t = getCharType(char);
      if (charType !== null) {
        const isDifferentType = whiteSpaceOnly
          ? (charType === "white") !== (t === "white")
          : charType !== t;
        if (isDifferentType && charType !== "white") {
          return { pos: lastPos };
        }
      }
      charType = t;
    }
    lastPos = pos;
  }
  return { pos: { l: 0, c: 0 } };
}
