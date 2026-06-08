#!/bin/bash
# Guard: no timestamp-like columns using integer() where bigint is needed.
# JS-millisecond timestamps overflow PostgreSQL integer (max ~2.1 billion).
cd "$(dirname "$0")/.."

# Timestamp column names that must NOT use integer()
TIMESTAMP_PATTERNS='created_at|updated_at|deleted_at|expires_at|released_at|claimed_at|token_expiry|completed_at|started_at|heartbeat_at|last_seen'

violations=$(grep -rn "integer()" src/ --include="*.ts" | grep -iE "$TIMESTAMP_PATTERNS" | grep -v "bigint")

if [ -n "$violations" ]; then
  echo "FAIL: integer() used on timestamp column(s):"
  echo "$violations"
  exit 1
fi

echo "OK: no integer() on timestamp columns"
