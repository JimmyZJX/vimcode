#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/sync-vscode-contrib.sh [--from-scratch] /path/to/vscode

Copies the vimcode core and VSCode contribution prototype into a VSCode/code-oss
checkout. The target checkout is modified in-place.

The end state of every patched VSCode file is computed out-of-tree (pristine
HEAD content plus vimcode patches) and written back only when the content
actually differs, so files never pass through a reverted intermediate state
and a running VSCode watch sees at most one change per file.

Options:
  --from-scratch  Also overwrite patch targets whose current content is
                  unrecognized (it matches neither the pristine checkout nor
                  the expected patched state, e.g. after a vimcode patch was
                  reworked), and restore files touched by older vimcode
                  patches. This discards local edits to those files in the
                  target checkout.

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
  src/vs/editor/common/cursor/cursorMoveCommands.ts
  src/vs/editor/common/cursor/cursorWordOperations.ts
  src/vs/editor/common/cursorCommon.ts
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

patch_targets=()
while IFS= read -r patch_path; do
  [[ -n "$patch_path" ]] || continue
  patch_targets+=("$patch_path")
done < <(
  for patch_file in "${patch_files[@]}"; do
    patch_targets_for "$patch_file"
  done | sort -u
)

if [[ ${#patch_targets[@]} -eq 0 ]]; then
  echo "error: could not find any target files in $patch_dir/*.patch" >&2
  exit 1
fi

# Pristine copies of every patch target are staged here, patches are applied to
# the staged copies, and the result is written back only where it differs from
# the checkout.
staging_dir=$(mktemp -d -t vimcode-sync.XXXXXX)
trap 'rm -rf "$staging_dir"' EXIT

pristine_content_matches() {
  local patch_path=$1
  git -C "$target_root" diff --quiet HEAD -- "$patch_path"
}

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
  local editor_all=$1
  local import_line="import './contrib/vim/browser/vim.contribution.js';"
  if grep -Fqx "$import_line" "$editor_all"; then
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
}

ensure_workbench_import_patch() {
  local workbench_common=$1
  local import_line="import './contrib/vim/browser/vimStatus.js';"
  if grep -Fqx "$import_line" "$workbench_common"; then
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
}

# Stage the pristine (HEAD) content of every patch target.
for patch_path in "${patch_targets[@]}"; do
  mkdir -p "$staging_dir/$(dirname "$patch_path")"
  if ! git -C "$target_root" show "HEAD:$patch_path" > "$staging_dir/$patch_path" 2>/dev/null; then
    # File does not exist in HEAD; the patch is expected to create it.
    rm -f "$staging_dir/$patch_path"
  fi
done

# Compute the end state by applying every patch to the staged pristine copies.
for patch_file in "${patch_files[@]}"; do
  patch_name=$(basename "$patch_file")
  case "$patch_name" in
    editor-vim-contribution.patch)
      ensure_editor_import_patch "$staging_dir/src/vs/editor/editor.all.ts"
      ;;
    workbench-vim-status.patch)
      ensure_workbench_import_patch "$staging_dir/src/vs/workbench/workbench.common.main.ts"
      ;;
    *)
      if ! (cd "$staging_dir" && git apply "$patch_file"); then
        echo "error: VSCode patch $patch_name does not apply to the pristine checkout" >&2
        echo "       The patch likely needs rebasing onto this VSCode version." >&2
        exit 1
      fi
      ;;
  esac
done

# Write back only the files whose content differs from the computed end state.
for patch_path in "${patch_targets[@]}"; do
  staged="$staging_dir/$patch_path"
  current="$target_root/$patch_path"

  if [[ ! -f "$staged" ]]; then
    echo "error: staged end state for $patch_path is missing" >&2
    exit 1
  fi

  if [[ -f "$current" ]] && cmp -s "$staged" "$current"; then
    continue
  fi

  if [[ "$from_scratch" != true && -f "$current" ]] && ! pristine_content_matches "$patch_path"; then
    echo "error: $patch_path has local modifications that do not match the expected patched state" >&2
    echo "       Re-run with --from-scratch to overwrite it with the computed end state." >&2
    exit 1
  fi

  mkdir -p "$(dirname "$current")"
  cp "$staged" "$current"
  echo "Updated $patch_path"
done

if [[ "$from_scratch" == true ]]; then
  # Restore files that older versions of vimcode patches touched, and clean up
  # leftovers from older script versions that applied patches with --reject.
  for patch_path in "${legacy_patch_targets[@]}"; do
    case " ${patch_targets[*]} " in
      *" $patch_path "*) continue ;;
    esac
    [[ -f "$target_root/$patch_path" ]] || continue
    if pristine_content_matches "$patch_path"; then
      continue
    fi
    git -C "$target_root" show "HEAD:$patch_path" > "$target_root/$patch_path"
    echo "--from-scratch: restored legacy patch target $patch_path"
  done

  for patch_path in "${patch_targets[@]}" "${legacy_patch_targets[@]}"; do
    rm -f "$target_root/$patch_path.rej" "$target_root/$patch_path.orig"
  done
fi

echo "Synced vim contribution to $target_vim_dir and $target_workbench_vim_dir"
