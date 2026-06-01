#!/bin/sh
cd /Users/user/Developer/GitHub/opencode-desktop-dev/packages/opencode
npx tsgo --noEmit > typecheck_full_output.txt 2>&1
echo "EXIT_CODE: $?"
echo "TOTAL_LINES: $(wc -l < typecheck_full_output.txt)"
