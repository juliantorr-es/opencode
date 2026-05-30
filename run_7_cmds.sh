#!/bin/bash
echo "=== CMD 1: git ls-files --error-unmatch packages/app/src/i18n/en.ts ==="
git ls-files --error-unmatch packages/app/src/i18n/en.ts 2>&1
echo ""
echo "=== CMD 2: git status --short packages/app/src/i18n/en.ts ==="
git status --short packages/app/src/i18n/en.ts 2>&1
echo ""
echo "=== CMD 3: git ls-files packages/app/src/i18n/en.ts ==="
git ls-files packages/app/src/i18n/en.ts 2>&1
echo ""
echo "=== CMD 4: git check-ignore -v packages/app/src/i18n/en.ts ==="
git check-ignore -v packages/app/src/i18n/en.ts 2>&1
echo ""
echo "=== CMD 5: cat packages/app/src/i18n/en.ts | wc -l ==="
cat packages/app/src/i18n/en.ts | wc -l 2>&1
echo ""
echo "=== CMD 6: ls -la packages/app/src/i18n/en.ts ==="
ls -la packages/app/src/i18n/en.ts 2>&1
echo ""
echo "=== CMD 7: git show HEAD:packages/app/src/i18n/en.ts | head -5 ==="
git show HEAD:packages/app/src/i18n/en.ts | head -5 2>&1
