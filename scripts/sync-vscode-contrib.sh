#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/sync-vscode-contrib.sh /path/to/vscode

Copies the vimcode core and VSCode contribution prototype into a VSCode/code-oss
checkout. The target checkout is modified in-place.

This script intentionally does not run the VSCode build.
USAGE
}

if [[ ${1:-} == "" || ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target_root=$1

if [[ ! -d "$target_root/src/vs/editor" ]]; then
  echo "error: target does not look like a VSCode checkout: $target_root" >&2
  exit 1
fi

target_vim_dir="$target_root/src/vs/editor/contrib/vim"
target_workbench_vim_dir="$target_root/src/vs/workbench/contrib/vim/browser"
mkdir -p "$target_vim_dir/common" "$target_vim_dir/browser" "$target_workbench_vim_dir"

rsync -a --delete \
  --exclude '*.test.ts' \
  --exclude 'test/' \
  --exclude 'test_data/' \
  "$repo_root/src/vim/" \
  "$target_vim_dir/common/"

rsync -a --delete \
  "$repo_root/vscode-contrib/browser/" \
  "$target_vim_dir/browser/"

rsync -a --delete \
  "$repo_root/vscode-contrib/workbench/" \
  "$target_workbench_vim_dir/"

# VSCode source files need the Microsoft copyright header. Add it to synced files
# when the vimcode source did not already have it.
python3 - "$target_vim_dir" "$target_workbench_vim_dir" <<'PY'
from pathlib import Path
import sys
roots = [Path(arg) for arg in sys.argv[1:]]
header = """/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

"""
for root in roots:
    for path in root.rglob("*.ts"):
        text = path.read_text()
        if not text.startswith("/*---------------------------------------------------------------------------------------------"):
            path.write_text(header + text)
PY

ensure_editor_import_patch() {
  local editor_all="$target_root/src/vs/editor/editor.all.ts"
  local import_line="import './contrib/vim/browser/vim.contribution.js';"
  if grep -Fqx "$import_line" "$editor_all"; then
    echo "VSCode patch editor-vim-contribution.patch already applied"
    return
  fi
  python3 - "$editor_all" "$import_line" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
import_line = sys.argv[2]
text = path.read_text()
needle = "import './contrib/wordHighlighter/browser/wordHighlighter.js';"
if needle in text:
    text = text.replace(needle, import_line + "\n" + needle, 1)
else:
    text += "\n" + import_line + "\n"
path.write_text(text)
PY
  echo "Applied VSCode patch editor-vim-contribution.patch"
}

ensure_workbench_import_patch() {
  local workbench_common="$target_root/src/vs/workbench/workbench.common.main.ts"
  local import_line="import './contrib/vim/browser/vimStatus.js';"
  if grep -Fqx "$import_line" "$workbench_common"; then
    echo "VSCode patch workbench-vim-status.patch already applied"
    return
  fi
  python3 - "$workbench_common" "$import_line" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
import_line = sys.argv[2]
text = path.read_text()
needle = "import './contrib/codeEditor/browser/editorFeatures.js';"
if needle in text:
    text = text.replace(needle, needle + "\n" + import_line, 1)
elif "//#region --- workbench contributions" in text:
    text = text.replace("//#region --- workbench contributions", "//#region --- workbench contributions\n\n" + import_line, 1)
else:
    text += "\n" + import_line + "\n"
path.write_text(text)
PY
  echo "Applied VSCode patch workbench-vim-status.patch"
}

ensure_cursor_rendering_patch() {
  python3 - "$target_root" <<'PY'
from pathlib import Path
import re
import sys
root = Path(sys.argv[1])

view_cursors = root / 'src/vs/editor/browser/viewParts/viewCursors/viewCursors.ts'
text = view_cursors.read_text()
original = text

# Normalize imports from all earlier versions of the patch.
text = text.replace("import { Selection, SelectionDirection } from '../../../common/core/selection.js';\n", "")
text = text.replace("import { SelectionDirection } from '../../../common/core/selection.js';\n", "")
text = text.replace(
    "import { Position } from '../../../common/core/position.js';",
    "import { Position } from '../../../common/core/position.js';\nimport { SelectionDirection } from '../../../common/core/selection.js';",
    1,
)

# Remove the older helper-based render patch if present.
text = re.sub(
    r"\n\tprivate _vimCursorRenderingEnabled\(\): boolean \{.*?\n\t\}\n\n\tprivate _vimCursorPosition\(selection: Selection\): Position \{.*?\n\t\}\n",
    "\n",
    text,
    flags=re.S,
)

if "private _vimCursorInsideSelection: boolean;" not in text:
    text = text.replace(
        "\tprivate _selectionIsEmpty: boolean;\n\tprivate _isComposingInput: boolean;",
        "\tprivate _selectionIsEmpty: boolean;\n\tprivate _vimCursorInsideSelection: boolean;\n\tprivate _isComposingInput: boolean;",
        1,
    )

if "this._vimCursorInsideSelection = false;" not in text:
    text = text.replace(
        "\t\tthis._selectionIsEmpty = true;\n\t\tthis._isComposingInput = false;",
        "\t\tthis._selectionIsEmpty = true;\n\t\tthis._vimCursorInsideSelection = false;\n\t\tthis._isComposingInput = false;",
        1,
    )

# Normalize cursor position collection to native positions; Vim's visual cursor is CSS-only.
text = re.sub(
    r"\t\tconst positions: Position\[\] = e\.cursorPositions \?\? \[\];\n\t\tif \(!e\.cursorPositions\) \{\n\t\t\tfor \(let i = 0, len = e\.selections\.length; i < len; i\+\+\) \{\n\t\t\t\tpositions\[i\] = .*?;\n\t\t\t\}\n\t\t\}\n",
    "\t\tconst positions: Position[] = e.cursorPositions ?? [];\n\t\tif (!e.cursorPositions) {\n\t\t\tfor (let i = 0, len = e.selections.length; i < len; i++) {\n\t\t\t\tpositions[i] = e.selections[i].getPosition();\n\t\t\t}\n\t\t}\n",
    text,
    flags=re.S,
)
text = text.replace(
    "\t\tconst positions: Position[] = [];\n\t\tfor (let i = 0, len = e.selections.length; i < len; i++) {\n\t\t\tpositions[i] = e.selections[i].getPosition();\n\t\t}\n",
    "\t\tconst positions: Position[] = e.cursorPositions ?? [];\n\t\tif (!e.cursorPositions) {\n\t\t\tfor (let i = 0, len = e.selections.length; i < len; i++) {\n\t\t\t\tpositions[i] = e.selections[i].getPosition();\n\t\t\t}\n\t\t}\n",
    1,
)

text = text.replace(
    "\t\tthis._onCursorPositionChanged(positions[0], positions.slice(1), e.reason);",
    "\t\tthis._onCursorPositionChanged(positions[0], positions.slice(1), e.reason, e.cursorPositions !== undefined);",
    1,
)
text = text.replace(
    "\tprivate _onCursorPositionChanged(position: Position, secondaryPositions: Position[], reason: CursorChangeReason): void {\n\t\tconst pauseAnimation = (",
    "\tprivate _onCursorPositionChanged(position: Position, secondaryPositions: Position[], reason: CursorChangeReason, forcePauseAnimation = false): void {\n\t\tconst pauseAnimation = forcePauseAnimation || (",
    1,
)

text = re.sub(
    r"\t\tconst selectionIsEmpty = e\.selections\[0\]\.isEmpty\(\);\n(?:\t\tconst vimCursorInsideSelection = .*?\n)?\t\tif \(this\._selectionIsEmpty !== selectionIsEmpty(?: \|\| this\._vimCursorInsideSelection !== vimCursorInsideSelection)?\) \{\n\t\t\tthis\._selectionIsEmpty = selectionIsEmpty;\n(?:\t\t\tthis\._vimCursorInsideSelection = vimCursorInsideSelection;\n)?\t\t\tthis\._updateDomClassName\(\);\n\t\t\}\n",
    "\t\tconst selectionIsEmpty = e.selections[0].isEmpty();\n\t\tconst vimCursorInsideSelection = this._domNode.domNode.closest('.vim-cursor-rendering-enabled') !== null\n\t\t\t&& e.cursorPositions === undefined\n\t\t\t&& e.selections.length > 0\n\t\t\t&& e.selections.every(selection => !selection.isEmpty() && selection.getDirection() === SelectionDirection.LTR && selection.positionColumn > 1);\n\t\tif (this._selectionIsEmpty !== selectionIsEmpty || this._vimCursorInsideSelection !== vimCursorInsideSelection) {\n\t\t\tthis._selectionIsEmpty = selectionIsEmpty;\n\t\t\tthis._vimCursorInsideSelection = vimCursorInsideSelection;\n\t\t\tthis._updateDomClassName();\n\t\t}\n",
    text,
    flags=re.S,
)

class_chunk = "\t\tif (this._vimCursorInsideSelection) {\n\t\t\tresult += ' vim-cursor-inside-selection';\n\t\t}\n"
text = text.replace(class_chunk, "")
text = text.replace(
    "\t\tif (!this._selectionIsEmpty) {\n\t\t\tresult += ' has-selection';\n\t\t}\n",
    "\t\tif (!this._selectionIsEmpty) {\n\t\t\tresult += ' has-selection';\n\t\t}\n" + class_chunk,
    1,
)

if text != original:
    view_cursors.write_text(text)

view_cursors_css = root / 'src/vs/editor/browser/viewParts/viewCursors/viewCursors.css'
text = view_cursors_css.read_text()
original = text
css = ".monaco-editor .cursors-layer.vim-cursor-inside-selection > .cursor {\n\tpointer-events: none;\n\ttransform: translateX(-100%);\n}\n"
text = re.sub(
    r"\.monaco-editor \.cursors-layer\.vim-cursor-inside-selection > \.cursor \{[^}]*\}\n*",
    "",
    text,
    flags=re.S,
)
marker = "/* -- smooth-caret-animation -- */"
text = text.replace(marker, css + "\n" + marker, 1)
if text != original:
    view_cursors_css.write_text(text)
PY
  echo "Applied/normalized VSCode patch vim-cursor-rendering.patch"
}

apply_patch() {
  local patch_file=$1
  local patch_name
  patch_name=$(basename "$patch_file")

  case "$patch_name" in
    editor-vim-contribution.patch)
      ensure_editor_import_patch
      return
      ;;
    workbench-vim-status.patch)
      ensure_workbench_import_patch
      return
      ;;
    vim-cursor-rendering.patch)
      ensure_cursor_rendering_patch
      return
      ;;
  esac

  if (cd "$target_root" && git apply --check "$patch_file" >/dev/null 2>&1); then
    (cd "$target_root" && git apply "$patch_file")
    echo "Applied VSCode patch $patch_name"
  elif (cd "$target_root" && git apply --reverse --check "$patch_file" >/dev/null 2>&1); then
    echo "VSCode patch $patch_name already applied"
  else
    echo "error: could not apply VSCode patch $patch_name" >&2
    echo "       Try applying it manually from $patch_file to inspect conflicts." >&2
    exit 1
  fi
}

for patch_file in "$repo_root"/vscode-contrib/patches/*.patch; do
  apply_patch "$patch_file"
done

echo "Synced vim contribution to $target_vim_dir and $target_workbench_vim_dir"
