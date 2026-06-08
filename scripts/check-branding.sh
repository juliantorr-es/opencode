#!/usr/bin/env bash
set -euo pipefail

# Tribunus Branding Boundary Guard
# Run from repo root: bash scripts/check-branding.sh

cd "$(dirname "$0")/.."

FAILS=0
CHECKS=0

echo "=== Tribunus Branding Guard ==="
echo ""

# 1. USER_FACING_MUST_BE_TRIBUNUS Checks
# These files MUST NOT contain user-visible "opencode" branding references.
USER_FACING_FILES=(
  "README.md"
  "packages/app/index.html"
  "packages/app/src/components/windows-app-menu.tsx"
)

for file in "${USER_FACING_FILES[@]}"; do
  if [ ! -f "$file" ]; then
    continue
  fi
  CHECKS=$((CHECKS + 1))
  # Ignore internal namespaces like packages/opencode or @opencode-ai in these files if any
  matches="$(grep -in "opencode" "$file" 2>/dev/null | grep -iv "tribunus\|@opencode-ai\|packages/opencode\|\.opencode\|x-opencode-directory" || true)"
  if [ -n "$matches" ]; then
    echo "FAIL: $file contains unauthorized 'opencode' branding"
    echo "$matches" | head -3
    FAILS=$((FAILS + 1))
  else
    echo "PASS: User-Facing check for $file"
  fi
done

# Special check for packages/desktop/package.json (allow package namespaces but fail on description branding)
if [ -f "packages/desktop/package.json" ]; then
  CHECKS=$((CHECKS + 1))
  # Check only the name, description, author, homepage etc. fields (excluding dependencies block)
  meta_matches="$(grep -in '"name"\|"description"\|"author"\|"homepage"' packages/desktop/package.json | grep -in "opencode" || true)"
  if [ -n "$meta_matches" ]; then
    echo "FAIL: packages/desktop/package.json contains 'opencode' in package metadata fields"
    echo "$meta_matches"
    FAILS=$((FAILS + 1))
  else
    echo "PASS: User-Facing check for packages/desktop/package.json"
  fi
fi

echo ""
echo "Enforcement Phase Complete: $CHECKS checks run, $FAILS failures."
echo ""

# 2. DIAGNOSTIC_ONLY_OPENCODE Inventory
# Report remaining occurrences of opencode by classification category, without failing the script.
echo "=== Allowed Compatibility / Upstream References ==="

# Count package scopes
pkg_scopes=$(grep -rni '"@opencode-ai/' --include="package.json" packages/ 2>/dev/null | wc -l || echo "0")
echo "  [COMPATIBILITY] @opencode-ai/* package scope dependency declarations: $pkg_scopes references"

# Count environment variables
env_vars=$(grep -rn "OPENCODE_" --exclude-dir={node_modules,.git,.opencode} --include="*.ts" --include="*.md" . 2>/dev/null | wc -l || echo "0")
echo "  [COMPATIBILITY] OPENCODE_* environment variable usages: $env_vars references"

# Count header references
headers=$(grep -rn "x-opencode-directory" --exclude-dir={node_modules,.git,.opencode} --include="*.ts" --include="*.md" . 2>/dev/null | wc -l || echo "0")
echo "  [COMPATIBILITY] x-opencode-directory header references: $headers references"

# Count file format names
file_formats=$(grep -rn "\.opencode-session" --exclude-dir={node_modules,.git,.opencode} . 2>/dev/null | wc -l || echo "0")
echo "  [COMPATIBILITY] .opencode-session file format references: $file_formats references"

# Count upstream attribution notices
attributions=$(grep -rin "github.com/sst/opencode" NOTICE.md 2>/dev/null | wc -l || echo "0")
echo "  [UPSTREAM] sst/opencode upstream notices in NOTICE.md: $attributions references"

echo ""

if [ "$FAILS" -gt 0 ]; then
  echo "Branding violations found in user-facing surfaces. Tribunus public identity must not reference 'opencode'."
  exit 1
fi

echo "Branding check passed."
