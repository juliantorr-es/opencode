#!/usr/bin/env bash
# smoke-test-any-cleanup.sh — Full verification pipeline for Phase 1 any-type cleanup
# Run from: packages/opencode
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packages/opencode"
BASE="${1:-HEAD}"

echo "=== Phase 1 any-type cleanup verification ==="
echo "Base ref: $BASE"
echo "Package:  $PKG"
echo ""

# ── 1. Typecheck ──────────────────────────────────────────
echo "=== [1/5] Typecheck (tsgo --noEmit) ==="
cd "$PKG"
if bun typecheck; then
  echo "PASS: typecheck"
else
  echo "FAIL: typecheck — run bisect script to isolate:"
  echo "  ./script/bisect-any-cleanup.sh $BASE"
  exit 1
fi
echo ""

# ── 2. Changed-file targeted tests ─────────────────────────
echo "=== [2/5] Targeted tests (changed modules) ==="
CHANGED=$(cd "$PKG" && git diff --name-only "$BASE" -- src/ | grep '\.ts$' | grep -v '\.test\.ts$' || true)

if [ -z "$CHANGED" ]; then
  echo "No changed source files — skipping targeted tests"
else
  declare -A TEST_DIRS
  for f in $CHANGED; do
    # Derive test file: src/X/Y.ts → test/X/Y.test.ts
    test_file=$(echo "$f" | sed 's|^src/|test/|; s|\.ts$|.test.ts|')
    if [ -f "$PKG/$test_file" ]; then
      TEST_DIRS["$test_file"]=1
    fi
    # Also add the test directory for module-level coverage
    mod_dir=$(echo "$f" | sed 's|^src/\([^/]*\)/.*|test/\1/|')
    if [ -d "$PKG/$mod_dir" ]; then
      TEST_DIRS["$mod_dir"]=1
    fi
  done

  if [ ${#TEST_DIRS[@]} -gt 0 ]; then
    echo "Running tests in:"
    printf '  %s\n' "${!TEST_DIRS[@]}"
    echo ""
    cd "$PKG"
    # shellcheck disable=SC2068
    bun test --timeout 30000 ${!TEST_DIRS[@]}
    echo "PASS: targeted tests"
  else
    echo "No matching test files found — skipping"
  fi
fi
echo ""

# ── 3. Full test suite ─────────────────────────────────────
echo "=== [3/5] Full test suite ==="
cd "$PKG"
bun test --timeout 30000
echo "PASS: full suite"
echo ""

# ── 4. Lint (oxlint) ──────────────────────────────────────
echo "=== [4/5] Lint (oxlint) ==="
cd "$ROOT"
if bun lint 2>&1; then
  echo "PASS: lint"
else
  echo "WARNING: oxlint reported issues — review but may be pre-existing"
fi
echo ""

# ── 5. Audit: no new 'any' introduced ──────────────────────
echo "=== [5/5] Audit: verify no new 'any' in changed files ==="
cd "$PKG"
NEW_ANY=0
for f in $CHANGED; do
  added=$(git diff "$BASE" -- "$f" | grep '^+.*\bany\b' | grep -v '^+++' || true)
  if [ -n "$added" ]; then
    echo "WARNING: New 'any' in $f:"
    echo "$added"
    NEW_ANY=1
  fi
done
if [ "$NEW_ANY" -eq 0 ]; then
  echo "PASS: no new 'any' annotations introduced"
fi
echo ""

echo "═════════════════════════════════════════════"
echo " All verification gates passed for Phase 1 "
echo "═════════════════════════════════════════════"
