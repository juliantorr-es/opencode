#!/bin/bash
# Guard: no raw .get/.all/.run on Drizzle query builders
# These were removed in drizzle-orm 1.0 — must use one/many/exec adapter
cd "$(dirname "$0")/.."

get_count=$(grep -rn "\.get()" src/ --include="*.ts" | grep -E "(select|from|where|innerJoin|leftJoin|rightJoin)" | grep -v "one(" | grep -v "config\.get\|cache\.get\|modelsDev\.get" | wc -l | tr -d ' ')
run_count=$(grep -rn "\.run()" src/ --include="*.ts" | grep -E "(insert|update|delete|returning|onConflictDoUpdate|onConflictDoNothing)" | wc -l | tr -d ' ')
all_count=$(grep -rn "\.all()" src/ --include="*.ts" | grep -E "(select|from|where)" | grep -v "auth\.all\|skill\.all\|env\.all\|providerSvc\.all" | wc -l | tr -d ' ')

if [ "$get_count" -gt 0 ] || [ "$run_count" -gt 0 ] || [ "$all_count" -gt 0 ]; then
  echo "FAIL: raw Drizzle APIs found: .get=$get_count .run=$run_count .all=$all_count"
  grep -rn "\.get()" src/ --include="*.ts" | grep -E "(select|from|where)" | grep -v "one("
  grep -rn "\.run()" src/ --include="*.ts" | grep -E "(insert|update|delete|returning)"
  grep -rn "\.all()" src/ --include="*.ts" | grep -E "(select|from|where)" | grep -v "auth\.all\|skill\.all"
  exit 1
fi
echo "OK: no raw Drizzle .get/.all/.run found"
