#!/usr/bin/env bun
/**
 * Binary Tools Setup Script
 *
 * Pre-downloads Rust binary tools (rg, fd, bat, delta, difft, eza)
 * so they're available on first use without waiting for downloads.
 *
 * Run: bun run packages/opencode/src/binary/setup.ts
 * Or via package.json: "postinstall": "bun run binary-setup"
 */

import { Service as BinaryManager, defaultLayer as BinaryManagerLayer } from "./manager"
import { Effect, Layer } from "effect"

const tools = ["rg", "fd", "bat", "delta", "difft", "eza"] as const

const program = Effect.gen(function* () {
  console.log("🔧 Binary Tools Setup")
  console.log(`   Platform: ${process.platform}-${process.arch}`)
  console.log("")

  // Check status of all managed binaries
  const bm = yield* BinaryManager
  const statuses = yield* bm.info()

  for (const s of statuses) {
    const icon = s.status === "cached" ? "✅" : s.status === "system" ? "📦" : s.status === "downloadable" ? "⬇️" : "❌"
    console.log(`   ${icon} ${s.name} v${s.version}: ${s.status === "cached" ? s.path : s.status === "system" ? `system (${s.path})` : s.status}`)
  }

  console.log("")

  // Download any missing tools
  for (const t of tools) {
    const available = yield* bm.check(t)
    if (!available) {
      console.log(`   ⬇️  Downloading ${t}...`)
      const binPath = yield* bm.download(t).pipe(Effect.catch((e) => {
        console.error(`   ❌ Failed to download ${t}: ${String(e)}`)
        return Effect.succeed("" as any)
      }))
      if (binPath) console.log(`   ✅ ${t} installed to ${binPath}`)
    }
  }

  console.log("")
  console.log("✅ Binary setup complete")
})

// Run with default layer
Effect.runPromise(
  (program as any).pipe(Effect.provide(BinaryManagerLayer)),
).then(() => process.exit(0))
  .catch((e) => {
    console.error("Binary setup failed:", e)
    process.exit(1)
  })
