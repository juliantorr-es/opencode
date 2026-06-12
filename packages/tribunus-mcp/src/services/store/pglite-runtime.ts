import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export type PGliteLike = {
  exec(sql: string): Promise<unknown>
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>
  close(): Promise<void>
}

export type PGliteConstructor = new (dbDir: string) => PGliteLike

const ctorCache = new Map<string, Promise<PGliteConstructor>>()

function candidatePackageJsonPaths(repoRoot: string): string[] {
  return [
    resolve(repoRoot, "packages/opencode/package.json"),
    resolve(repoRoot, ".omp/tool-tools-package.json"),
    resolve(repoRoot, "package.json"),
  ]
}

function extractConstructor(mod: Record<string, unknown>): PGliteConstructor | null {
  const named = mod.PGlite
  if (typeof named === "function") return named as PGliteConstructor

  const defaultExport = mod.default
  if (typeof defaultExport === "function") return defaultExport as PGliteConstructor

  if (defaultExport && typeof defaultExport === "object") {
    const nested = (defaultExport as Record<string, unknown>).PGlite
    if (typeof nested === "function") return nested as PGliteConstructor
  }

  return null
}

async function tryLoadFromPackageJson(packageJsonPath: string): Promise<PGliteConstructor | null> {
  try {
    const require = createRequire(packageJsonPath)
    const searchRoots = [
      dirname(packageJsonPath),
      resolve(dirname(packageJsonPath), "node_modules"),
      resolve(dirname(packageJsonPath), "node_modules/.bun/node_modules"),
      resolve(dirname(packageJsonPath), "node_modules/.bun"),
      resolve(packageJsonPath, "..", "..", "node_modules"),
      resolve(packageJsonPath, "..", "..", "node_modules/.bun/node_modules"),
      resolve(packageJsonPath, "..", "..", "node_modules/.bun"),
    ]

    const resolveAndLoad = async (modulePath: string): Promise<PGliteConstructor | null> => {
      const mod = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>
      return extractConstructor(mod)
    }

    try {
      const resolved = require.resolve("@electric-sql/pglite")
      const ctor = await resolveAndLoad(resolved)
      if (ctor) return ctor
    } catch {}

    for (const searchRoot of searchRoots) {
      try {
        const resolved = require.resolve("@electric-sql/pglite", { paths: [searchRoot] })
        const ctor = await resolveAndLoad(resolved)
        if (ctor) return ctor
      } catch {}
    }

    return null
  } catch {
    return null
  }
}

export async function loadPGliteConstructor(repoRoot: string): Promise<PGliteConstructor> {
  const cached = ctorCache.get(repoRoot)
  if (cached) return cached

  const promise = (async () => {
    for (const packageJsonPath of candidatePackageJsonPaths(repoRoot)) {
      const ctor = await tryLoadFromPackageJson(packageJsonPath)
      if (ctor) return ctor
    }
    throw new Error(
      `Unable to resolve @electric-sql/pglite from ${candidatePackageJsonPaths(repoRoot).join(", ")}`,
    )
  })()

  ctorCache.set(repoRoot, promise)
  return promise
}
