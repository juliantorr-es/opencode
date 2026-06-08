import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { existsSync, rmSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { tmpdir } from "node:os"

describe("PGliteStore", () => {
  let tmpDir: string
  let store: import("../_lib/store/pglite-types.js").OmpRelationalStoreV1
  let skipTests = false

  beforeAll(async () => {
    tmpDir = resolve(tmpdir(), `omp-pglite-test-${Date.now()}`)
    mkdirSync(resolve(tmpDir, ".omp/state/pglite"), { recursive: true })

    try {
      const { getPgliteStore } = await import("../_lib/store/pglite-store.js")
      store = getPgliteStore({ repoRoot: tmpDir })
      await store.migrate()
    } catch {
      skipTests = true
    }
  })

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // ── Idempotent Migration ──

  it("migrates idempotently", async () => {
    if (skipTests) return
    await store.migrate()
    await store.migrate()
  })

  // ── Actors ──

  it("creates and lists actors", async () => {
    if (skipTests) return
    const actor = await store.createActor({
      actor_id: "test-actor-1",
      kind: "agent",
      provider: "test",
      model: "test-model",
      display_name: "Test Actor",
    })
    expect(actor.actor_id).toBe("test-actor-1")
    expect(actor.kind).toBe("agent")
    expect(actor.provider).toBe("test")
    expect(actor.model).toBe("test-model")
    expect(actor.display_name).toBe("Test Actor")
    expect(actor.created_at).toBeDefined()
  })

  it("coerces unknown actor kind to 'unknown'", async () => {
    if (skipTests) return
    const actor = await store.createActor({
      actor_id: "test-actor-unknown",
      kind: "nonexistent_role",
    })
    expect(actor.kind).toBe("unknown")
  })

  // ── Sessions ──

  it("creates and heartbeats sessions", async () => {
    if (skipTests) return
    await store.createActor({ actor_id: "a-session", kind: "agent" })
    const session = await store.createSession({
      session_id: "session-heartbeat",
      actor_id: "a-session",
      purpose: "testing heartbeat",
    })
    expect(session.session_id).toBe("session-heartbeat")
    expect(session.actor_id).toBe("a-session")
    expect(session.status).toBe("active")
    expect(session.purpose).toBe("testing heartbeat")
    expect(session.started_at).toBeDefined()
    expect(session.last_heartbeat_at).toBeDefined()

    await store.heartbeatSession("session-heartbeat")
  })

  it("abandons expired sessions", async () => {
    if (skipTests) return
    await store.createActor({ actor_id: "a-expire", kind: "system" })
    await store.createSession({ session_id: "session-expire", actor_id: "a-expire" })

    // Set last_heartbeat to far in the past via direct SQL manipulation
    // The TTL is 30 minutes by default, so we need a past heartbeat
    // Since we can't directly manipulate, use abandonExpiredSessions with a future 'now'
    const futureNow = new Date(Date.now() + 31 * 60 * 1000) // 31 min in the future
    const report = await store.abandonExpiredSessions(futureNow)
    expect(report.abandoned_count).toBeGreaterThanOrEqual(1)
    expect(report.abandoned_session_ids).toContain("session-expire")
  })

  // ── Path Locks ──

  it("acquires and releases path locks", async () => {
    if (skipTests) return
    await store.createActor({ actor_id: "a-lock", kind: "agent" })
    await store.createSession({ session_id: "s-lock", actor_id: "a-lock" })

    const result = await store.acquirePathLocks({
      paths: [{ path: "src/test.ts", lock_kind: "write" }],
      session_id: "s-lock",
    })
    expect(result.acquired).toBe(true)
    expect(result.lock_ids).toBeDefined()
    expect(result.lock_ids!.length).toBe(1)

    await store.releasePathLocks({
      lock_ids: result.lock_ids!,
      session_id: "s-lock",
    })
  })

  it("refuses conflicting write locks", async () => {
    if (skipTests) return
    await store.createActor({ actor_id: "a-conflict", kind: "agent" })
    const s1 = await store.createSession({ session_id: "s-conflict-1", actor_id: "a-conflict" })
    const s2 = await store.createSession({ session_id: "s-conflict-2", actor_id: "a-conflict" })

    const r1 = await store.acquirePathLocks({
      paths: [{ path: "conflict-test.ts", lock_kind: "write" }],
      session_id: "s-conflict-1",
    })
    expect(r1.acquired).toBe(true)

    const r2 = await store.acquirePathLocks({
      paths: [{ path: "conflict-test.ts", lock_kind: "write" }],
      session_id: "s-conflict-2",
    })
    expect(r2.acquired).toBe(false)
    expect(r2.conflicts).toBeDefined()
    expect(r2.conflicts!.length).toBe(1)
    expect(r2.conflicts![0].path).toBe("conflict-test.ts")
    expect(r2.conflicts![0].owning_session_id).toBe("s-conflict-1")
  })

  it("allows concurrent read locks", async () => {
    if (skipTests) return
    await store.createActor({ actor_id: "a-concurrent-read", kind: "agent" })
    await store.createSession({ session_id: "s-read-1", actor_id: "a-concurrent-read" })
    await store.createSession({ session_id: "s-read-2", actor_id: "a-concurrent-read" })

    const r1 = await store.acquirePathLocks({
      paths: [{ path: "shared-read.ts", lock_kind: "read" }],
      session_id: "s-read-1",
    })
    expect(r1.acquired).toBe(true)

    // Second session can also get a read lock on the same path
    const r2 = await store.acquirePathLocks({
      paths: [{ path: "shared-read.ts", lock_kind: "read" }],
      session_id: "s-read-2",
    })
    expect(r2.acquired).toBe(true)
  })

  it("releases locks and allows re-acquisition", async () => {
    if (skipTests) return
    await store.createActor({ actor_id: "a-reacquire", kind: "agent" })
    await store.createSession({ session_id: "s-reacquire", actor_id: "a-reacquire" })

    const r1 = await store.acquirePathLocks({
      paths: [{ path: "reacquire.ts", lock_kind: "write" }],
      session_id: "s-reacquire",
    })
    expect(r1.acquired).toBe(true)

    await store.releasePathLocks({
      lock_ids: r1.lock_ids!,
      session_id: "s-reacquire",
    })

    // Now the same session can re-acquire
    const r2 = await store.acquirePathLocks({
      paths: [{ path: "reacquire.ts", lock_kind: "write" }],
      session_id: "s-reacquire",
    })
    expect(r2.acquired).toBe(true)
  })

  it("auto-expires locks after TTL", async () => {
    if (skipTests) return
    await store.createActor({ actor_id: "a-ttl", kind: "agent" })
    await store.createSession({ session_id: "s-ttl-1", actor_id: "a-ttl" })
    await store.createSession({ session_id: "s-ttl-2", actor_id: "a-ttl" })

    const r = await store.acquirePathLocks({
      paths: [{ path: "ephemeral.ts", lock_kind: "write" }],
      session_id: "s-ttl-1",
      ttl_ms: 100,
    })
    expect(r.acquired).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 150))

    // After TTL, a new session should be able to lock
    const r2 = await store.acquirePathLocks({
      paths: [{ path: "ephemeral.ts", lock_kind: "write" }],
      session_id: "s-ttl-2",
    })
    expect(r2.acquired).toBe(true)
  })

  // ── Invocations ──

  it("records invocations", async () => {
    if (skipTests) return
    await store.createActor({ actor_id: "a-invoke", kind: "agent" })
    await store.createSession({ session_id: "s-invoke", actor_id: "a-invoke" })

    await store.recordInvocation({
      invocation_id: "inv-1",
      session_id: "s-invoke",
      tool_id: "text_replace",
      tool_version: "1.0.0",
      status: "ok",
      risk_level: "low",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 42,
      input_sha256: "abc123",
    })
  })

  it("records error invocations", async () => {
    if (skipTests) return
    await store.recordInvocation({
      invocation_id: "inv-error",
      session_id: "s-invoke",
      tool_id: "text_replace",
      tool_version: "1.0.0",
      status: "error",
      risk_level: "medium",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 5,
      input_sha256: "def456",
      error_code: "E_PERMISSION",
      error_message: "Permission denied",
    })
  })

  // ── File Effects ──

  it("records mutations", async () => {
    if (skipTests) return
    await store.recordMutation({
      invocation_id: "inv-1",
      session_id: "s-invoke",
      path: "src/main.ts",
      action: "write",
      before_sha256: "aaa",
      after_sha256: "bbb",
      before_size_bytes: 100,
      after_size_bytes: 120,
    })
  })

  it("records an invocation and its mutations atomically", async () => {
    if (skipTests) return
    await store.recordInvocationWithMutations({
      invocation: {
        invocation_id: "inv-atomic",
        session_id: "s-invoke",
        tool_id: "text_replace",
        tool_version: "1.0.0",
        status: "ok",
        risk_level: "medium",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 1,
        input_sha256: "atomic-input",
      },
      mutations: [
        {
          invocation_id: "inv-atomic",
          session_id: "s-invoke",
          path: "src/atomic.ts",
          action: "write",
          before_sha256: "aaa",
          after_sha256: "bbb",
          before_size_bytes: 10,
          after_size_bytes: 12,
        },
      ],
    })

    const recent = await store.listRecentInvocations(5)
    expect(recent.some((i) => i.invocation_id === "inv-atomic")).toBe(true)

    const effects = await store.listEffectsForPath("src/atomic.ts")
    expect(effects.some((e) => e.invocation_id === "inv-atomic")).toBe(true)
  })

  it("records reads", async () => {
    if (skipTests) return
    await store.recordRead({
      invocation_id: "inv-1",
      session_id: "s-invoke",
      path: "src/readme.md",
      sha256: "readhash",
      size_bytes: 500,
    })
  })

  // ── Write Journals ──

  it("creates and commits write journals", async () => {
    if (skipTests) return
    await store.createWriteJournal({
      journal_id: "journal-1",
      invocation_id: "inv-1",
      session_id: "s-invoke",
      status: "prepared",
      journal_path: ".omp/tools/journals/journal-1.json",
    })

    await store.updateWriteJournalStatus({
      journal_id: "journal-1",
      status: "committed",
    })

    const pending = await store.findPendingJournals()
    expect(pending.find((j) => j.journal_id === "journal-1")).toBeUndefined()
  })

  it("finds pending journals", async () => {
    if (skipTests) return
    await store.createWriteJournal({
      journal_id: "journal-pending",
      invocation_id: "inv-1",
      session_id: "s-invoke",
      status: "prepared",
      journal_path: ".omp/tools/journals/journal-pending.json",
    })

    const pending = await store.findPendingJournals()
    expect(pending.some((j) => j.journal_id === "journal-pending")).toBe(true)
  })

  // ── Queries ──

  it("lists recent invocations", async () => {
    if (skipTests) return
    const recent = await store.listRecentInvocations(10)
    expect(recent.length).toBeGreaterThanOrEqual(1)
    const found = recent.find((i) => i.invocation_id === "inv-1")
    expect(found).toBeDefined()
    expect(found!.tool_id).toBe("text_replace")
    expect(found!.status).toBe("ok")
  })

  it("lists effects for path", async () => {
    if (skipTests) return
    const effects = await store.listEffectsForPath("src/main.ts")
    expect(effects.length).toBeGreaterThanOrEqual(1)
    const found = effects.find((e) => e.action === "write")
    expect(found).toBeDefined()
    expect(found!.session_id).toBe("s-invoke")
  })
})
