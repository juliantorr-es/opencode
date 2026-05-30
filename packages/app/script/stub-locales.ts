#!/usr/bin/env bun
/**
 * stub-locales.ts — Auto-generate stub entries for missing locale keys
 *
 * Reads en.ts (source of truth), compares each locale file, and inserts
 * missing keys with `[LOCALE_CODE]` markers so the app is immediately
 * usable. Translators can find and replace `[da]`, `[de]`, etc. later.
 *
 * Usage:
 *   bun run packages/app/script/stub-locales.ts
 *   bun run --cwd packages/app script/stub-locales.ts
 *
 * Guardrails:
 *   - Does NOT modify existing translation values
 *   - Does NOT touch parity.test.ts or any non-locale files
 *   - Only adds, never removes or changes
 */

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

const I18N_DIR = join(import.meta.dir, "..", "src", "i18n");

/** Files in i18n/ that are NOT locale dictionaries */
const SKIP_FILES = new Set([
  "en.ts",
  "format.ts",
  "plural.ts",
  "parity.test.ts",
  "fallback.test.ts",
]);

/**
 * Extract all dictionary keys from a locale file.
 * Matches lines like:   "key.name": "value",
 */
function extractKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^\s+"([^"]+)":/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/**
 * Derive the locale code from the filename.
 * da.ts → da, zht.ts → zht, en.ts → en
 */
function localeCode(filename: string): string {
  return basename(filename, ".ts");
}

async function main() {
  // ── 1. Read English source of truth ────────────────────────────────
  const enFile = join(I18N_DIR, "en.ts");
  const enContent = await Bun.file(enFile).text();
  const enKeys = extractKeys(enContent);
  const enKeySet = new Set(enKeys);

  console.log(`\n  en.ts: ${enKeys.length} keys (source of truth)\n`);

  // ── 2. List locale files ───────────────────────────────────────────
  const files = readdirSync(I18N_DIR)
    .filter((f) => f.endsWith(".ts") && !SKIP_FILES.has(f))
    .sort();

  console.log(`  ${files.length} locale files to check\n`);

  let totalStubs = 0;
  let localesWithGaps = 0;
  let unchangedCount = 0;

  // ── 3. Process each locale ─────────────────────────────────────────
  for (const file of files) {
    const code = localeCode(file);
    const filePath = join(I18N_DIR, file);
    const content = await Bun.file(filePath).text();
    const existingKeys = extractKeys(content);
    const existingSet = new Set(existingKeys);

    // Find keys present in en.ts but missing from this locale
    const missing = enKeys.filter((k) => !existingSet.has(k));

    if (missing.length === 0) {
      console.log(`  ✓ ${file} — ${existingKeys.length} keys, none missing`);
      unchangedCount++;
      continue;
    }

    localesWithGaps++;
    totalStubs += missing.length;

    console.log(
      `  Δ ${file} — ${existingKeys.length} existing, ${missing.length} missing`
    );

    // Generate stub lines, sorted alphabetically
    const stubLines = missing
      .sort()
      .map((k) => `  "${k}": "[${code}]",  // TODO: translate`);

    // ── 4. Insert stubs before the closing `}` ──────────────────────
    const lines = content.split("\n");

    // Find the last line that is exactly `}` (trimmed)
    let closeIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() === "}") {
        closeIdx = i;
        break;
      }
    }

    if (closeIdx === -1) {
      console.error(`  ✗ ERROR: Cannot find closing brace in ${file}`);
      continue;
    }

    const before = lines.slice(0, closeIdx);
    const after = lines.slice(closeIdx);
    const newLines = [...before, ...stubLines, ...after];

    await Bun.write(filePath, newLines.join("\n"));

    // Log first 3 stubs as sample
    const sample = stubLines.slice(0, 3).map((l) => l.trim()).join(", ");
    console.log(`    → ${stubLines.length} stubs added (e.g. ${sample}${stubLines.length > 3 ? ", …" : ""})`);
  }

  // ── 5. Summary ─────────────────────────────────────────────────────
  console.log(`\n  ─────────────────────────────────────`);
  console.log(`  ${files.length} locales checked`);
  console.log(`  ${localesWithGaps} locales needed stubs`);
  console.log(`  ${unchangedCount} locales already complete`);
  console.log(`  ${totalStubs} total stubs generated`);
  console.log(`  ─────────────────────────────────────`);

  if (totalStubs === 0) {
    console.log(`  ✓ All locales up to date with en.ts`);
  } else {
    console.log(`  Run parity tests to verify: bun test --cwd packages/app`);
  }
}

await main();
