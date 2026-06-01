#!/bin/sh
cd /Users/user/Developer/GitHub/opencode-desktop-dev/packages/opencode
bun test test/campaign/pg-lifecycle-proof.test.ts > _test_output.txt 2>&1
echo "EXIT_CODE=$?" >> _test_output.txt
cat _test_output.txt
