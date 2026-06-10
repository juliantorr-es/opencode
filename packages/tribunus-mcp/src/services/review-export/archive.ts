import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import type { ReviewExportProgressSinkV1 } from "./progress.js"

export type ZipArchiveBackendV1 = {
  kind: "zip-cli"
  zipDirectory(args: {
    source_dir: string
    archive_path: string
    stage: "semantic_zip" | "source_zip"
    progress?: ReviewExportProgressSinkV1
  }): {
    archive_path: string
    entries_written: number
    bytes_written: number
    size_bytes: number
    sha256: string
  }
}

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const abs = resolve(current, entry.name)
      if (entry.isDirectory()) {
        walk(abs, rel)
      } else {
        files.push(abs)
      }
    }
  }
  walk(dir, "")
  return files
}

function archiveSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export function createZipCliArchiveBackend(): ZipArchiveBackendV1 {
  return {
    kind: "zip-cli",
    zipDirectory(args) {
      const entries = listFilesRecursive(args.source_dir)
      const bytesWritten = entries.reduce((sum, entry) => sum + statSync(entry).size, 0)
      args.progress?.({
        stage: args.stage,
        status: "start",
        entries_written: 0,
        bytes_written: 0,
        message: `Packing ${entries.length} file(s) with zip-cli`,
      })

      const archiveDir = dirname(args.archive_path)
      if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true })
      rmSync(args.archive_path, { force: true })

      const zipResult = spawnSync("zip", ["-q", "-r", args.archive_path, basename(args.source_dir)], {
        cwd: dirname(args.source_dir),
        timeout: 300000,
        encoding: "utf8",
      })
      if (zipResult.error) {
        throw new Error(zipResult.error.message.includes("ENOENT")
          ? "zip binary not found on host — install zip or swap the archive backend"
          : `Zip creation failed: ${zipResult.error.message}`)
      }
      if (zipResult.status !== 0) {
        throw new Error(zipResult.stderr || zipResult.stdout || "zip failed")
      }

      const sizeBytes = existsSync(args.archive_path) ? statSync(args.archive_path).size : 0
      const sha256 = archiveSha256(args.archive_path)

      args.progress?.({
        stage: args.stage,
        status: "done",
        entries_written: entries.length,
        bytes_written: sizeBytes,
        message: `Wrote ${entries.length} file(s) to ${args.archive_path}`,
      })

      return {
        archive_path: args.archive_path,
        entries_written: entries.length,
        bytes_written: bytesWritten,
        size_bytes: sizeBytes,
        sha256,
      }
    },
  }
}
