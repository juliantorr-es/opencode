/**
 * HuggingFace Dataset Staging — creates PR branches and uploads release files.
 * Token is read at runtime from the secrets provider — never hard-coded.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve, join, relative } from "node:path"
import { createBranch, createPullRequest, commitFiles, getRepoInfo, uploadFile } from "./hf-client.js"
import { sha256Hex } from "../../shared/digests.js"
import type { DatasetReleaseManifest } from "./types.js"

export interface StageResult {
  repo_id: string
  branch: string
  pr_number: number | null
  pr_url: string | null
  commit_sha: string
  files_uploaded: number
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
    pr_number: null,
    pr_url: null,
    commit_sha: "",
    files_uploaded: 0,
    errors: [],
  }

  // Get repo info for base SHA
  try {
    const info = await getRepoInfo(repoId, "dataset")
    if (!info.sha) {
      result.errors.push("No default branch SHA found")
      return result
    }

    // Create release branch
    await createBranch(repoId, branch, info.sha)
  } catch (e) {
    result.errors.push(`Failed to create branch: ${e instanceof Error ? e.message : String(e)}`)
    return result
  }

  // Build commit operations from release directory
  const operations: Array<{ op: string; path: string; content?: string }> = []

  async function addDirectory(dir: string, prefix: string) {
    const { readdir, stat } = await import("node:fs/promises")
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await addDirectory(fullPath, relPath)
      } else if (entry.isFile()) {
        const content = await readFile(fullPath, "utf-8")
        operations.push({ op: "add", path: relPath, content })
        result.files_uploaded++
      }
    }
  }

  await addDirectory(releaseDir, "")

  // Commit all files to the branch
  try {
    const commitResult = await commitFiles(
      repoId,
      operations,
      `Release ${version} — Tribunus MCP v0.6.0 dataset publication`,
      branch,
    )
    result.commit_sha = commitResult.sha
  } catch (e) {
    result.errors.push(`Failed to commit: ${e instanceof Error ? e.message : String(e)}`)
    return result
  }

  // Create PR
  try {
    const pr = await createPullRequest(
      repoId,
      `Release ${version} — Tribunus Dataset Publication`,
      branch,
      "main",
    )
    result.pr_number = pr.number
    result.pr_url = pr.html_url
  } catch (e) {
    result.errors.push(`Failed to create PR: ${e instanceof Error ? e.message : String(e)}`)
  }

  return result
}
