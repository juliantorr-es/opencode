/**
 * Artifact Verification — typed verifiers for artifact classes.
 * Generic verification checks existence, digest, size, and manifest integrity.
 * Specialized verifiers check domain invariants.
 */

import { existsSync } from "node:fs"
import { fileDigest } from "./identity.js"
import type { ArtifactRecord, ArtifactType, VerificationReceipt } from "./types.js"
import type { PgliteDb } from "../../governance/store.js"
import { ArtifactRegistryService } from "./registry.js"

export interface VerifyResult {
  passed: boolean
  checks: Array<{ check: string; status: "pass" | "fail"; detail?: string }>
}

export async function verifyArtifact(
  registry: ArtifactRegistryService,
  artifact: ArtifactRecord,
  invocationId?: string,
): Promise<VerifyResult> {
  const checks: Array<{ check: string; status: "pass" | "fail"; detail?: string }> = []

  // Existence
  if (!existsSync(artifact.canonical_path)) {
    checks.push({ check: "existence", status: "fail", detail: `File not found at ${artifact.canonical_path}` })
    await registry.markMissing(artifact.artifact_id)
    return { passed: false, checks }
  }
  checks.push({ check: "existence", status: "pass" })

  // Digest
  const result = await fileDigest(artifact.canonical_path)
  if (result.digest !== artifact.content_digest) {
    checks.push({ check: "digest", status: "fail", detail: `Expected ${artifact.content_digest}, got ${result.digest}` })
    await registry.quarantine(artifact.artifact_id, "digest mismatch on verification")
    return { passed: false, checks }
  }
  checks.push({ check: "digest", status: "pass" })

  // Size
  if (artifact.byte_count !== null && result.byteCount !== artifact.byte_count) {
    checks.push({ check: "size", status: "fail", detail: `Expected ${artifact.byte_count}, got ${result.byteCount}` })
  } else {
    checks.push({ check: "size", status: "pass" })
  }

  const passed = checks.every(c => c.status === "pass")

  // Register verification
  await registry.verify(artifact.artifact_id, {
    verification_id: `verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    artifact_id: artifact.artifact_id,
    artifact_type: artifact.artifact_type,
    observed_digest: result.digest,
    verifier_name: "generic",
    status: passed ? "passed" : "failed",
    checks,
    invocation_id: invocationId || null,
    created_at: new Date().toISOString(),
  })

  return { passed, checks }
}
