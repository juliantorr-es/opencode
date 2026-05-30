import re
import json


def extract_keys(file_path):
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
    keys = []
    regex = r'"([^"]+)"\s*:'
    for match in re.finditer(regex, content):
        keys.append(match.group(1))
    return keys


ar_keys = extract_keys(
    "/Users/user/Developer/GitHub/opencode-desktop-dev/packages/app/src/i18n/ar.ts"
)
en_keys = extract_keys(
    "/Users/user/Developer/GitHub/opencode-desktop-dev/packages/app/src/i18n/en.ts"
)

ar_keys.sort()
en_keys.sort()

print(f"=== AR KEYS ({len(ar_keys)}) ===")
print("\n".join(ar_keys))
print("")
print(f"=== EN KEYS ({len(en_keys)}) ===")
print("\n".join(en_keys))
print("")

en_set = set(en_keys)
ar_set = set(ar_keys)
missing = [k for k in en_keys if k not in ar_set]
extra = [k for k in ar_keys if k not in en_set]

print(f"=== MISSING in ar.ts ({len(missing)}) ===")
print("\n".join(missing))
print("")
print(f"=== EXTRA in ar.ts ({len(extra)}) ===")
print("\n".join(extra))
