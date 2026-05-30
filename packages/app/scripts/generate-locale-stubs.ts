import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs"
import { join, parse } from "path"
import { fileURLToPath } from "url"

const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = scriptPath.slice(0, scriptPath.lastIndexOf("/"))
const I18N_DIR = join(scriptDir, "..", "src", "i18n")
const EN_FILE = join(I18N_DIR, "en.ts")

function extractKeys(content: string): string[] {
  const keys: string[] = []
  for (const line of content.split("\n")) {
    const match = line.match(/^\s+"([^"]+)":/)
    if (match) keys.push(match[1])
  }
  return keys
}

// Read English keys
const enContent = readFileSync(EN_FILE, "utf-8")
const enKeys = extractKeys(enContent)
console.log(`English locale: ${enKeys.length} keys\n`)

const EXCLUDE_FILES = new Set([
  "en.ts",
  "coverage.test.ts",
  "parity.test.ts",
  "fallback.test.ts",
  "format.ts",
  "plural.ts",
])

const allFiles = readdirSync(I18N_DIR)
  .filter((f) => f.endsWith(".ts") && !EXCLUDE_FILES.has(f))
  .sort()

let totalStubsAdded = 0

for (const file of allFiles) {
  const filePath = join(I18N_DIR, file)

  if (!existsSync(filePath)) {
    console.error(`  ${file}: not found, skipping`)
    continue
  }

  const content = readFileSync(filePath, "utf-8")
  const existingKeys = extractKeys(content)
  const existingKeySet = new Set(existingKeys)

  const missingKeys = enKeys.filter((k) => !existingKeySet.has(k))
  if (missingKeys.length === 0) {
    console.log(`  ${file}: up to date (${existingKeys.length} keys)`)
    continue
  }

  const localeCode = parse(file).name.toUpperCase()

  // Generate stubs, preserving en.ts sort order
  const stubs = missingKeys.map((k) => `  "${k}": "[${localeCode}]"`)

  // Find the closing brace of the dict on its own line
  const closeMatch = content.match(/\n}\n?$/)
  if (!closeMatch) {
    console.error(`  ${file}: cannot find closing brace, skipping`)
    continue
  }

  const insertionPoint = closeMatch.index! + 1 // position of `}`
  const pre = content.slice(0, insertionPoint) // includes trailing newline
  const post = content.slice(insertionPoint) // `}\n`

  const newContent = pre + stubs.join(",\n") + ",\n" + post

  writeFileSync(filePath, newContent)

  const newCount = existingKeys.length + missingKeys.length
  const pct = ((newCount / enKeys.length) * 100).toFixed(1)
  console.log(
    `  ${file}: +${missingKeys.length} stubs (${existingKeys.length} → ${newCount} keys, ${pct}% coverage)`,
  )
  totalStubsAdded += missingKeys.length
}

console.log(
  `\nDone: ${totalStubsAdded} stubs generated across ${allFiles.length} locale files`,
)
