#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/sync-vscode-contrib.sh [--from-scratch] /path/to/vscode

Copies the vimcode core and VSCode contribution prototype into a VSCode/code-oss
checkout. The target checkout is modified in-place.

Options:
  --from-scratch  First revert the VSCode files touched by vimcode patch files.
                  This discards local edits to those files in the target checkout.

This script intentionally does not run the VSCode build.
USAGE
}

from_scratch=false
target_root=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --from-scratch)
      from_scratch=true
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$target_root" ]]; then
        echo "error: expected exactly one VSCode checkout path" >&2
        usage >&2
        exit 1
      fi
      target_root=$1
      shift
      ;;
  esac
done

if [[ -z "$target_root" && $# -gt 0 ]]; then
  target_root=$1
  shift
fi

if [[ -z "$target_root" || $# -gt 0 ]]; then
  usage
  exit 1
fi

script_path=$(realpath "${BASH_SOURCE[0]}")
repo_root=$(cd "$(dirname "$script_path")/.." && pwd)
patch_dir="$repo_root/vscode-contrib/patches"
patch_files=("$patch_dir"/*.patch)
if [[ ! -e "${patch_files[0]}" ]]; then
  echo "error: no VSCode patch files found under $patch_dir" >&2
  echo "       Make sure you are running the sync script from the vimcode checkout, not a copied script." >&2
  exit 1
fi

if [[ ! -d "$target_root/src/vs/editor" ]]; then
  echo "error: target does not look like a VSCode checkout: $target_root" >&2
  exit 1
fi

# Files touched by older versions of vimcode patches.  Keep these in the
# --from-scratch reset set so shrinking a patch does not leave stale edits in an
# existing VSCode checkout.
legacy_patch_targets=(
  src/vs/editor/browser/controller/mouseHandler.ts
  src/vs/editor/browser/controller/mouseTarget.ts
  src/vs/editor/browser/coreCommands.ts
  src/vs/editor/browser/view/viewController.ts
  src/vs/editor/browser/view.ts
  src/vs/editor/browser/viewParts/selections/selections.ts
  src/vs/editor/browser/widget/codeEditor/codeEditorWidget.ts
  src/vs/editor/common/cursorEvents.ts
  src/vs/editor/common/viewModel.ts
  src/vs/editor/common/viewModel/viewContext.ts
  src/vs/editor/common/viewModel/viewModelImpl.ts
  src/vs/editor/common/viewModelEventDispatcher.ts
)

patch_targets_for() {
  local patch_file=$1
  awk '
    /^\+\+\+ / {
      path = $2
      if (path == "/dev/null") next
      sub(/^b\//, "", path)
      print path
    }
  ' "$patch_file"
}

remove_reject_files_for() {
  local patch_file=$1
  local patch_path

  while IFS= read -r patch_path; do
    [[ -n "$patch_path" ]] || continue
    rm -f "$target_root/$patch_path.rej" "$target_root/$patch_path.orig"
  done < <(patch_targets_for "$patch_file")
}

reset_patch_targets() {
  local patch_file
  local patch_name
  local patch_path
  local -a patch_targets=()

  while IFS= read -r patch_path; do
    [[ -n "$patch_path" ]] || continue
    patch_targets+=("$patch_path")
  done < <(
    {
      printf '%s\n' "${legacy_patch_targets[@]}"
      for patch_file in "${patch_files[@]}"; do
        patch_targets_for "$patch_file"
      done
    } | sort -u
  )

  if [[ ${#patch_targets[@]} -eq 0 ]]; then
    echo "error: --from-scratch could not find any target files in $patch_dir/*.patch" >&2
    exit 1
  fi

  echo "--from-scratch: reverting VSCode files touched by vimcode patches"
  printf '  %s\n' "${patch_targets[@]}"
  (cd "$target_root" && git checkout -- "${patch_targets[@]}")

  for patch_file in "${patch_files[@]}"; do
    patch_name=$(basename "$patch_file")

    case "$patch_name" in
      editor-vim-contribution.patch|workbench-vim-status.patch)
        continue
        ;;
    esac

    if (cd "$target_root" && git apply --check "$patch_file" >/dev/null 2>&1); then
      continue
    fi

    if (cd "$target_root" && git apply --reverse --check "$patch_file" >/dev/null 2>&1); then
      (cd "$target_root" && git apply --reverse "$patch_file")
      echo "--from-scratch: removed already-applied VSCode patch $patch_name"
      continue
    fi

    echo "--from-scratch: normalizing partially-applied VSCode patch $patch_name"
    (cd "$target_root" && git apply --reverse --reject "$patch_file" >/dev/null 2>&1) || true
    remove_reject_files_for "$patch_file"

    if ! (cd "$target_root" && git apply --check "$patch_file" >/dev/null 2>&1); then
      echo "error: could not normalize VSCode patch $patch_name" >&2
      echo "       Try checking out the target VSCode files manually, then re-run --from-scratch." >&2
      exit 1
    fi
  done
}

if [[ "$from_scratch" == true ]]; then
  reset_patch_targets
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

for patch_file in "${patch_files[@]}"; do
  apply_patch "$patch_file"
done
echo "Synced vim contribution to $target_vim_dir and $target_workbench_vim_dir"
