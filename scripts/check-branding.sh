#!/usr/bin/env bash
set -euo pipefail

# Branding guard — fails on public occurrences of "opencode" except allowlisted paths.
# Run: bash scripts/check-branding.sh

ALLOWLIST=(
  "NOTICE"
  "FORK.md"
  "docs/upstream.md"
  "LICENSE"
  "bun.lock"
  "packages/core/src/util/opencode-process.ts"
  "packages/core/test/util/effect-flock.test.ts"
  "packages/core/test/util/flock.test.ts"
  "packages/core/test/plugin/provider-opencode.test.ts"
  "packages/desktop/electron-builder.config.ts"
  "packages/desktop/src/main/constants.ts"
  "packages/core/test/plugin/provider-opencode.test.ts"
  "packages/opencode/"
  "packages/console/"
  "packages/stats/"
  "packages/web/"
  "packages/sdk/"
  "packages/slack/"
  "packages/plugin/"
  "packages/containers/"
  "packages/enterprise/"
  "packages/script/"
  "packages/function/"
  "packages/http-recorder/"
  "sdks/",
  "packages/app/src/pages/layout/deep-links.ts",
  "nix/"
  "flake.nix"
  "infra/"
  "patches/"
  "script/"
  "TYPECHECK_LEDGER.md"
  "perf/"
  "specs/"
  "github/"
  ".git/"
  "node_modules/"
  "banks/"
  ".opencode/"
  "*.db"
  "*.db-shm"
  "*.db-wal"
  "*.zip"
  "*.png"
  "*.svg"
  "*.ico"
  "*.icns"
  "*.snap"
)

PUBLIC_CONTEXTS=(
  "Tribunus"
  "tribunus"
)

FAILS=0
CHECKS=0

# Check key public-facing files for forbidden "opencode" branding
echo "=== Branding Guard ==="
echo ""

# Files that MUST NOT contain "opencode" in user-facing text
# Technical namespace references (OPENCODE_ env vars, repo URLs, code paths)
# are tracked separately in TECH_NAMESPACE_NEEDS_MIGRATION.
MUST_NOT_BRAND=(
  "README.md"
  "packages/app/index.html"
  "packages/desktop/package.json"
  "packages/app/src/components/windows-app-menu.tsx"
)

for file in "${MUST_NOT_BRAND[@]}"; do
  if [ -f "$file" ]; then
    if grep -i "opencode" "$file" 2>/dev/null | grep -v "@opencode-ai\|tribunus\|packages/opencode\|\.opencode/" > /dev/null 2>&1; then
      echo "FAIL: $file contains 'opencode' branding"
      grep -in "opencode" "$file" | grep -iv "@opencode-ai\|tribunus" | head -3
      FAILS=$((FAILS + 1))
    else
      echo "PASS: $file"
    fi
    CHECKS=$((CHECKS + 1))
  fi
done

echo ""
echo "Checks: $CHECKS, Failures: $FAILS"

if [ "$FAILS" -gt 0 ]; then
  echo ""
  echo "Branding violations found. Tribunus public identity must not reference 'opencode'."
  exit 1
fi

echo "Branding check passed."
