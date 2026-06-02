#!/usr/bin/env bash
set -euo pipefail

# Branding guard — fails on public occurrences of "opencode" except allowlisted paths.
# Run from repo root: bash scripts/check-branding.sh

cd "$(dirname "$0")/.."

FAILS=0
CHECKS=0

echo "=== Branding Guard ==="
echo ""

# Files that MUST NOT contain "opencode" in user-facing text
MUST_NOT_BRAND=(
  "README.md"
  "packages/app/index.html"
  "packages/desktop/package.json"
  "packages/app/src/components/windows-app-menu.tsx"
)

for file in "${MUST_NOT_BRAND[@]}"; do
  if [ ! -f "$file" ]; then
    continue
  fi
  CHECKS=$((CHECKS + 1))
  matches="$(grep -in "opencode" "$file" 2>/dev/null | grep -iv "tribunus\|@opencode-ai\|packages/opencode\|\.opencode" || true)"
  if [ -n "$matches" ]; then
    echo "FAIL: $file contains 'opencode' branding"
    echo "$matches" | head -3
    FAILS=$((FAILS + 1))
  else
    echo "PASS: $file"
  fi
done

echo ""
echo "Checks: $CHECKS, Failures: $FAILS"

# Legacy inventory (informational only)
echo ""
echo "=== Legacy .opencode/ Inventory ==="
if [ -d ".opencode" ]; then
  echo "Legacy .opencode/ directory exists (read-only, deprecated)"
  find .opencode -type f -not -path "*/.git/*" -not -name "README.md" 2>/dev/null | sort | while read -r f; do
    echo "  [legacy] $f"
  done
else
  echo "No legacy .opencode/ directory — clean."
fi

echo ""

if [ "$FAILS" -gt 0 ]; then
  echo "Branding violations found. Tribunus public identity must not reference 'opencode'."
  exit 1
fi

echo "Branding check passed."
