import { readdirSync, statSync, readlinkSync, readFileSync } from "node:fs"
import { resolve, relative, normalize } from "node:path"
import { sha256Hex } from "./identity.js"
import type { ArtifactManifest, ArtifactManifestEntry } from "./types.js"

export function buildDirectoryManifest(root: string): ArtifactManifest {
  const entries: ArtifactManifestEntry[] = []

  function walk(dir: string) {
    const items = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      Buffer.from(a.name).compare(Buffer.from(b.name)),
    )
    for (const item of items) {
      const fullPath = resolve(dir, item.name)
      const relPath = normalize(relative(root, fullPath)).replace(/\\/g, "/")
      if (item.isDirectory()) {
        entries.push({ relative_path: relPath + "/", entry_type: "directory", byte_count: 0, file_digest: null, symlink_target: null })
        walk(fullPath)
      } else if (item.isSymbolicLink()) {
        const target = readlinkSync(fullPath)
        entries.push({ relative_path: relPath, entry_type: "symlink", byte_count: 0, file_digest: null, symlink_target: target })
      } else if (item.isFile()) {
        const stat = statSync(fullPath)
        const content = readFileSync(fullPath)
        const digest = sha256Hex(content)
        entries.push({ relative_path: relPath, entry_type: "file", byte_count: stat.size, file_digest: digest, symlink_target: null })
      }
    }
  }

  walk(root)
  return { schema_version: 1, artifact_root: root, entries }
}
