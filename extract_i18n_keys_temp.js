const fs = require('fs');

function extractKeys(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const keys = [];
  const regex = /"([^"]+)"\s*:/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    keys.push(match[1]);
  }
  return keys;
}

const arKeys = extractKeys('/Users/user/Developer/GitHub/opencode-desktop-dev/packages/app/src/i18n/ar.ts');
const enKeys = extractKeys('/Users/user/Developer/GitHub/opencode-desktop-dev/packages/app/src/i18n/en.ts');

arKeys.sort();
enKeys.sort();

console.log('=== AR KEYS (' + arKeys.length + ') ===');
console.log(arKeys.join('\n'));
console.log('');
console.log('=== EN KEYS (' + enKeys.length + ') ===');
console.log(enKeys.join('\n'));
console.log('');

const enSet = new Set(enKeys);
const arSet = new Set(arKeys);
const missing = enKeys.filter(k => !arSet.has(k));
const extra = arKeys.filter(k => !enSet.has(k));

console.log('=== MISSING in ar.ts (' + missing.length + ') ===');
console.log(missing.join('\n'));
console.log('');
console.log('=== EXTRA in ar.ts (' + extra.length + ') ===');
console.log(extra.join('\n'));
