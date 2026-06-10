/**
 * HuggingFace Dataset Staging — uploads release files via huggingface-cli.
 * Token is read at runtime from the secrets provider — never hard-coded.
 *
 * Uses `huggingface-cli upload` which handles multipart upload, commit creation,
 * and branch auto-creation. PR must be created manually via the Hub UI.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { governedRun } from "../../governance/subprocess.js"
import { secrets } from "../../governance/secrets.js"

export interface StageResult {
  repo_id: string
  branch: string
  commit_sha: string
  files_uploaded: number
  pr_url: string
  errors: string[]
}

export async function stageRelease(
  releaseDir: string,
  repoId: string,
  version: string,
): Promise<StageResult> {
  const branch = `release/v${version}`
  const result: StageResult = {
    repo_id: repoId,
    branch,
    commit_sha: "",
    files_uploaded: 0,
    pr_url: `https://huggingface.co/datasets/${repoId}/discussions/new?branch=${encodeURIComponent(branch)}`,
    errors: [],
  }

  // Count files
  let fileCount = 0
  async function countFiles(dir: string) {
    const { readdir } = await import("node:fs/promises")
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) await countFiles(join(dir, entry.name))
      else fileCount++
    }
  }
  await countFiles(releaseDir)
  if (fileCount === 0) {
    result.errors.push("No files found in release directory")
    return result
  }
  result.files_uploaded = fileCount

  // Upload via huggingface-cli
  const token = await secrets.require("HF_PUBLISH_TOKEN")
  const cmdResult = await governedRun(
    "huggingface-cli",
    [
      "upload",
      repoId,
      releaseDir,
      branch,
      "--repo-type", "dataset",
      "--commit-message", `Release ${version} — Tribunus MCP v0.6.0`,
    ],
    {
      timeout: 300_000,
      env: { HF_TOKEN: token },
    } as { timeout: number; env?: Record<string, string> },
  )

  if (!cmdResult.ok) {
    result.errors.push(`Upload failed: ${cmdResult.stderr}`)
    return result
  }

  // Extract commit SHA from output if available
  const shaMatch = cmdResult.stdout.match(/([a-f0-9]{40})/)
  if (shaMatch) result.commit_sha = shaMatch[1]

  return result
}
