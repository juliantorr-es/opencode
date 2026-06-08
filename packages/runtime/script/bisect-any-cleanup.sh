#!/usr/bin/env bash
# bisect-any-cleanup.sh — Bisect which of N changed files broke typecheck
# Usage: ./script/bisect-any-cleanup.sh <base-ref>
# Example: ./script/bisect-any-cleanup.sh HEAD~1

set -euo pipefail
BASE="${1:-HEAD}"

cd "$(dirname "$0")/.."

# Get the list of changed .ts source files (not tests)
mapfile -t FILES < <(git diff --name-only "$BASE" -- src/ | grep '\.ts$' | grep -v '\.test\.ts$' || true)

if [ ${#FILES[@]} -eq 0 ]; then
  echo "No changed source files found vs $BASE"
  exit 0
fi

echo "=== Bisect target: ${#FILES[@]} files ==="
printf '  %s\n' "${FILES[@]}"
echo ""

# Restore all changed files to BASE to confirm baseline passes
echo "--- Restoring all to $BASE ---"
git checkout "$BASE" -- "${FILES[@]}"

echo "--- Baseline typecheck (expect pass) ---"
if bun typecheck; then
  echo "BASELINE: PASS"
else
  echo "BASELINE: FAIL — baseline is broken, aborting bisect"
  exit 1
fi

# Restore working tree changes
echo "--- Restoring working tree ---"
git checkout HEAD -- "${FILES[@]}"

echo "--- Full changeset typecheck ---"
if bun typecheck; then
  echo "FULL: PASS — all changes are correct, no bisect needed"
  exit 0
fi
echo "FULL: FAIL — bisecting..."

# Binary search over files
lo=0
hi=$((${#FILES[@]} - 1))

while [ "$lo" -le "$hi" ]; do
  mid=$(( (lo + hi) / 2 ))

  echo ""
  echo "=== Bisect round: testing files[0..$mid] (index 0 to $mid) ==="

  # Restore baseline for all files
  git checkout "$BASE" -- "${FILES[@]}"

  # Apply only first mid+1 files from working tree
  if [ "$mid" -ge 0 ]; then
    git checkout HEAD -- "${FILES[@]:0:$((mid + 1))}"
  fi

  echo "Active files:"
  for ((i=0; i<=mid; i++)); do
    echo "  + ${FILES[$i]}"
  done

  if bun typecheck; then
    echo "PASS — bug is in files[$((mid + 1))..$hi]"
    lo=$((mid + 1))
  else
    echo "FAIL — bug is in files[0..$mid]"
    hi=$((mid - 1))
  fi
done

# Restore full working tree
git checkout HEAD -- "${FILES[@]}"

echo ""
echo "=== Faulty file: ${FILES[$lo]} ==="
echo "Inspect this file's changes vs $BASE:"
echo "  git diff $BASE -- ${FILES[$lo]}"
echo ""
echo "To see only the type annotation changes:"
echo "  git diff $BASE -- ${FILES[$lo]} | rg 'any'"
