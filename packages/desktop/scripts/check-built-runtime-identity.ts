/**
 * Built Runtime Identity Guard
 * Scans packages/opencode/dist and packages/desktop/out for stale strings.
 * Fails if forbidden patterns appear in executed artifacts.
 */

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

const BUILD_ROOTS = [
  join(import.meta.dir, "..", "..", "..", "opencode", "dist"),
  join(import.meta.dir, "..", "out"),
]

const FORBIDDEN = [
  "Set OPENCODE_STATE_HOME",
  "opencode-debug",
  "ai.opencode.desktop",
  "No server available",
  "opencode://",
  "opencode:session-tabs-removed",
  "opencode:ai-command",
  "opencode:push:notification-action",
  "opencode:deep-link",
  "opencode:events",
]

// Files where legacy opencode: channels are explicitly allowed (migration, tests, comments)
const LEGACY_ALLOWED: Record<string, true> = {
  "migrate": true,
  "app-data-paths": true,
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) }
  catch { return }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else yield p
  }
}

async function main() {
  let failed = false
  let filesChecked = 0

  for (const root of BUILD_ROOTS) {
    for await (const file of walk(root)) {
      if (!/\.(js|mjs|cjs|json|html|txt|css)$/.test(file)) continue
      filesChecked++
      let text: string
      try { text = await readFile(file, "utf8") } catch { continue }

      for (const pattern of FORBIDDEN) {
        if (text.includes(pattern)) {
          console.error(`[build-identity] FORBIDDEN: "${pattern}" in ${file}`)
          failed = true
        }
      }

      // Check for raw opencode: IPC channels in built output
      if (text.includes("opencode:") && !Object.keys(LEGACY_ALLOWED).some(a => file.includes(a))) {
        console.error(`[build-identity] FORBIDDEN: raw "opencode:" in ${file}`)
        failed = true
      }
    }
  }

  console.log(`[build-identity] Checked ${filesChecked} files in build output`)
  if (failed) {
    console.error("[build-identity] FAIL: forbidden strings in built artifacts")
    process.exit(1)
  }
  console.log("[build-identity] PASS")
}

main()
