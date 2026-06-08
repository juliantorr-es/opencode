import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { classifyFilePath, isTextLikePath } from "./file-classifier.js"
import type { CodeFileRecordV1 } from "./store/code-index-types.js"

export type DiscoveredFileV1 = CodeFileRecordV1 & {
  content?: string
  absolute_path: string
  excluded?: boolean
  exclude_reason?: string
}

export type FileDiscoveryResultV1 = {
  files: DiscoveredFileV1[]
  excluded: Array<{
    path: string
    reason: string
  }>
}

function listGitFiles(repoRoot: string, includeUntracked: boolean): string[] {
  const args = includeUntracked
    ? ["ls-files", "--cached", "--others", "--exclude-standard"]
    : ["ls-files", "--cached"]
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 30000 })
  if (result.status !== 0) return []
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function fallbackWalk(repoRoot: string): string[] {
  const results: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue
      const abs = resolve(dir, entry.name)
      const rel = abs.slice(repoRoot.length + 1).replace(/\\/g, "/")
      if (entry.isDirectory()) {
        walk(abs)
      } else {
        results.push(rel)
      }
    }
  }
  if (existsSync(repoRoot)) walk(repoRoot)
  return results
}

function shouldExclude(path: string): string | null {
  if (path.startsWith(".omp/state/")) return "state directory"
  if (path.startsWith(".omp/evidence/")) return "evidence directory"
  if (path.includes("/.git/") || path.startsWith(".git/")) return "git metadata"
  if (path.includes("/node_modules/") || path.startsWith("node_modules/")) return "dependencies"
  if (path.endsWith(".zip") || path.endsWith(".tar") || path.endsWith(".gz") || path.endsWith(".xz")) return "archive"
  return null
}

export function discoverFiles(repoRoot: string, includeUntracked = true): FileDiscoveryResultV1 {
  const candidates = listGitFiles(repoRoot, includeUntracked)
  const tracked = candidates.length > 0 ? candidates : fallbackWalk(repoRoot)
  const files: DiscoveredFileV1[] = []
  const excluded: Array<{ path: string; reason: string }> = []

  for (const relPath of tracked.sort()) {
    const reason = shouldExclude(relPath)
    if (reason) {
      excluded.push({ path: relPath, reason })
      continue
    }

    const classification = classifyFilePath(relPath)
    const abs = resolve(repoRoot, relPath)
    if (!existsSync(abs)) {
      excluded.push({ path: relPath, reason: "missing on disk" })
      continue
    }

    const stat = statSync(abs)
    const buffer = readFileSync(abs)
    const sha256 = createHash("sha256").update(buffer).digest("hex")
    const content = isTextLikePath(relPath) ? buffer.toString("utf8") : undefined
    const lineCount = content ? content.split(/\r?\n/).length : undefined
    const fileId = `file:${relPath}`

    files.push({
      file_id: fileId,
      path: relPath,
      language: classification.language,
      category: classification.category,
      sha256,
      size_bytes: stat.size,
      line_count: lineCount,
      importance: classification.importance,
      inclusion_status: classification.inclusion_status,
      parse_status: classification.parse_status,
      indexed_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      absolute_path: abs,
      content,
    })
  }

  return { files, excluded }
}
