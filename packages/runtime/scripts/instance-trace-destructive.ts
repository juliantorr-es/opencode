import { Effect, Layer, ManagedRuntime } from "effect"
import { InstanceTrace } from "@/project/instance-trace"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { mkdtemp, rm, readFile, mkdir, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { existsSync, chmodSync } from "node:fs"

const PASS = "✅ PASS"
const FAIL = "❌ FAIL"

async function main() {
  let totalPassed = 0
  let totalFailed = 0

  function pass(name: string) {
    totalPassed++
    const line = `${PASS}: ${name}`
    console.log(line)
    writeLog(line)
  }
  function fail(name: string, reason: string) {
    totalFailed++
    const line = `${FAIL}: ${name} — ${reason}`
    console.log(line)
    writeLog(line)
  }

  const origCwd = process.cwd()

  // Ensure log output file is ready early
  const { mkdirSync, writeFileSync, appendFileSync } = await import("node:fs")
  const logFile = join(origCwd, ".build", "destructive-test-log.txt")
  mkdirSync(join(origCwd, ".build"), { recursive: true })
  writeFileSync(logFile, "", "utf-8") // truncate

  function writeLog(msg: string) {
    try { appendFileSync(logFile, msg + "\n", "utf-8") } catch {}
  }

  // ===================================================================
  // TEST 1: KILL SWITCH
  //   OPENCODE_DISABLE_INSTANCE_TRACE=1 → no file created, writes are no-ops
  // ===================================================================
  console.log("\n═══ TEST 1: KILL SWITCH ═══")
  {
    const tmpDir = await mkdtemp(join(tmpdir(), "it-destructive-killswitch-"))
    process.chdir(tmpDir)
    const traceFile = join(tmpDir, "instance-startup.jsonl")

    const disabledLayer = InstanceTrace.layer.pipe(
      Layer.provide(RuntimeFlags.layer({ disableInstanceTrace: true })),
    )
    const runtime = ManagedRuntime.make(disabledLayer)

    let svc: InstanceTrace.Service
    try {
      svc = await runtime.runPromise(InstanceTrace.Service)
      pass("TEST 1.1: layer builds without crash when kill switch active")
    } catch (e: any) {
      fail("TEST 1.1", `layer construction crashed: ${e.message}`)
      process.chdir(origCwd)
      try { chmodSync(tmpDir, 0o755) } catch {}
      await rm(tmpDir, { recursive: true, force: true })
      // svc is undefined; skip remaining TEST 1 checks
    }

    if (svc!) {
      // writePhase should be no-op (doesn't throw)
      try {
        await runtime.runPromise(svc.writePhase("instance.boot.start", "started"))
        pass("TEST 1.2: writePhase is no-op with kill switch (no throw)")
      } catch (e: any) {
        fail("TEST 1.2", `writePhase threw despite kill switch: ${e.message}`)
      }

      // writeFailure should be no-op (doesn't throw)
      try {
        await runtime.runPromise(
          svc.writeFailure("instance.boot.failed", "ERR_KILL", "should be silenced"),
        )
        pass("TEST 1.3: writeFailure is no-op with kill switch (no throw)")
      } catch (e: any) {
        fail("TEST 1.3", `writeFailure threw despite kill switch: ${e.message}`)
      }
    }

    // Verify no trace entries were written (initial booting + manual writes)
    if (existsSync(traceFile)) {
      const content = await readFile(traceFile, "utf-8")
      if (content.trim().length === 0) {
        pass("TEST 1.4: no trace content written with kill switch (empty file)")
      } else {
        fail("TEST 1.4", `trace file has ${content.trim().split("\n").length} lines despite kill switch`)
      }
    } else {
      pass("TEST 1.4: no trace file created at all with kill switch")
    }

    process.chdir(origCwd)
    try { chmodSync(tmpDir, 0o755) } catch {}
    await rm(tmpDir, { recursive: true, force: true })
  }

  // ===================================================================
  // TEST 2: FRESH DIR
  //   No existing .rig/ or trace file — mkdir({recursive:true}) creates path
  // ===================================================================
  console.log("\n═══ TEST 2: FRESH DIR ═══")
  {
    const tmpDir = await mkdtemp(join(tmpdir(), "it-destructive-fresh-"))
    process.chdir(tmpDir)
    const traceFile = join(tmpDir, "instance-startup.jsonl")

    const traceLayer = InstanceTrace.layer.pipe(Layer.provide(RuntimeFlags.layer()))
    const runtime = ManagedRuntime.make(traceLayer)

    try {
      await runtime.runPromise(InstanceTrace.Service)
      pass("TEST 2.1: layer builds successfully in fresh dir")
    } catch (e: any) {
      fail("TEST 2.1", `layer construction crashed in fresh dir: ${e.message}`)
      process.chdir(origCwd)
      await rm(tmpDir, { recursive: true, force: true })
    }

    if (existsSync(traceFile)) {
      const content = await readFile(traceFile, "utf-8")
      if (content.trim().length > 0) {
        const entries = content.trim().split("\n").map((l) => JSON.parse(l))
        if (entries.length >= 1 && entries[0].phase === "instance.booting") {
          pass("TEST 2.2: auto-write succeeded — instance.booting entry present")
        } else {
          fail("TEST 2.2", `expected instance.booting entry, got ${entries.length} entries`)
        }
      } else {
        fail("TEST 2.2", "trace file created but is empty")
      }
    } else {
      fail("TEST 2.2", "trace file was not created in fresh dir")
    }

    // Now test with a deep nested path
    const nestedDir = join(tmpDir, "deep", "nested", "path")
    // create the nested dir before chdir into it
    await mkdir(nestedDir, { recursive: true })
    process.chdir(nestedDir)

    const nestedLayer = InstanceTrace.layer.pipe(Layer.provide(RuntimeFlags.layer()))
    const nestedRuntime = ManagedRuntime.make(nestedLayer)
    const nestedTraceFile = join(nestedDir, "instance-startup.jsonl")

    try {
      await nestedRuntime.runPromise(InstanceTrace.Service)
      pass("TEST 2.3: layer builds in deeply nested fresh dir")
    } catch (e: any) {
      fail("TEST 2.3", `layer crashed in nested fresh dir: ${e.message}`)
    }

    if (existsSync(nestedTraceFile)) {
      pass("TEST 2.4: trace file created in deeply nested fresh dir")
    } else {
      fail("TEST 2.4", "trace file not created in nested fresh dir")
    }

    process.chdir(origCwd)
    await rm(tmpDir, { recursive: true, force: true })
  }

  // ===================================================================
  // TEST 3: READ-ONLY DIR
  //   chmod 444 (r--) → write fails gracefully, catchAll prevents crash
  // ===================================================================
  console.log("\n═══ TEST 3: READ-ONLY DIR ═══")
  {
    const tmpDir = await mkdtemp(join(tmpdir(), "it-destructive-readonly-"))
    process.chdir(tmpDir)

    // First, let the auto-write succeed normally
    const traceLayer = InstanceTrace.layer.pipe(Layer.provide(RuntimeFlags.layer()))
    const runtime = ManagedRuntime.make(traceLayer)
    const svc = await runtime.runPromise(InstanceTrace.Service)

    const traceFile = join(tmpDir, "instance-startup.jsonl")

    // Now make the directory read-only
    chmodSync(tmpDir, 0o444)

    // Attempt writePhase — should fail gracefully via catchAll
    try {
      await runtime.runPromise(svc.writePhase("instance.boot.config", "started", "should-fail"))
      pass("TEST 3.1: writePhase to read-only dir does not throw (catchAll works)")
    } catch (e: any) {
      fail("TEST 3.1", `writePhase threw when dir is read-only: ${e.message}`)
    }

    // Attempt writeFailure — should also fail gracefully
    try {
      await runtime.runPromise(
        svc.writeFailure("instance.boot.failed", "ERR_RO", "read-only dir"),
      )
      pass("TEST 3.2: writeFailure to read-only dir does not throw (catchAll works)")
    } catch (e: any) {
      fail("TEST 3.2", `writeFailure threw when dir is read-only: ${e.message}`)
    }

    // Try latestEntry — should not throw, returns undefined when file unreadable
    try {
      const latest = await runtime.runPromise(svc.latestEntry())
      // Directory is read-only, so readFile will fail → latestEntry returns undefined
      // This is correct graceful degradation
      if (latest === undefined) {
        pass("TEST 3.3: latestEntry returns undefined gracefully when dir is read-only (no throw)")
      } else {
        pass("TEST 3.3: latestEntry returned entry despite read-only dir (no throw)")
      }
    } catch (e: any) {
      fail("TEST 3.3", `latestEntry threw: ${e.message}`)
    }

    // Restore permissions for cleanup
    chmodSync(tmpDir, 0o755)
    process.chdir(origCwd)
    await rm(tmpDir, { recursive: true, force: true })
  }

  // ===================================================================
  // TEST 3b: READ-ONLY DIR (BEFORE ANY WRITE)
  //   Build layer when dir is already read-only — catchAll prevents crash
  // ===================================================================
  console.log("\n═══ TEST 3b: READ-ONLY DIR BEFORE ANY WRITE ═══")
  {
    const tmpDir = await mkdtemp(join(tmpdir(), "it-destructive-readonly-before-"))
    process.chdir(tmpDir)

    // Make dir read-only BEFORE layer construction
    chmodSync(tmpDir, 0o444)

    const traceLayer = InstanceTrace.layer.pipe(Layer.provide(RuntimeFlags.layer()))
    const runtime = ManagedRuntime.make(traceLayer)

    try {
      await runtime.runPromise(InstanceTrace.Service)
      pass("TEST 3b.1: layer builds without crash when dir is read-only (initial write fails gracefully)")
    } catch (e: any) {
      fail("TEST 3b.1", `layer construction crashed in read-only dir: ${e.message}`)
    }

    // Restore for cleanup
    chmodSync(tmpDir, 0o755)
    process.chdir(origCwd)
    await rm(tmpDir, { recursive: true, force: true })
  }

  // ===================================================================
  // TEST 4: I/O FAILURE — TRACE PATH IS A DIRECTORY
  //   make trace path a dir → appendFile fails with EISDIR → catchAll catches
  // ===================================================================
  console.log("\n═══ TEST 4: I/O FAILURE — TRACE PATH IS A DIRECTORY ═══")
  {
    const tmpDir = await mkdtemp(join(tmpdir(), "it-destructive-iofail-"))
    process.chdir(tmpDir)

    const traceFile = join(tmpDir, "instance-startup.jsonl")
    // Create the trace path as a DIRECTORY — appendFile will fail
    await mkdir(traceFile, { recursive: true })

    const traceLayer = InstanceTrace.layer.pipe(Layer.provide(RuntimeFlags.layer()))
    const runtime = ManagedRuntime.make(traceLayer)

    let svc: InstanceTrace.Service
    try {
      svc = await runtime.runPromise(InstanceTrace.Service)
      pass("TEST 4.1: layer builds without crash when trace path is a directory")
    } catch (e: any) {
      fail("TEST 4.1", `layer crashed when trace path is a directory: ${e.message}`)
      process.chdir(origCwd)
      await rm(tmpDir, { recursive: true, force: true })
    }

    if (svc!) {
      try {
        await runtime.runPromise(svc.writePhase("instance.boot.config", "started", "write-to-dir"))
        pass("TEST 4.2: writePhase does not throw when trace path is a directory")
      } catch (e: any) {
        fail("TEST 4.2", `writePhase threw: ${e.message}`)
      }

      try {
        await runtime.runPromise(
          svc.writeFailure("instance.boot.failed", "ERR_ISDIR", "trace path is dir"),
        )
        pass("TEST 4.3: writeFailure does not throw when trace path is a directory")
      } catch (e: any) {
        fail("TEST 4.3", `writeFailure threw: ${e.message}`)
      }
    }

    process.chdir(origCwd)
    await rm(tmpDir, { recursive: true, force: true })
  }

  // ===================================================================
  // TEST 4b: I/O FAILURE — PARENT PATH IS A FILE
  //   make the parent dir path a FILE → mkdir fails → catchAll catches
  // ===================================================================
  console.log("\n═══ TEST 4b: I/O FAILURE — PARENT IS A FILE ═══")
  {
    const tmpDir = await mkdtemp(join(tmpdir(), "it-destructive-parentfile-"))
    process.chdir(tmpDir)

    // Create a nested path where the intermediate component is a FILE
    // tracePath = /tmp/xxx/subdir/instance-startup.jsonl
    // Make "subdir" a file, not a directory → mkdir fails
    const subdir = join(tmpDir, "subdir")
    const { writeFile } = await import("node:fs/promises")
    await writeFile(subdir, "blocking file", "utf-8")

    const traceLayer = InstanceTrace.layer.pipe(Layer.provide(RuntimeFlags.layer()))
    const runtime = ManagedRuntime.make(traceLayer)

    // Need to chdir into subdir so that tracePath = subdir/instance-startup.jsonl
    // and dirname(tracePath) = subdir (which is a file, not a dir)
    // But we can't chdir into a file...
    // Alternative: chdir to tmpDir and the trace file is at ./instance-startup.jsonl
    // The dirname is . which is tmpDir, and that's already a dir.
    // 
    // The only way to trigger mkdir failure is if dirname(tracePath) is a file.
    // Since tracePath = cwd/instance-startup.jsonl, dirname = cwd (always a dir).
    // 
    // Hmm, this test scenario can't easily be triggered with the current implementation.
    // Let's use a different approach instead: create a symlink cycle or a broken path.
    // 
    // Actually the simplest I/O failure: create the trace file with 000 permissions
    // so that appendFile fails when the file already exists but is unreadable/unwritable.
    // But that tests a different code path...
    //
    // Let's just skip the "parent is a file" scenario since the mkdir always operates
    // on process.cwd() which must be a directory (otherwise chdir fails).
    // We already cover I/O failure in TEST 4 (trace path is a directory).

    // Instead: test with a symlink to /dev/full or similar
    // On macOS, /dev/full doesn't exist. Let's use a named pipe (FIFO).
    // Actually, let's just acknowledge this limitation and note it.

    // Alternative I/O failure: create the trace file, then remove write permission from it
    const traceFile = join(tmpDir, "instance-startup.jsonl")
    // Create an empty file first
    await writeFile(traceFile, "", "utf-8")
    chmodSync(traceFile, 0o444) // read-only file

    // Now the file exists but can't be written to
    // ensureWrite will: mkdir(dirname, {recursive}) → succeeds (dir exists)
    // then appendFile → fails with EACCES because file is read-only
    const writeRuntime = ManagedRuntime.make(traceLayer)
    const svc = await writeRuntime.runPromise(InstanceTrace.Service)

    try {
      await writeRuntime.runPromise(svc.writePhase("instance.boot.config", "started", "readonly-file"))
      pass("TEST 4b.1: writePhase to read-only file does not throw")
    } catch (e: any) {
      fail("TEST 4b.1", `writePhase to read-only file threw: ${e.message}`)
    }

    // Restore for cleanup
    chmodSync(traceFile, 0o644)
    chmodSync(subdir, 0o755)
    process.chdir(origCwd)
    await rm(tmpDir, { recursive: true, force: true })
  }

  // ===================================================================
  // TEST 5: SPECIAL CHARACTERS IN PATH
  //   Spaces, unicode, special chars — writes still work
  // ===================================================================
  console.log("\n═══ TEST 5: SPECIAL CHARACTERS IN PATH ═══")
  {
    const specialDir = await mkdtemp(
      join(tmpdir(), "it-destructive-spécial chârs 🚀✨"),
    )
    process.chdir(specialDir)
    const traceFile = join(specialDir, "instance-startup.jsonl")

    const traceLayer = InstanceTrace.layer.pipe(Layer.provide(RuntimeFlags.layer()))
    const runtime = ManagedRuntime.make(traceLayer)
    const svc = await runtime.runPromise(InstanceTrace.Service)

    // Write with a message containing unicode
    try {
      await runtime.runPromise(
        svc.writePhase("instance.boot.config", "completed", "こんにちは世界 🌍"),
      )
      pass("TEST 5.1: writePhase with unicode message in unicode path does not throw")
    } catch (e: any) {
      fail("TEST 5.1", `writePhase threw with unicode path: ${e.message}`)
    }

    // Verify the file was created and readable
    try {
      const content = await readFile(traceFile, "utf-8")
      const entries = content.trim().split("\n").map((l) => JSON.parse(l))
      const unicodeEntry = entries.find((e: any) => e.message?.includes("こんにちは"))
      if (unicodeEntry) {
        pass("TEST 5.2: unicode message round-trips correctly through JSONL")
      } else {
        fail("TEST 5.2", "could not find unicode message entry in trace file")
      }
    } catch (e: any) {
      fail("TEST 5.2", `could not read trace file: ${e.message}`)
    }

    // Test with spaces in path
    const spaceDir = join(specialDir, "sub dir with spaces")
    await mkdir(spaceDir, { recursive: true })
    process.chdir(spaceDir)
    const spaceTraceFile = join(spaceDir, "instance-startup.jsonl")

    const spaceLayer = InstanceTrace.layer.pipe(Layer.provide(RuntimeFlags.layer()))
    const spaceRuntime = ManagedRuntime.make(spaceLayer)
    try {
      await spaceRuntime.runPromise(InstanceTrace.Service)
      pass("TEST 5.3: layer builds in directory with spaces in path")
    } catch (e: any) {
      fail("TEST 5.3", `layer crashed with spaces in path: ${e.message}`)
    }

    if (existsSync(spaceTraceFile)) {
      pass("TEST 5.4: trace file created in directory with spaces")
    } else {
      fail("TEST 5.4", "trace file not created in directory with spaces")
    }

    process.chdir(origCwd)
    await rm(specialDir, { recursive: true, force: true })
  }

  // ===================================================================
  // TEST 6: CONCURRENT WRITES
  //   5 concurrent writePhase calls → no crashes, all entries in file
  // ===================================================================
  console.log("\n═══ TEST 6: CONCURRENT WRITES ═══")
  {
    const tmpDir = await mkdtemp(join(tmpdir(), "it-destructive-concurrent-"))
    process.chdir(tmpDir)
    const traceFile = join(tmpDir, "instance-startup.jsonl")

    const traceLayer = InstanceTrace.layer.pipe(Layer.provide(RuntimeFlags.layer()))
    const runtime = ManagedRuntime.make(traceLayer)
    const svc = await runtime.runPromise(InstanceTrace.Service)

    // Run 5 concurrent writePhase calls
    try {
      await runtime.runPromise(
        Effect.all(
          Array.from({ length: 5 }, (_, i) =>
            svc.writePhase(
              "instance.boot.services",
              "started",
              `concurrent-write-${i}`,
            ),
          ),
          { concurrency: "unbounded" },
        ),
      )
      pass("TEST 6.1: 5 concurrent writePhase calls complete without crash")
    } catch (e: any) {
      fail("TEST 6.1", `concurrent writes crashed: ${e.message}`)
    }

    // Verify all entries are present
    try {
      const content = await readFile(traceFile, "utf-8")
      const lines = content.trim().split("\n")
      const concurrentCount = lines.filter((l) =>
        l.includes("concurrent-write-"),
      ).length
      // +1 for the initial "instance.booting" entry
      const totalExpected = 1 + 5

      if (concurrentCount === 5) {
        pass(`TEST 6.2: all 5 concurrent entries present (${concurrentCount} found)`)
      } else {
        fail("TEST 6.2", `expected 5 concurrent entries, found ${concurrentCount}`)
      }

      if (lines.length === totalExpected) {
        pass(`TEST 6.3: total line count correct (${lines.length} = 1 booting + 5 concurrent)`)
      } else {
        fail("TEST 6.3", `expected ${totalExpected} total entries, got ${lines.length}`)
      }

      // Verify each concurrent entry has distinct content
      const messages = lines
        .filter((l) => l.includes("concurrent-write-"))
        .map((l) => JSON.parse(l).message)
      const uniqueMessages = new Set(messages)
      if (uniqueMessages.size === 5) {
        pass("TEST 6.4: all 5 concurrent entries have distinct messages")
      } else {
        fail("TEST 6.4", `expected 5 distinct messages, got ${uniqueMessages.size}`)
      }
    } catch (e: any) {
      fail("TEST 6.4", `could not verify entries: ${e.message}`)
    }

    process.chdir(origCwd)
    await rm(tmpDir, { recursive: true, force: true })
  }

  // ===================================================================
  // FINAL REPORT
  // ===================================================================
  const total = totalPassed + totalFailed
  console.log(`\n═══════════════════════════════════════`)
  console.log(`RESULTS: ${totalPassed}/${total} passed, ${totalFailed} failed`)
  console.log(`═══════════════════════════════════════`)

  if (totalFailed > 0) {
    const msg = "\n🚨 BLOCKER: catchCause did NOT prevent all crashes!"
    console.log(msg)
    writeLog(msg)
  } else {
    const msg = "\n✅ SUCCESS: catchCause prevented all crashes in all destructive scenarios."
    console.log(msg)
    writeLog(msg)
  }

  process.exit(totalFailed > 0 ? 1 : 0)
}

main()
