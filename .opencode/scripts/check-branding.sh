#!/usr/bin/env bash
set -euo pipefail

# Branding guard — fails on public occurrences of "opencode" except allowlisted paths.
# Allowlisted paths are documented in docs/branding/tribunus-branding-allowlist.md
# Run: bash scripts/check-branding.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

# ── Allowlist ────────────────────────────────────────────────────────────────
# Each entry is one of:
#   "path/to/file"     — exact file match
#   "dir/"             — any file under that directory
#   "*.ext"            — any file with that extension (basename glob)
# See docs/branding/tribunus-branding-allowlist.md for rationale.
ALLOWLIST=(
  # Legal / Upstream Attribution
  "NOTICE.md"
  "LICENSE"
  "FORK.md"
  "docs/upstream.md"

  # Temporary Compatibility Shim
  "packages/core/src/global.ts"
  "packages/desktop/src/main/app-data-paths.ts"
  "packages/desktop/electron-builder.config.ts"
  "packages/desktop/src/main/constants.ts"

  # Internal Package Paths (deferred rename)
  "packages/opencode/"
  "packages/core/src/util/opencode-process.ts"
  "packages/core/src/plugin/provider/opencode.ts"
  "packages/core/test/plugin/provider-opencode.test.ts"
  "packages/core/test/util/effect-flock.test.ts"
  "packages/core/test/util/flock.test.ts"

  # Console / Stats / Web legacy packages
  "packages/console/"
  "packages/stats/"
  "packages/web/"
  "packages/sdk/"
  "packages/slack/"
  "packages/plugin/"

  # Infrastructure / CI / Nix
  "infra/"
  "nix/"
  "flake.nix"
  "github/"
  ".github/"
  "script/"
  "patches/"
  "sdks/"
  "specs/"

  # Build artifacts / internal tooling
  "bun.lock"
  "TYPECHECK_LEDGER.md"
  "perf/"
  ".build/"
  "docs/"
  "packages/docs/"
  "packages/extensions/"

  # Legacy / workspace artifacts
  "packages/containers/"
  "packages/enterprise/"
  "packages/script/"
  "packages/function/"
  "packages/http-recorder/"
  "*.db"
  "*.db-shm"
  "*.db-wal"
  "*.zip"
  "*.png"
  "*.svg"
  "*.ico"
  "*.icns"
  "*.snap"

  # Internal .opencode working directory (configuration, not product code)
  ".opencode/"

  # Sparse checkout / workspace markers
  ".git/"
  "node_modules/"
)

# ── Public-surface globs (user-facing files scrutinized for opencode) ────────
PUBLIC_SURFACE_GLOBS=(
  # Top-level docs — user sees these first
  "README.md"
  "README.*.md"
  "INSTALL.md"
  "INDEX.md"
  "PROJECT.md"
  "CONTRIBUTING.md"
  "AGENTS.md"
  "LEAFS.md"
  "SECURITY.md"

  # Package manifests — user-facing metadata
  "packages/app/package.json"
  "packages/desktop/package.json"
  "packages/core/package.json"
  "packages/llm/package.json"
  "packages/ui/package.json"
  "packages/storybook/package.json"

  # Entry HTML — what the user loads
  "packages/app/index.html"
  "packages/app/dist/index.html"
  "packages/desktop/src/renderer/index.html"
  "packages/desktop/src/renderer/loading.html"
  "packages/desktop/src/renderer/safe-mode.html"
  "packages/desktop/out/renderer/index.html"
  "packages/desktop/out/renderer/loading.html"

  # Web manifests
  "packages/app/public/site.webmanifest"
  "packages/app/dist/site.webmanifest"
  "packages/desktop/out/renderer/site.webmanifest"

  # Electron app metadata
  "packages/desktop/resources/*.xml"

  # UI source — menus, titles, user-visible strings
  "packages/app/src/components/windows-app-menu.tsx"
  "packages/app/src/components/titlebar.tsx"
  "packages/app/src/components/status-popover.tsx"
  "packages/app/src/components/status-popover-body.tsx"
  "packages/app/src/components/dialog-release-notes.tsx"
  "packages/app/src/components/dialog-onboarding.tsx"
  "packages/app/src/components/dialog-settings.tsx"
  "packages/app/src/components/dialog-edit-project.tsx"
  "packages/app/src/components/dialog-export.tsx"
  "packages/app/src/components/dialog-import.tsx"
  "packages/app/src/pages/home.tsx"
  "packages/app/src/pages/error.tsx"
  "packages/app/src/pages/layout.tsx"
  "packages/app/src/pages/layout/deep-links.ts"
  "packages/app/src/desktop-menu.ts"
  "packages/app/src/entry.tsx"
  "packages/app/src/app.tsx"

  # Desktop main process — window titles, app identity
  "packages/desktop/src/main/windows.ts"
  "packages/desktop/src/main/menu.ts"
  "packages/desktop/src/main/menu-help.ts"
  "packages/desktop/src/main/index.ts"

  # I18n — all user-visible strings
  "packages/app/src/i18n/*.ts"
  "packages/desktop/src/renderer/i18n/*.ts"
  "packages/ui/src/i18n/*.ts"

  # Desktop build config
  "packages/desktop/package.json"

  # Root config files
  "package.json"
  "opencode.jsonc"
  "turbo.json"
  "sst.config.ts"
)

# ── Helpers ──────────────────────────────────────────────────────────────────

# Check if a path matches any allowlist entry.
is_allowlisted() {
  local path="$1"
  for pattern in "${ALLOWLIST[@]}"; do
    # Directory pattern — path starts with it
    if [[ "$pattern" == */ ]] && [[ "$path" == "$pattern"* ]]; then
      return 0
    fi
    # Basename wildcard — e.g. "*.snap" (no slash in pattern)
    if [[ "$pattern" == *\** && "$pattern" != */* ]] && [[ "$(basename "$path")" == $pattern ]]; then
      return 0
    fi
    # Exact file match
    if [[ "$path" == "$pattern" ]]; then
      return 0
    fi
  done
  return 1
}

# ── Scan ─────────────────────────────────────────────────────────────────────

echo "=== Branding Guard ==="

shopt -s nullglob globstar 2>/dev/null || true

declare -a VIOLATION_FILES=()
declare -a CHECKED_FILES=()
declare -a ALLOWED_FILES=()

# Phase 1: Scan public-surface files for "opencode" violations
for glob in "${PUBLIC_SURFACE_GLOBS[@]}"; do
  for file in $glob; do
    [[ -f "$file" ]] || continue
    # Skip allowlisted files
    if is_allowlisted "$file"; then
      ALLOWED_FILES+=("$file")
      continue
    fi
    # Check if file contains "opencode" (case-insensitive)
    if grep -qIi "opencode" "$file" 2>/dev/null; then
      VIOLATION_FILES+=("$file")
    else
      CHECKED_FILES+=("$file")
    fi
  done
done

# Phase 2: Count allowlisted files that contain "opencode" (for info)
ALLOWED_OPENCODE_COUNT=0
for f in "${ALLOWED_FILES[@]}"; do
  if grep -qIi "opencode" "$f" 2>/dev/null; then
    ALLOWED_OPENCODE_COUNT=$((ALLOWED_OPENCODE_COUNT + 1))
  fi
done

# Also scan for standalone allowlisted files that may not be in public-surface globs
STANDALONE_ALLOWED=(
  "NOTICE.md"
  "LICENSE"
  "FORK.md"
  "packages/core/src/global.ts"
  "packages/desktop/src/main/app-data-paths.ts"
  "packages/desktop/electron-builder.config.ts"
  "packages/desktop/src/main/constants.ts"
  "packages/core/src/util/opencode-process.ts"
  "packages/core/src/plugin/provider/opencode.ts"
  "packages/core/test/plugin/provider-opencode.test.ts"
  "packages/core/test/util/effect-flock.test.ts"
  "packages/core/test/util/flock.test.ts"
  "bun.lock"
  "flake.nix"
  "TYPECHECK_LEDGER.md"
)
for f in "${STANDALONE_ALLOWED[@]}"; do
  if [[ -f "$f" ]] && grep -qIi "opencode" "$f" 2>/dev/null; then
    # only count if not already seen
    ALREADY=0
    for seen in "${ALLOWED_FILES[@]}"; do
      [[ "$seen" == "$f" ]] && ALREADY=1 && break
    done
    [[ $ALREADY -eq 0 ]] && ALLOWED_OPENCODE_COUNT=$((ALLOWED_OPENCODE_COUNT + 1))
  fi
done

# Also count opencode in dir-prefix allowlisted paths
DIR_ALLOWLIST=(
  "packages/opencode/"
  "packages/console/"
  "packages/stats/"
  "packages/web/"
  "packages/sdk/"
  "packages/slack/"
  "packages/plugin/"
  "infra/"
  "nix/"
  ".github/"
  "script/"
  "patches/"
  "sdks/"
  "specs/"
  "perf/"
  ".build/"
  "packages/containers/"
  "packages/enterprise/"
  "packages/script/"
  "packages/function/"
  "packages/http-recorder/"
  "docs/"
  "packages/docs/"
  "packages/extensions/"
  ".opencode/"
)
for dir in "${DIR_ALLOWLIST[@]}"; do
  if [[ -d "$dir" ]]; then
    count=$(grep -rlI -i "opencode" "$dir" 2>/dev/null | wc -l | tr -d ' ')
    ALLOWED_OPENCODE_COUNT=$((ALLOWED_OPENCODE_COUNT + count))
  fi
done

shopt -u nullglob globstar 2>/dev/null || true

PUBLIC_SURFACE_CHECKED=${#CHECKED_FILES[@]}
VIOLATIONS=${#VIOLATION_FILES[@]}

# ── Report ───────────────────────────────────────────────────────────────────

echo "$PUBLIC_SURFACE_CHECKED public-surface files checked: PASS"
echo "$ALLOWED_OPENCODE_COUNT allowed patterns found (per tribunus-branding-allowlist.md)"
echo "$VIOLATIONS violations"

if [ "$VIOLATIONS" -gt 0 ]; then
  echo ""
  for f in "${VIOLATION_FILES[@]}"; do
    echo "VIOLATION: $f"
  done
  echo ""
  echo "Branding violations found. Tribunus public identity must not reference 'opencode'."
  exit 1
fi

echo "Branding check passed."
