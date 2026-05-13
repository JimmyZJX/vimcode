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

editor_all="$target_root/src/vs/editor/editor.all.ts"
import_line="import './contrib/vim/browser/vim.contribution.js';"
if ! grep -Fqx "$import_line" "$editor_all"; then
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
fi

# Patch VSCode's cursor rendering event path to allow Vim to provide a visual
# cursor position separately from the selection's active endpoint. This keeps
# forward visual selections highlighted as exclusive editor ranges while rendering
# the cursor on the selected Vim character.
python3 - "$target_root" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])

view_events = root / 'src/vs/editor/common/viewEvents.ts'
text = view_events.read_text()
if "import { Position } from './core/position.js';" not in text:
    text = text.replace("import { Range } from './core/range.js';", "import { Position } from './core/position.js';\nimport { Range } from './core/range.js';", 1)
old = """\tconstructor(\n\t\tpublic readonly selections: Selection[],\n\t\tpublic readonly modelSelections: Selection[],\n\t\tpublic readonly reason: CursorChangeReason\n\t) { }\n"""
new = """\tconstructor(\n\t\tpublic readonly selections: Selection[],\n\t\tpublic readonly modelSelections: Selection[],\n\t\tpublic readonly reason: CursorChangeReason,\n\t\tpublic readonly cursorPositions: Position[] | undefined = undefined\n\t) { }\n"""
if old in text:
    text = text.replace(old, new, 1)
view_events.write_text(text)

view_cursors = root / 'src/vs/editor/browser/viewParts/viewCursors/viewCursors.ts'
text = view_cursors.read_text()
old = """\t\tconst positions: Position[] = [];\n\t\tfor (let i = 0, len = e.selections.length; i < len; i++) {\n\t\t\tpositions[i] = e.selections[i].getPosition();\n\t\t}\n"""
new = """\t\tconst positions: Position[] = e.cursorPositions ?? [];\n\t\tif (!e.cursorPositions) {\n\t\t\tfor (let i = 0, len = e.selections.length; i < len; i++) {\n\t\t\t\tpositions[i] = e.selections[i].getPosition();\n\t\t\t}\n\t\t}\n"""
if old in text:
    text = text.replace(old, new, 1)
view_cursors.write_text(text)

cursor = root / 'src/vs/editor/common/cursor/cursor.ts'
text = cursor.read_text()
old = """\t\t// Let the view get the event first.\n\t\teventsCollector.emitViewEvent(new ViewCursorStateChangedEvent(viewSelections, selections, reason));\n"""
new = """\t\tconst viewCursorPositions = this._getViewCursorPositionsFromSource(source, selections.length);\n\n\t\t// Let the view get the event first.\n\t\teventsCollector.emitViewEvent(new ViewCursorStateChangedEvent(viewSelections, selections, reason, viewCursorPositions));\n"""
if old in text:
    text = text.replace(old, new, 1)
method = """\n\tprivate _getViewCursorPositionsFromSource(source: string | null | undefined, selectionCount: number): Position[] | undefined {\n\t\tconst prefix = 'vim.cursorPositions:';\n\t\tif (!source?.startsWith(prefix)) {\n\t\t\treturn undefined;\n\t\t}\n\t\tconst rawPositions = source.slice(prefix.length).split(';').filter(Boolean);\n\t\tif (rawPositions.length !== selectionCount) {\n\t\t\treturn undefined;\n\t\t}\n\t\tconst result: Position[] = [];\n\t\tfor (const rawPosition of rawPositions) {\n\t\t\tconst [rawLineNumber, rawColumn] = rawPosition.split(',');\n\t\t\tconst lineNumber = Number(rawLineNumber);\n\t\t\tconst column = Number(rawColumn);\n\t\t\tif (!Number.isFinite(lineNumber) || !Number.isFinite(column)) {\n\t\t\t\treturn undefined;\n\t\t\t}\n\t\t\tresult.push(this._coordinatesConverter.convertModelPositionToViewPosition(new Position(lineNumber, column)));\n\t\t}\n\t\treturn result;\n\t}\n"""
anchor = """\n\t// -----------------------------------------------------------------------------------------------------------\n\t// ----- handlers beyond this point\n"""
if "private _getViewCursorPositionsFromSource" not in text:
    text = text.replace(anchor, method + anchor, 1)
cursor.write_text(text)
PY

workbench_common="$target_root/src/vs/workbench/workbench.common.main.ts"
workbench_import_line="import './contrib/vim/browser/vimStatus.js';"
if ! grep -Fqx "$workbench_import_line" "$workbench_common"; then
  python3 - "$workbench_common" "$workbench_import_line" <<'PY'
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
fi

echo "Synced vim contribution to $target_vim_dir and $target_workbench_vim_dir"
