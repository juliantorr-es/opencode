import { resolve, relative, isAbsolute } from "node:path"
import { realpathSync } from "node:fs"

const AUTHORIZED_ROOTS: { root: string; writable: boolean }[] = []

export function initPathPolicy(worktree: string, evidenceDir: string, modelDir: string, tmpDir: string) {
  AUTHORIZED_ROOTS.length = 0
  AUTHORIZED_ROOTS.push(
    { root: resolve(worktree), writable: false },
    { root: resolve(worktree, "packages/compute-native"), writable: true },
    { root: resolve(evidenceDir), writable: true },
    { root: resolve(modelDir), writable: true },
    { root: resolve(tmpDir), writable: true },
  )
  // Most specific (longest) roots first so writable subdirectory
  // roots win over broader read-only roots on first match.
  AUTHORIZED_ROOTS.sort((a, b) => b.root.length - a.root.length)
}

export function validatePath(p: string, mustBeWritable: boolean): { valid: boolean; resolved: string; error?: string } {
  const resolvedPath = resolve(p)
  const real: string = (() => { try { return realpathSync(resolvedPath) } catch { return resolvedPath } })()
  for (const root of AUTHORIZED_ROOTS) {
    const rootResolved = resolve(root.root)
    const rel = relative(rootResolved, real)
    const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    if (inside) {
      if (mustBeWritable && !root.writable) {
        return { valid: false, resolved: real, error: `path ${real} is not in a writable root` }
      }
      return { valid: true, resolved: real }
    }
  }
  return { valid: false, resolved: real, error: `path ${real} is outside authorized roots` }
}

export function validateOrReject(p: string, mustBeWritable: boolean): string {
  const result = validatePath(p, mustBeWritable)
  if (!result.valid) throw new Error(result.error || "path rejected")
  return result.resolved
}
