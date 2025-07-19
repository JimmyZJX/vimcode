import { comparePos, Editor, Pos, Selection } from "../editorInterface";

export function fixNormalCursor(editor: Editor, pos: Pos): Pos {
  const line = editor.getLine(pos.l);
  const c = Math.max(0, Math.min(line.length - 1, pos.c));
  return { l: pos.l, c };
}

export function fixCursor(editor: Editor, pos: Pos): Pos {
  const line = editor.getLine(pos.l);
  const c = Math.max(0, Math.min(line.length, pos.c));
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
