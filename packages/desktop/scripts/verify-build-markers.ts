#!/usr/bin/env bun
import { $ } from "bun"

const MARKERS = [
  { label: "adapter migration logging", pattern: "Migration failed during adapter init" },
  { label: "coordination DDL idempotency", pattern: "ALTER TABLE coordination_claim ADD COLUMN expires_at" },
  { label: "adapter migration logging in chunk", checkFile: "out/main/chunks/node-*.js", pattern: "Migration failed during adapter init" },
]

const errors: string[] = []

for (const marker of MARKERS) {
  let file = marker.checkFile ?? "packages/runtime/dist/node/node.js"
  try {
    const result = await $`grep -c ${marker.pattern} ${file}`.quiet()
    if (result.exitCode !== 0) {
      errors.push(`MISSING: ${marker.label} — '${marker.pattern}' not found in ${file}`)
    }
  } catch {
    errors.push(`MISSING: ${marker.label} — '${marker.pattern}' not found in ${file}`)
  }
}

if (errors.length > 0) {
  console.error("BUILD VERIFICATION FAILED:")
  for (const e of errors) console.error(`  ✗ ${e}`)
  process.exit(1)
}

console.log("Build verification passed — all source markers found in output")
