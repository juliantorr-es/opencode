/**
 * InstanceTrace smoke test — exercises the layer end-to-end.
 *
 * Run: cd packages/opencode && bun run scripts/instance-trace-smoke.ts
 */

import { Cause, Effect, Layer, ManagedRuntime } from "effect"
import { InstanceTrace } from "@/project/instance-trace"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface Check {
  name: string
  pass: boolean
  detail?: string
}

async function main() {
  const checks: Check[] = []

  function pass(name: string, detail?: string) {
    checks.push({ name, pass: true, detail })
    console.log(`PASS: ${name}${detail ? ` — ${detail}` : ""}`)
  }
  function fail(name: string, reason: string) {
    checks.push({ name, pass: false, detail: reason })
    console.error(`FAIL: ${name} — ${reason}`)
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "instance-trace-smoke-"))
  const origCwd = process.cwd()
  const traceFile = join(tmpDir, "instance-startup.jsonl")

  try {
    process.chdir(tmpDir)

    // ── Build the layer ─────────────────────────────────────────────────────
    const traceLayer = InstanceTrace.layer.pipe(Layer.provide(RuntimeFlags.layer()))
    const runtime = ManagedRuntime.make(traceLayer)
    const svc = await runtime.runPromise(InstanceTrace.Service)

    // ── CHECK 1: Trace file exists and has content ──────────────────────────
    let content: string
    try {
      content = await readFile(traceFile, "utf-8")
      if (content.trim().length > 0) pass("trace file created with content")
      else fail("trace file created", "file is empty")
    } catch (e: any) {
      fail("trace file created", e.message)
      process.chdir(origCwd)
      await rm(tmpDir, { recursive: true, force: true })
      const failures = checks.filter((c) => !c.pass).length
      console.log(`\n---\n${checks.length} checks: ${failures} failed\n`)
      process.exit(1)
    }

    const parseEntries = (c: string) =>
      c
        .trim()
        .split("\n")
        .map((l: string) => JSON.parse(l))

    let entries = parseEntries(content!)

    // ── CHECK 2: instance.booting auto-written on layer construction ─────────
    if (entries.length > 0 && entries[0].phase === "instance.booting")
      pass("instance.booting phase written automatically on layer construction")
    else
      fail(
        "instance.booting auto-write",
        entries.length > 0
          ? `expected 'instance.booting' got '${entries[0].phase}'`
          : "no entries",
      )

    const first = entries[0]

    // ── CHECK 3: bootId is a valid UUID ─────────────────────────────────────
    if (first && uuidRegex.test(first.bootId))
      pass("bootId valid UUID", first.bootId)
    else fail("bootId valid UUID", `got '${first?.bootId}'`)

    // ── CHECK 4: timestamp is valid ISO 8601 ────────────────────────────────
    if (first && !Number.isNaN(Date.parse(first.timestamp)))
      pass("timestamp ISO 8601", first.timestamp)
    else fail("timestamp ISO 8601", `got '${first?.timestamp}'`)

    // ── CHECK 5: status field ───────────────────────────────────────────────
    if (first && first.status === "started")
      pass("status field", `'started' for instance.booting`)
    else fail("status field", `expected 'started' got '${first?.status}'`)

    // ── CHECK 6: writePhase appends entries ─────────────────────────────────
    await runtime.runPromise(svc.writePhase("instance.boot.start", "started"))
    await runtime.runPromise(
      svc.writePhase("instance.boot.config", "completed", "config loaded"),
    )

    content = await readFile(traceFile, "utf-8")
    entries = parseEntries(content)

    if (entries.length === 3) pass("writePhase appends entries", "1 → 3")
    else fail("writePhase appends entries", `expected 3 entries, got ${entries.length}`)

    const bootStart = entries[1]
    const configDone = entries[2]

    if (bootStart.phase === "instance.boot.start" && bootStart.status === "started")
      pass("writePhase phase + status correct")
    else fail("writePhase phase/status", JSON.stringify(bootStart))

    if (
      configDone.phase === "instance.boot.config" &&
      configDone.status === "completed" &&
      configDone.message === "config loaded"
    )
      pass("writePhase optional message", "message field preserved")
    else fail("writePhase optional message", JSON.stringify(configDone))

    // ── CHECK 7: writeFailure produces correct JSONL ────────────────────────
    await runtime.runPromise(
      svc.writeFailure("instance.boot.failed", "ERR_TEST", "test failure message"),
    )

    content = await readFile(traceFile, "utf-8")
    entries = parseEntries(content)
    const failure = entries[entries.length - 1]

    if (failure.status === "failed") pass("writeFailure status", "'failed'")
    else fail("writeFailure status", `expected 'failed' got '${failure.status}'`)

    if (failure.errorCode === "ERR_TEST")
      pass("writeFailure errorCode", "ERR_TEST")
    else fail("writeFailure errorCode", `expected 'ERR_TEST' got '${failure.errorCode}'`)

    if (failure.message === "test failure message")
      pass("writeFailure message", "preserved")
    else fail("writeFailure message", `got '${failure.message}'`)

    if (failure.phase === "instance.boot.failed")
      pass("writeFailure phase", "instance.boot.failed")
    else fail("writeFailure phase", `got '${failure.phase}'`)

    // ── CHECK 8: latestEntry returns the last entry ─────────────────────────
    const latest = await runtime.runPromise(svc.latestEntry())
    if (latest?.phase === "instance.boot.failed" && latest?.status === "failed")
      pass("latestEntry", `returns last entry (phase=${latest.phase})`)
    else
      fail(
        "latestEntry",
        `got phase='${latest?.phase}' status='${latest?.status}'`,
      )

    // ── CHECK 9: same bootId across all entries ─────────────────────────────
    const bootIds = new Set(entries.map((e: any) => e.bootId))
    if (bootIds.size === 1)
      pass("consistent bootId", `all ${entries.length} entries share one bootId`)
    else
      fail("consistent bootId", `got ${bootIds.size} bootIds: ${[...bootIds].join(", ")}`)

    // ── CHECK 10: subsequent writes append, do not overwrite ────────────────
    const lineCountBefore = entries.length
    await runtime.runPromise(svc.writePhase("instance.boot.services", "started"))
    content = await readFile(traceFile, "utf-8")
    const lineCountAfter = content.trim().split("\n").length

    if (lineCountAfter === lineCountBefore + 1)
      pass("append behavior", `${lineCountBefore} → ${lineCountAfter} lines`)
    else
      fail("append behavior", `before: ${lineCountBefore}, after: ${lineCountAfter}`)

    // ── CHECK 11: disableInstanceTrace skips all writes ─────────────────────
    const tmpDir2 = await mkdtemp(join(tmpdir(), "instance-trace-disabled-"))
    process.chdir(tmpDir2)

    const disabledLayer = InstanceTrace.layer.pipe(
      Layer.provide(RuntimeFlags.layer({ disableInstanceTrace: true })),
    )
    const runtime2 = ManagedRuntime.make(disabledLayer)
    const svc2 = await runtime2.runPromise(InstanceTrace.Service)
    await runtime2.runPromise(svc2.writePhase("instance.boot.start", "started"))
    await runtime2.runPromise(
      svc2.writeFailure("instance.boot.failed", "ERR_SKIP", "should be skipped"),
    )

    try {
      const content2 = await readFile(join(tmpDir2, "instance-startup.jsonl"), "utf-8")
      if (content2.trim().length === 0)
        pass("disableInstanceTrace", "all writes skipped (empty file)")
      else
        fail("disableInstanceTrace", `expected empty file, got ${content2.length} bytes`)
    } catch {
      pass("disableInstanceTrace", "all writes skipped (no file created)")
    }

    await rm(tmpDir2, { recursive: true, force: true })
    process.chdir(tmpDir)

    // ── CHECK 12: writePhase with "degraded" status ─────────────────────────
    await runtime.runPromise(
      svc.writePhase("instance.boot.plugins", "degraded", "plugin X failed to load"),
    )
    content = await readFile(traceFile, "utf-8")
    entries = parseEntries(content)
    const degraded = entries[entries.length - 1]
    if (degraded.status === "degraded")
      pass("degraded status", `phase=${degraded.phase} status=degraded`)
    else fail("degraded status", `expected 'degraded' got '${degraded.status}'`)

    // ── CHECK 13: writeFailure with Cause sets isDie ────────────────────────
    await runtime.runPromise(
      svc.writeFailure(
        "instance.boot.failed",
        "ERR_DIE",
        "fatal error",
        Cause.fail(new Error("inner boom")),
      ),
    )
    content = await readFile(traceFile, "utf-8")
    entries = parseEntries(content)
    const dieEntry = entries[entries.length - 1]
    if (dieEntry.isDie === true)
      pass("writeFailure isDie", "true when Cause provided")
    else fail("writeFailure isDie", `expected true got '${dieEntry.isDie}'`)
    if (dieEntry.cause && typeof dieEntry.cause === "string" && dieEntry.cause.includes("inner boom"))
      pass("writeFailure cause stringified", dieEntry.cause.slice(0, 80))
    else fail("writeFailure cause stringified", `got '${dieEntry.cause}'`)

    // ── CHECK 14: writeFailure records lastPhase on phase transition ────────
    await runtime.runPromise(svc.writePhase("instance.reloading", "started"))
    await runtime.runPromise(
      svc.writeFailure("instance.failed", "ERR_RELOAD", "reload failed"),
    )
    content = await readFile(traceFile, "utf-8")
    entries = parseEntries(content)
    const lastFail = entries[entries.length - 1]
    if (
      lastFail.phase === "instance.failed" &&
      lastFail.lastPhase === "instance.reloading"
    )
      pass("writeFailure lastPhase", "tracks phase transition")
    else
      fail(
        "writeFailure lastPhase",
        `phase=${lastFail.phase} lastPhase=${lastFail.lastPhase}`,
      )
  } finally {
    process.chdir(origCwd)
    await rm(tmpDir, { recursive: true, force: true })
    console.log(`\nCleaned up ${tmpDir}`)
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const failures = checks.filter((c) => !c.pass).length
  console.log(`\n---`)
  console.log(`${checks.length} checks: ${failures} failed`)
  if (failures > 0) {
    console.log("\nFAILED CHECKS:")
    for (const c of checks) if (!c.pass) console.log(`  FAIL: ${c.name} — ${c.detail}`)
  }
  process.exit(failures > 0 ? 1 : 0)
}

main()
