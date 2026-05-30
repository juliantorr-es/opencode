#!/usr/bin/env bun
/**
 * IPC Migration Validation Script
 *
 * Validates that the IPC channels registry refactoring was applied correctly.
 * Checks:
 *   1. ipc-channels.ts contains the correct number of channel entries per group
 *   2. No magic string IPC channel names remain in modified files
 *   3. imports are correctly wired
 *   4. Duplicate constants are eliminated
 *
 * Run: bun run packages/desktop/scripts/validate-ipc-migration.ts
 * Or:  bun scripts/validate-ipc-migration.ts (from packages/desktop)
 */

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(DIR, "..")

interface CheckResult {
  pass: boolean
  label: string
  detail: string
}

const results: CheckResult[] = []

function check(label: string, pass: boolean, detail: string) {
  results.push({ label, pass, detail })
  const mark = pass ? "✅" : "❌"
  console.log(`  ${mark}  ${label}`)
  if (!pass) console.log(`       ${detail}`)
}

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf-8")
}

// ─── 1. Parse ipc-channels.ts ───────────────────────────────────────────────────

console.log("\n═══ 1. IPC Channels Registry ───\n")

const channelsSrc = read("src/main/ipc-channels.ts")

// Extract group names and their entries
const groupRegex = /(\w+)\s*:\s*\{([^}]+)\}/gs
let handleCount = 0
let sendCount = 0
let pushCount = 0
let storeCount = 0

let match: RegExpExecArray | null
while ((match = groupRegex.exec(channelsSrc)) !== null) {
  const groupName = match[1]
  const body = match[2]
  // Count entries that look like KEY: "value"
  const entryCount = (body.match(/\w+\s*:\s*"/g) || []).length

  switch (groupName) {
    case "handle":
      handleCount = entryCount
      break
    case "send":
      sendCount = entryCount
      break
    case "push":
      pushCount = entryCount
      break
    case "store":
      storeCount = entryCount
      break
  }
}

// The plan expects: handle=57, send=4, push=6, store=5
check(
  "handle group has 57 channels",
  handleCount === 57,
  `expected 57, got ${handleCount}`,
)
check(
  "send group has 4 channels",
  sendCount === 4,
  `expected 4, got ${sendCount}`,
)
check(
  "push group has 6 channels",
  pushCount === 6,
  `expected 6, got ${pushCount}`,
)
check(
  "store group has 5 channels",
  storeCount === 5,
  `expected 5, got ${storeCount}`,
)

// Check that IpcChannel union type is exported
check(
  "IpcChannel union type exported",
  /export\s+type\s+IpcChannel\s*=/.test(channelsSrc),
  "export type IpcChannel = ... not found in ipc-channels.ts",
)

// Check that IPC object is exported as const
check(
  "IPC object exported as const",
  /export\s+const\s+IPC\s*=\s*\{/.test(channelsSrc),
  "export const IPC = { ... } not found in ipc-channels.ts",
)

// Check that each value in ipc-channels.ts is a string literal
// (no runtime computed keys)
check(
  "all channel values are string literals",
  !/:\s*[^"'\s]/.test(read("src/main/ipc-channels.ts")),
  "found non-string-literal values in ipc-channels.ts",
)

// ─── 2. ipc.ts uses IPC.handle.* for all handlers ──────────────────────────────

console.log("\n═══ 2. ipc.ts ───\n")

const ipcSrc = read("src/main/ipc.ts")

// Check no literal string in ipcMain.handle("...") 
const magicHandles = ipcSrc.match(/ipcMain\.handle\("([^"]+)"\s*[\),]/g)
check(
  "no magic string ipcMain.handle calls",
  !magicHandles || magicHandles.length === 0,
  `${magicHandles?.length || 0} magic handle strings remain: ${magicHandles?.map((s) => s.slice(0, 35)).join(", ")}`,
)

// Check no literal string in ipcMain.on("...")
const magicOns = ipcSrc.match(/ipcMain\.on\("([^"]+)"\s*[\),]/g)
check(
  "no magic string ipcMain.on calls",
  !magicOns || magicOns.length === 0,
  `${magicOns?.length || 0} magic on strings remain: ${magicOns?.map((s) => s.slice(0, 30)).join(", ")}`,
)

// Check IPC.handle.* is used
check(
  "ipc.ts uses IPC.handle.* references",
  /IPC\.handle\./.test(ipcSrc),
  "IPC.handle.* not found in ipc.ts",
)

// ─── 3. preload/index.ts uses IPC.* references ────────────────────────────────

console.log("\n═══ 3. preload/index.ts ───\n")

const preloadSrc = read("src/preload/index.ts")

// Check no literal string in ipcRenderer.invoke("...")
const magicInvokes = preloadSrc.match(/ipcRenderer\.invoke\("([^"]+)"\s*[\),]/g)
check(
  "no magic string ipcRenderer.invoke calls",
  !magicInvokes || magicInvokes.length === 0,
  `${magicInvokes?.length || 0} magic invoke strings remain: ${magicInvokes?.map((s) => s.slice(0, 35)).join(", ")}`,
)

// Check no literal string in ipcRenderer.send("...")
const magicSends = preloadSrc.match(/ipcRenderer\.send\("([^"]+)"\s*[\),]/g)
check(
  "no magic string ipcRenderer.send calls",
  !magicSends || magicSends.length === 0,
  `${magicSends?.length || 0} magic send strings remain: ${magicSends?.map((s) => s.slice(0, 30)).join(", ")}`,
)

// Check IPC.handle.*, IPC.send.*, IPC.push.* references
check(
  "preload uses IPC.handle.* for invokes",
  /IPC\.handle\./.test(preloadSrc),
  "IPC.handle.* not found in preload",
)
check(
  "preload uses IPC.send.* for sends",
  /IPC\.send\./.test(preloadSrc),
  "IPC.send.* not found in preload",
)
check(
  "preload uses IPC.push.* for on/removeListener",
  /IPC\.push\./.test(preloadSrc),
  "IPC.push.* not found in preload",
)

// ─── 4. windows.ts uses IPC.push.* ─────────────────────────────────────────────

console.log("\n═══ 4. windows.ts ───\n")

const windowsSrc = read("src/main/windows.ts")

// Check no literal string in webContents.send("...")
const magicPushes = windowsSrc.match(/webContents\.send\("([^"]+)"\s*[\),]/g)
check(
  "no magic string webContents.send calls in windows.ts",
  !magicPushes || magicPushes.length === 0,
  `${magicPushes?.length || 0} magic push strings remain: ${magicPushes?.map((s) => s.slice(0, 35)).join(", ")}`,
)

check(
  "windows.ts uses IPC.push.*",
  /IPC\.push\./.test(windowsSrc),
  "IPC.push.* not found in windows.ts",
)

// ─── 5. apps.ts: no process.env.HOME ──────────────────────────────────────────

console.log("\n═══ 5. apps.ts ───\n")

const appsSrc = read("src/main/apps.ts")
check(
  "no process.env.HOME in apps.ts",
  !/process\.env\.HOME/.test(appsSrc),
  "process.env.HOME still present in apps.ts",
)

// ─── 6. migrate.ts: no TAURI_APP_IDS ─────────────────────────────────────────

console.log("\n═══ 6. migrate.ts ───\n")

const migrateSrc = read("src/main/migrate.ts")
check(
  "TAURI_APP_IDS removed from migrate.ts",
  !/TAURI_APP_IDS/.test(migrateSrc),
  "TAURI_APP_IDS still defined in migrate.ts",
)
const migrateImports = migrateSrc.match(/import\s+\{[^}]*\}/g)?.join(" ") || ""
check(
  "migrate imports APP_IDS from constants",
  /from\s+["']\.\/constants["']/.test(migrateSrc) && /APP_IDS/.test(migrateSrc),
  "migrate.ts does not import APP_IDS from constants",
)

// ─── 7. index.ts APP_IDS moved to constants ──────────────────────────────────

console.log("\n═══ 7. index.ts ───\n")

const indexSrc = read("src/main/index.ts")
check(
  "APP_IDS not defined inline in index.ts",
  !/const APP_IDS\s*=/.test(indexSrc),
  "APP_IDS still defined as const in index.ts",
)

// ─── 8. constants.ts has APP_IDS ──────────────────────────────────────────────

console.log("\n═══ 8. constants.ts ───\n")

const constantsSrc = read("src/main/constants.ts")
check(
  "constants.ts exports APP_IDS",
  /export\s+(const\s+APP_IDS|const\s+APP_IDS)/.test(constantsSrc),
  "APP_IDS not exported from constants.ts",
)
check(
  "constants.ts exports Channel type",
  /export\s+type\s+Channel/.test(constantsSrc),
  "Channel type not exported from constants.ts",
)

// ─── 9. store.ts imports IPC store name ──────────────────────────────────────

console.log("\n═══ 9. store.ts ───\n")

const storeSrc = read("src/main/store.ts")
check(
  "store.ts imports IPC from ipc-channels",
  /from\s+["']\.\/ipc-channels["']/.test(storeSrc) || /IPC\.store\./.test(storeSrc),
  "store.ts does not reference IPC.store",
)

// ─── 10. github-ipc.ts exists with 6 handlers ─────────────────────────────────

console.log("\n═══ 10. github-ipc.ts ───\n")

const githubSrc = read("src/main/github-ipc.ts")
const githubHandles = githubSrc.match(/IPC\.handle\./g) || []
check(
  "github-ipc.ts uses IPC.handle.* references",
  githubHandles.length >= 6,
  `expected at least 6 IPC.handle.* references in github-ipc.ts, got ${githubHandles.length}`,
)
check(
  "github-ipc.ts imports app-config",
  /from\s+["']\.\/app-config["']/.test(githubSrc),
  "github-ipc.ts does not import from app-config.ts",
)

// ─── 11. app-config.ts exists with typed accessors ────────────────────────────

console.log("\n═══ 11. app-config.ts ───\n")

const appConfigSrc = read("src/main/app-config.ts")
check(
  "app-config.ts exists and is not empty",
  appConfigSrc.length > 50,
  "app-config.ts is empty or missing",
)

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log("\n═══════════════════════════════════════════════════════════════\n")
const passed = results.filter((r) => r.pass).length
const failed = results.filter((r) => !r.pass).length
console.log(`  ${passed} passed, ${failed} failed out of ${results.length} checks`)

if (failed > 0) {
  console.log("\n  ❌ FAILED CHECKS:")
  for (const r of results) {
    if (!r.pass) console.log(`    - ${r.label}: ${r.detail}`)
  }
  process.exit(1)
} else {
  console.log("\n  ✅ All checks passed — IPC migration is correctly applied.\n")
}
