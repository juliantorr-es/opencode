#!/usr/bin/env python3
"""Compare i18n keys between en.ts and ko.ts."""

import subprocess

rg_args = ["rg", r'^\s+"([a-z][a-z.-]+[a-z])"\s*:', "-o", "-N", "-r", "$1"]
base = "/Users/user/Developer/GitHub/opencode-desktop-dev/packages/app/src/i18n"

r1 = subprocess.run(rg_args + [f"{base}/en.ts"], capture_output=True, text=True)
r2 = subprocess.run(rg_args + [f"{base}/ko.ts"], capture_output=True, text=True)

en_keys = set(r1.stdout.strip().split("\n"))
ko_keys = set(r2.stdout.strip().split("\n"))

en_sorted = sorted(en_keys)
ko_sorted = sorted(ko_keys)

print("en.ts dots:")
print(len(en_sorted))
print()

print("ko.ts dots:")
print(len(ko_sorted))
print()

missing = sorted(en_keys - ko_keys)
print("MISSING from ko.ts:")
for k in missing:
    print(k)
print("Count:")
print(len(missing))
print()

extras = sorted(ko_keys - en_keys)
print("EXTRAS in ko.ts:")
for k in extras:
    print(k)
print("Count:")
print(len(extras))
