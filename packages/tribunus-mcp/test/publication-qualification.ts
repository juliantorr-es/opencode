/**
 * v0.6.0 Publication Qualification — build, stage, verify
 * Run: HF_PUBLISH_TOKEN=<token> bun run this-file.ts
 */

import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { buildRelease } from "../src/services/publication/build.js"
import { stageRelease } from "../src/services/publication/stage.js"
import { verifyRemote } from "../src/services/publication/verify.js"

const outputDir = resolve(import.meta.dirname, "..", "state", "test-release")
const version = "0.1.0-dev"
await mkdir(outputDir, { recursive: true })

// Phase 1: Build
console.log("Phase 1: Build release candidate")
const buildStart = Date.now()
const buildResult = await buildRelease(outputDir, version)
console.log(`  Completed in ${Date.now() - buildStart}ms`)
console.log(`  Release ID: ${buildResult.manifest.release_id}`)
console.log(`  Artifacts: ${buildResult.manifest.artifact_count}`)
console.log(`  Files: ${buildResult.manifest.files.length}`)

// Phase 2: Stage to HuggingFace
console.log("\nPhase 2: Stage to HuggingFace")
const releaseDir = resolve(outputDir, `release-${version}`)
const stageStart = Date.now()
const stageResult = await stageRelease(releaseDir, buildResult.manifest.dataset_repo_id, version)
console.log(`  Completed in ${Date.now() - stageStart}ms`)
console.log(`  Branch: ${stageResult.branch}`)
console.log(`  Commit SHA: ${stageResult.commit_sha}`)
console.log(`  PR: #${stageResult.pr_number} — ${stageResult.pr_url}`)
console.log(`  Files uploaded: ${stageResult.files_uploaded}`)
if (stageResult.errors.length > 0) {
  console.log(`  Errors: ${stageResult.errors.join("; ")}`)
}

// Phase 3: Verify remote
if (stageResult.commit_sha) {
  console.log("\nPhase 3: Verify remote")
  const verifyResult = await verifyRemote(
    buildResult.manifest.dataset_repo_id,
    stageResult.commit_sha,
    buildResult.manifest,
  )
  console.log(`  Files checked: ${verifyResult.files_checked}`)
  console.log(`  Files matched: ${verifyResult.files_matched}`)
  console.log(`  Mismatches: ${verifyResult.mismatches.length}`)
  console.log(`  Missing remote: ${verifyResult.missing_remote.length}`)
  console.log(`  Verified: ${verifyResult.verified}`)
}

const passed = stageResult.commit_sha && !stageResult.errors.length
console.log(`\n${passed ? "PASSED" : "NEEDS ATTENTION"}`)
process.exit(passed ? 0 : 1)
