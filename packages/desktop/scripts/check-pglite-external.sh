#!/bin/bash
# Guard: @electric-sql/pglite MUST be externalized in the Electron sidecar bundle.
# Bundling PGlite breaks import.meta.url asset resolution for its WASM/data files.
# See electron.vite.config.ts for the full explanation.
cd "$(dirname "$0")/.."

CONFIG="electron.vite.config.ts"
if [ ! -f "$CONFIG" ]; then
  echo "SKIP: $CONFIG not found (not in desktop packaging context)"
  exit 0
fi

if grep -q '"@electric-sql/pglite"' "$CONFIG"; then
  echo "OK: PGlite is externalized in electron.vite.config.ts"
else
  echo "FAIL: @electric-sql/pglite must be in externalizeDeps.include in $CONFIG"
  echo "Reason: bundling PGlite breaks import.meta.url asset resolution for postgres.wasm/postgres.data"
  exit 1
fi
