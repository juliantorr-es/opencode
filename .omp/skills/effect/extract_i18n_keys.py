import re

PL_PATH = "packages/app/src/i18n/pl.ts"
EN_PATH = "packages/app/src/i18n/en.ts"

KEY_RE = re.compile(r'"([^"]+)"\s*:')

def extract_keys(filepath):
    keys = []
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line == "export const dict = {" or line == "}":
                continue
            m = KEY_RE.search(line)
            if m:
                keys.append(m.group(1))
    return sorted(keys)

pl_keys = extract_keys(PL_PATH)
en_keys = extract_keys(EN_PATH)

set_pl = set(pl_keys)
set_en = set(en_keys)
missing = sorted(set_en - set_pl)
extra = sorted(set_pl - set_en)
shared = sorted(set_pl & set_en)

def print_key_list(label, keys):
    print(f"\n{'='*70}")
    print(f"  {label} ({len(keys)} total)")
    print(f"{'='*70}")
    for i, k in enumerate(keys, 1):
        print(f"  {i:>4}. {k}")

print(f"{'='*70}")
print(f"  pl.ts: {len(pl_keys)} keys total")
print(f"  en.ts: {len(en_keys)} keys total")
print(f"{'='*70}\n")

print_key_list("ALL KEYS IN pl.ts", pl_keys)
print_key_list("ALL KEYS IN en.ts", en_keys)

print(f"\n{'='*70}")
print(f"  MISSING KEYS (in en.ts but NOT in pl.ts) - {len(missing)}")
print(f"{'='*70}")
if missing:
    for k in missing:
        print(f"  * {k}")
else:
    print("  (none)")

print(f"\n{'='*70}")
print(f"  EXTRA KEYS (in pl.ts but NOT in en.ts) - {len(extra)}")
print(f"{'='*70}")
if extra:
    for k in extra:
        print(f"  * {k}")
else:
    print("  (none)")

print(f"\n{'='*70}")
print(f"  SUMMARY")
print(f"{'='*70}")
print(f"  pl.ts keys:            {len(pl_keys)}")
print(f"  en.ts keys:            {len(en_keys)}")
print(f"  Missing (en->pl):       {len(missing)}")
print(f"  Extra (pl->en):         {len(extra)}")
print(f"  Intersection (shared): {len(shared)}")
print(f"{'='*70}")
