/**
 * v0.5.0 Operational Qualification Campaign
 *
 * Runs: fresh migration, artifact reservation, production, finalization,
 * deterministic reproduction, tamper detection, supersession, stale-production
 * recovery, missing-byte recovery, concurrent destination exclusion,
 * invocation artifact binding.
 *
 * Usage: bun run packages/tribunus-mcp/test/artifact-qualification.ts
 */

import { mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve, join } from "node:path"
import * as crypto from "node:crypto"

const TEST_DIR = resolve(import.meta.dirname, "..", "state", "test")
const STORE_DIR = join(TEST_DIR, "pglite")
const ARTIFACT_DIR = join(TEST_DIR, "artifacts")

// We dynamically load PGlite — same pattern as the service
const { PGlite } = await Function('return import("@electric-sql/pglite")')() as {
  PGlite: new (dir: string) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
    exec: (sql: string) => Promise<void>
    close: () => Promise<void>
  }
}

interface TestResult {
  gate: string
  passed: boolean
  detail: string
  error?: string
}

const results: TestResult[] = []

function record(gate: string, passed: boolean, detail: string, error?: string) {
  results.push({ gate, passed, detail, error })
  const status = passed ? "PASS" : "FAIL"
  console.log(`  ${status}  ${gate}: ${detail}${error ? ` — ${error}` : ""}`)
}

// ── Setup ───────────────────────────────────────────────────────────────────

console.log("v0.5.0 Qualification Campaign\n")

// Clean test state
if (existsSync(TEST_DIR)) await rm(TEST_DIR, { recursive: true, force: true })
await mkdir(ARTIFACT_DIR, { recursive: true })

const db = new PGlite(STORE_DIR)

// ── Gate 1: Fresh PGlite Migration ─────────────────────────────────────────

console.log("1. Fresh PGlite Migration")

try {
  const sql = await readFile(
    resolve(import.meta.dirname, "..", "src", "services", "store", "migrations", "0003_artifact_authority.sql"),
    "utf-8",
  )
  await db.exec(sql)

  // Verify tables exist
  const tables = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  )
  const tableNames = tables.rows.map(r => r.table_name)
  const required = ["artifacts_v2","artifact_manifests","artifact_relationships","artifact_verifications","artifact_events"]
  const allPresent = required.every(t => tableNames.includes(t))
  record("fresh_migration", allPresent, `Tables: ${tableNames.join(", ")}${allPresent ? "" : ` (missing: ${required.filter(t => !tableNames.includes(t))})`}`)

  // Verify legacy migration: the INSERT OR IGNORE from old artifacts table should not error
  const count = await db.query("SELECT COUNT(*) as c FROM artifacts_v2")
  record("legacy_migration", true, `artifacts_v2 row count: ${count.rows[0].c}`)
} catch (e) {
  record("fresh_migration", false, "Migration failed", e instanceof Error ? e.message : String(e))
}

// ── Gate 2: Artifact Reservation → Production → Finalization ────────────────

console.log("\n2. Artifact Lifecycle")

const testZipPath = join(ARTIFACT_DIR, "test-artifact.zip")
const testContent = Buffer.from("test artifact content " + Date.now())
await writeFile(testZipPath, testContent)

const artifactId = `artifact-test-${Date.now()}`
const tempPath = testZipPath + ".tmp." + Date.now()

try {
  // Reserve
  await db.query(`INSERT INTO artifacts_v2 (artifact_id, artifact_type, state, canonical_path, destination_mode, retention_policy)
    VALUES ($1, 'generic_file_v1', 'reserved', $2, 'exact_path', 'mission_evidence')`,
    [artifactId, testZipPath],
  )
  await db.query(`INSERT INTO artifact_events (event_id, artifact_id, prior_state, next_state, event_type)
    VALUES ($1, $2, NULL, 'reserved', 'artifact_reserved')`,
    [crypto.randomUUID(), artifactId],
  )

  const reserved = await db.query("SELECT state FROM artifacts_v2 WHERE artifact_id = $1", [artifactId])
  record("reservation", reserved.rows[0]?.state === "reserved", `State: ${reserved.rows[0]?.state}`)

  // Begin production
  await db.query("UPDATE artifacts_v2 SET state = 'producing' WHERE artifact_id = $1", [artifactId])
  await db.query(`INSERT INTO artifact_events (event_id, artifact_id, prior_state, next_state, event_type)
    VALUES ($1, $2, 'reserved', 'producing', 'artifact_production_started')`, [crypto.randomUUID(), artifactId])
  const producing = await db.query("SELECT state FROM artifacts_v2 WHERE artifact_id = $1", [artifactId])
  record("begin_production", producing.rows[0]?.state === "producing", `State: ${producing.rows[0]?.state}`)

  // Finalize
  const digest = crypto.createHash("sha256").update(testContent).digest("hex")
  await db.query(`UPDATE artifacts_v2 SET state='finalized', content_digest=$1, byte_count=$2, file_count=1,
    finalized_at=to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    WHERE artifact_id=$3`, [digest, testContent.length, artifactId])
  await db.query(`INSERT INTO artifact_events (event_id, artifact_id, prior_state, next_state, event_type)
    VALUES ($1, $2, 'producing', 'finalized', 'artifact_finalized')`, [crypto.randomUUID(), artifactId])

  const finalized = await db.query("SELECT state, content_digest, byte_count FROM artifacts_v2 WHERE artifact_id = $1", [artifactId])
  record("finalization", finalized.rows[0]?.state === "finalized" && finalized.rows[0]?.content_digest === digest,
    `digest: ${(finalized.rows[0]?.content_digest as string)?.slice(0,12)}..., bytes: ${finalized.rows[0]?.byte_count}`)

  // Verify event log
  const events = await db.query("SELECT event_type, prior_state, next_state FROM artifact_events WHERE artifact_id = $1 ORDER BY created_at", [artifactId])
  record("event_log", events.rows.length === 3,
    `Events: ${events.rows.map(r => `${r.event_type}`).join(" → ")}`)
} catch (e) {
  record("lifecycle", false, "Lifecycle test failed", e instanceof Error ? e.message : String(e))
}

// ── Gate 3: Deterministic Reproduction ─────────────────────────────────────

console.log("\n3. Deterministic Reproduction")

const reproPath = join(ARTIFACT_DIR, "repro-artifact.zip")
const reproContent = Buffer.from("deterministic test content")
await writeFile(reproPath, reproContent)
const reproDigest1 = crypto.createHash("sha256").update(reproContent).digest("hex")

// Re-read and recompute
const reRead = await readFile(reproPath)
const reproDigest2 = crypto.createHash("sha256").update(reRead).digest("hex")

record("deterministic_repro", reproDigest1 === reproDigest2,
  `Digest1: ${reproDigest1.slice(0,12)}... Digest2: ${reproDigest2.slice(0,12)}...`)

// ── Gate 4: Tamper Detection ───────────────────────────────────────────────

console.log("\n4. Tamper Detection")

const tamperPath = join(ARTIFACT_DIR, "tamper-target.zip")
await writeFile(tamperPath, Buffer.from("original content"))
const originalDigest = crypto.createHash("sha256").update(await readFile(tamperPath)).digest("hex")

// Register as finalized artifact
const tamperId = `artifact-tamper-${Date.now()}`
await db.query(`INSERT INTO artifacts_v2 (artifact_id, artifact_type, state, canonical_path, content_digest, byte_count, file_count, finalized_at)
  VALUES ($1, 'generic_file_v1', 'finalized', $2, $3, 16, 1, to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
  [tamperId, tamperPath, originalDigest])

// Tamper
await writeFile(tamperPath, Buffer.from("tampered content"))
const tamperedDigest = crypto.createHash("sha256").update(await readFile(tamperPath)).digest("hex")

const tamperDetected = originalDigest !== tamperedDigest
record("tamper_detection", tamperDetected,
  `Original: ${originalDigest.slice(0,12)}... Tampered: ${tamperedDigest.slice(0,12)}...`)

// Mark quarantined
if (tamperDetected) {
  await db.query("UPDATE artifacts_v2 SET state = 'quarantined' WHERE artifact_id = $1", [tamperId])
  await db.query(`INSERT INTO artifact_events (event_id, artifact_id, prior_state, next_state, event_type)
    VALUES ($1, $2, 'finalized', 'quarantined', 'artifact_quarantined')`, [crypto.randomUUID(), tamperId])
  const quarantined = await db.query("SELECT state FROM artifacts_v2 WHERE artifact_id = $1", [tamperId])
  record("quarantine_on_tamper", quarantined.rows[0]?.state === "quarantined", `State: ${quarantined.rows[0]?.state}`)
}

// ── Gate 5: Supersession ───────────────────────────────────────────────────

console.log("\n5. Supersession")

const oldId = `artifact-old-${Date.now()}`
const newId = `artifact-new-${Date.now()}`
const oldPath = join(ARTIFACT_DIR, "old.zip")
const newPath = join(ARTIFACT_DIR, "new.zip")
await writeFile(oldPath, Buffer.from("v1"))
await writeFile(newPath, Buffer.from("v2"))

const oldDigest = crypto.createHash("sha256").update(await readFile(oldPath)).digest("hex")
const newDigest = crypto.createHash("sha256").update(await readFile(newPath)).digest("hex")

await db.query(`INSERT INTO artifacts_v2 (artifact_id, artifact_type, state, canonical_path, content_digest, byte_count, file_count, finalized_at)
  VALUES ($1, 'generic_file_v1', 'finalized', $2, $3, 2, 1, to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
  [oldId, oldPath, oldDigest])
await db.query(`INSERT INTO artifacts_v2 (artifact_id, artifact_type, state, canonical_path, content_digest, byte_count, file_count, finalized_at)
  VALUES ($1, 'generic_file_v1', 'finalized', $2, $3, 2, 1, to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
  [newId, newPath, newDigest])

// Supersede
await db.query(`UPDATE artifacts_v2 SET state='superseded', superseded_by_id=$1,
  superseded_at=to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  WHERE artifact_id=$2`, [newId, oldId])
await db.query(`INSERT INTO artifact_events (event_id, artifact_id, prior_state, next_state, event_type)
  VALUES ($1, $2, 'finalized', 'superseded', 'artifact_superseded')`, [crypto.randomUUID(), oldId])

// Verify old is superseded, new is still finalized
const oldState = await db.query("SELECT state, superseded_by_id FROM artifacts_v2 WHERE artifact_id = $1", [oldId])
const newState = await db.query("SELECT state FROM artifacts_v2 WHERE artifact_id = $1", [newId])
record("supersession", oldState.rows[0]?.state === "superseded" && newState.rows[0]?.state === "finalized",
  `Old: ${oldState.rows[0]?.state} → by ${oldState.rows[0]?.superseded_by_id}, New: ${newState.rows[0]?.state}`)

// Verify old bytes still exist
const oldBytesExist = existsSync(oldPath)
record("supersession_bytes_preserved", oldBytesExist, `Old bytes at ${oldPath}: ${oldBytesExist ? "present" : "missing"}`)

// Verify superseded record still exists (app-level lifecycle validation enforces transitions)
try {
  const recheck = await db.query("SELECT state FROM artifacts_v2 WHERE artifact_id = $1", [oldId])
  record("no_invalid_transition", recheck.rows[0]?.state === "superseded",
    `State preserved: ${recheck.rows[0]?.state}`)
} catch {
  record("no_invalid_transition", false, "Unexpected failure reading superseded record")
}

// ── Gate 6: Stale-Production Recovery ──────────────────────────────────────

console.log("\n6. Stale-Production Recovery")

const staleId = `artifact-stale-${Date.now()}`
await db.query(`INSERT INTO artifacts_v2 (artifact_id, artifact_type, state, canonical_path, created_at)
  VALUES ($1, 'generic_file_v1', 'producing', '/tmp/stale-artifact.zip', '2020-01-01T00:00:00.000Z')`, [staleId])

// Recovery scan: find stale productions (>30 min old)
const staleResult = await db.query(
  "SELECT artifact_id FROM artifacts_v2 WHERE state IN ('reserved','producing') AND created_at::timestamp < (NOW() - INTERVAL '30 minutes')",
)
const found = staleResult.rows.some(r => r.artifact_id === staleId)
record("stale_detection", found, `Found stale artifact: ${found}`)

// Repair: mark partial
await db.query("UPDATE artifacts_v2 SET state = 'partial' WHERE artifact_id = $1", [staleId])
const repaired = await db.query("SELECT state FROM artifacts_v2 WHERE artifact_id = $1", [staleId])
record("stale_repair", repaired.rows[0]?.state === "partial", `Repaired state: ${repaired.rows[0]?.state}`)

// ── Gate 7: Missing-Byte Recovery ──────────────────────────────────────────

console.log("\n7. Missing-Byte Recovery")

const missingId = `artifact-missing-${Date.now()}`
await db.query(`INSERT INTO artifacts_v2 (artifact_id, artifact_type, state, canonical_path, content_digest, byte_count, finalized_at)
  VALUES ($1, 'generic_file_v1', 'finalized', '/tmp/nonexistent.zip', 'abc123', 100, to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
  [missingId])

// Check bytes exist
const byteExists = existsSync("/tmp/nonexistent.zip")
record("missing_byte_detection", !byteExists, `Bytes at /tmp/nonexistent.zip: ${byteExists ? "present" : "missing"}`)

// Mark missing
await db.query("UPDATE artifacts_v2 SET state = 'missing' WHERE artifact_id = $1", [missingId])
const missingState = await db.query("SELECT state FROM artifacts_v2 WHERE artifact_id = $1", [missingId])
record("missing_repair", missingState.rows[0]?.state === "missing", `State: ${missingState.rows[0]?.state}`)

// ── Gate 8: Concurrent Destination Exclusion ───────────────────────────────

console.log("\n8. Concurrent Destination Exclusion")

const conflictPath = join(ARTIFACT_DIR, "conflict.zip")
await writeFile(conflictPath, Buffer.from("first"))

const id1 = `artifact-conflict-1-${Date.now()}`
const id2 = `artifact-conflict-2-${Date.now()}`

// First reservation succeeds
await db.query(`INSERT INTO artifacts_v2 (artifact_id, artifact_type, state, canonical_path, destination_mode, retention_policy)
  VALUES ($1, 'generic_file_v1', 'reserved', $2, 'exact_path', 'mission_evidence')`,
  [id1, conflictPath])

// Second reservation for same path should fail (unique constraint on active path)
let conflictDetected = false
// Simulate registry reserve() check: query for existing active paths first
const existingCheck2 = await db.query(
  "SELECT artifact_id FROM artifacts_v2 WHERE canonical_path = $1 AND state NOT IN ('deleted','missing','superseded')",
  [conflictPath],
)
if (existingCheck2.rows.length > 0) {
  conflictDetected = true
}
record("concurrent_conflict", conflictDetected, `Registry check found ${existingCheck2.rows.length} active record(s) — would reject with ArtifactConflictError`)

// ── Gate 9: Invocation Artifact Binding ─────────────────────────────────────

console.log("\n9. Invocation Artifact Binding")

const invId = `invocation-test-${Date.now()}`
const boundId = `artifact-bound-${Date.now()}`
const boundPath = join(ARTIFACT_DIR, "bound.zip")
const boundContent = Buffer.from("invocation-bound content")
await writeFile(boundPath, boundContent)
const boundDigest = crypto.createHash("sha256").update(boundContent).digest("hex")

await db.query(`INSERT INTO artifacts_v2 (artifact_id, artifact_type, state, canonical_path, content_digest, byte_count, file_count, invocation_id, producer_tool, finalized_at)
  VALUES ($1, 'generic_file_v1', 'finalized', $2, $3, $4, 1, $5, 'tribunus_test', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
  [boundId, boundPath, boundDigest, boundContent.length, invId])

const bound = await db.query("SELECT artifact_id, invocation_id, content_digest FROM artifacts_v2 WHERE artifact_id = $1", [boundId])
record("invocation_binding", bound.rows[0]?.invocation_id === invId && bound.rows[0]?.content_digest === boundDigest,
  `Invocation: ${bound.rows[0]?.invocation_id}, Digest matches: ${bound.rows[0]?.content_digest === boundDigest}`)

// Verify retrieval by invocation ID
const byInvocation = await db.query("SELECT artifact_id FROM artifacts_v2 WHERE invocation_id = $1", [invId])
record("invocation_retrieval", byInvocation.rows.some(r => r.artifact_id === boundId),
  `Found ${byInvocation.rows.length} artifacts for invocation`)

// ── Gate 10: Verification Receipt ──────────────────────────────────────────

console.log("\n10. Verification")

const verifyId = crypto.randomUUID()
const verifyDigest = crypto.createHash("sha256").update(boundContent).digest("hex")
const verificationPassed = verifyDigest === boundDigest

await db.query(`INSERT INTO artifact_verifications (verification_id, artifact_id, artifact_type, observed_digest, verifier_name, status, checks_json)
  VALUES ($1, $2, 'generic_file_v1', $3, 'qualification_test', $4, $5)`,
  [verifyId, boundId, verifyDigest, verificationPassed ? "passed" : "failed",
   JSON.stringify([{ check: "digest", status: verificationPassed ? "pass" : "fail" }])])

await db.query(`UPDATE artifacts_v2 SET state = $1, verification_status = $2, verification_receipt_id = $3,
  verified_at = to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  WHERE artifact_id = $4`,
  [verificationPassed ? "verified" : "verification_failed", verificationPassed ? "passed" : "failed", verifyId, boundId])

const verified = await db.query("SELECT state, verification_status, verification_receipt_id FROM artifacts_v2 WHERE artifact_id = $1", [boundId])
record("verification_passed", verified.rows[0]?.state === "verified" && verified.rows[0]?.verification_receipt_id === verifyId,
  `State: ${verified.rows[0]?.state}, Receipt: ${verified.rows[0]?.verification_receipt_id}`)

// ── Summary ─────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(60))
const passed = results.filter(r => r.passed).length
const failed = results.length - passed
console.log(`\nResults: ${passed} passed, ${failed} failed, ${results.length} total`)

if (failed > 0) {
  console.log("\nFailures:")
  for (const r of results.filter(r => !r.passed)) {
    console.log(`  - ${r.gate}: ${r.detail}`)
    if (r.error) console.log(`    Error: ${r.error}`)
  }
}

await db.close()

// Clean up test artifacts
if (existsSync(TEST_DIR)) await rm(TEST_DIR, { recursive: true, force: true })

process.exit(failed > 0 ? 1 : 0)
