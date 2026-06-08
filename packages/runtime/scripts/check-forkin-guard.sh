#!/bin/bash
# Guard: no raw Effect.forkIn in instance lifecycle code
# All instance-owned work must go through InstanceRuntime.fork
cd "$(dirname "$0")/.."

# Sensitive paths where raw forkIn is forbidden
SENSITIVE_PATHS=(
  "src/project/instance-store.ts"
  "src/project/bootstrap.ts"
  "src/project/instance-layer.ts"
  "src/tool/registry.ts"
  "src/tool/tool.ts"
  "src/plugin/"
)

violations=0
for path in "${SENSITIVE_PATHS[@]}"; do
  found=$(grep -rn "Effect\.forkIn\|forkIn(" "$path" --include="*.ts" 2>/dev/null | grep -v "InstanceRuntime\|forkInstance\|ALLOWED")
  if [ -n "$found" ]; then
    echo "$found"
    violations=$((violations + 1))
  fi
done

if [ "$violations" -gt 0 ]; then
  echo "FAIL: $violations raw forkIn call(s) found in lifecycle paths"
  exit 1
fi

echo "OK: no raw forkIn in lifecycle paths"
