import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import * as crypto from "node:crypto"
import { getStore } from "../../governance/store.js"
import type { DatasetReleaseManifest } from "./types.js"

export async function buildRelease(outputDir: string, version: string): Promise<{ manifest: DatasetReleaseManifest }> {
  const db = await getStore()
  const releaseDir = resolve(outputDir, `release-${version}`)

  // Ensure directory structure
  const dirs = [
    "data/runs", "data/operations", "data/comparisons", "data/artifacts",
    "data/events", "data/machine-profiles",
    "schema", "releases", "supplemental/review-packets",
    "supplemental/source-graphs", "supplemental/semantic-packets",
  ]
  for (const dir of dirs) await mkdir(join(releaseDir, dir), { recursive: true })

  // Pull finalized artifacts from the registry
  const artifacts = await db.query(
    "SELECT * FROM artifacts_v2 WHERE state IN ('finalized','verified') AND artifact_type LIKE 'review%' ORDER BY created_at",
  )

  // Build artifact index
  const artifactIndex = artifacts.rows.map(r => ({
    artifact_id: r.artifact_id,
    artifact_type: r.artifact_type,
    content_digest: r.content_digest,
    byte_count: r.byte_count,
    canonical_path: r.canonical_path,
    producer_tool: r.producer_tool,
    invocation_id: r.invocation_id,
    created_at: r.created_at,
    verification_status: r.verification_status,
  }))

  // Write artifact index as Parquet-like JSON (Parquet writer requires additional deps)
  const indexContent = JSON.stringify(artifactIndex.map(r => JSON.stringify(r)).join("\n"))
  await writeFile(join(releaseDir, "data/artifacts/artifact-index.jsonl"), indexContent)

  // Build release manifest
  const manifest: DatasetReleaseManifest = {
    release_version: version,
    release_id: `release-${version}-${Date.now()}`,
    local_release_artifact_id: "",
    local_release_digest: "",
    dataset_repo_id: process.env.HF_DATASET_REPO || "Tribunus-dev/compute-kernel-evidence",
    created_at: new Date().toISOString(),
    files: [{ path: "data/artifacts/artifact-index.jsonl", digest: crypto.createHash("sha256").update(indexContent).digest("hex"), size_bytes: Buffer.byteLength(indexContent) }],
    artifact_count: artifactIndex.length,
    run_count: 0,
    operation_count: 0,
    tables: ["artifacts/artifact-index"],
    evidence_grades: ["exploratory"],
    source_commit: "",
    publisher_version: "0.6.0",
  }

  await writeFile(join(releaseDir, "releases", "manifest.json"), JSON.stringify(manifest, null, 2))

  // Write dataset card template
  const readme = `---
license: mit
task_categories:
  - text-generation
  - benchmark
tags:
  - apple-silicon
  - mlx
  - inference
  - gemma
dataset_info:
  features:
    - name: artifact_id
      dtype: string
    - name: artifact_type
      dtype: string
---

# Tribunus Apple Silicon Inference Research Dataset

Peer-review dataset for the Tribunus compute kernel decode-attribution and backend-comparison research.

## Evidence Grades

| Grade | Description |
|---|---|
| exploratory | Initial measurement, not yet multiply-verified |
| synthetically_verified | Verified against synthetic ground truth |
| hardware_qualified | Hardware-level measurement qualified |
| claim_grade | Multiply-verified, ready for peer review |
| retracted | Withdrawn — see retraction reason |
| superseded | Replaced by a newer artifact |

## Release

Version: ${version}
Artifacts: ${artifactIndex.length}
`
  await writeFile(join(releaseDir, "README.md"), readme)

  return { manifest }
}
