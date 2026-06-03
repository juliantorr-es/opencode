/**
 * IPC Authority Check
 * Fails if any source file calls ipcMain.handle outside approved modules.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const ALLOWED_FILES = new Set([
  "ipc-registration.ts",
  "ipc-contract.ts",
])

const SRC_DIR = join(import.meta.dir, "..", "src", "main")

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else if (/\.ts$/.test(entry.name)) yield p
  }
}

let failed = false

for (const file of walk(SRC_DIR)) {
  const basename = file.split("/").pop()!
  if (ALLOWED_FILES.has(basename)) continue

  const text = readFileSync(file, "utf8")
  if (/ipcMain\.handle\(/.test(text)) {
    console.error(`[ipc-authority] FORBIDDEN: raw ipcMain.handle in ${file}`)
    failed = true
  }
}

if (failed) {
  console.error("[ipc-authority] FAIL: raw ipcMain.handle calls outside ipc-registration.ts")
  process.exit(1)
}
console.log("[ipc-authority] PASS: all ipcMain.handle calls go through ipc-registration.ts")
