import path from "path"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"

export interface PackageInfo {
  readonly name: string
  readonly path: string
  readonly entrypoint?: string
  readonly testCommand?: string
  readonly buildCommand?: string
  readonly dependencies: string[]
}

export interface ProjectMap {
  readonly packages: PackageInfo[]
  readonly configFiles: string[]
  readonly generatedDirs: string[]
  readonly protectedPaths: string[]
  readonly boundaries: { readonly from: string; readonly to: string }[]
  readonly desktop: { readonly main: string; readonly preload: string; readonly renderer: string }
  readonly mcpServers: string[]
  readonly instructions: string[]
}

export const Event = {
  Invalidated: BusEvent.define("project_map.invalidated", Schema.Void),
}

export interface Interface {
  readonly get: () => Effect.Effect<ProjectMap>
  readonly getPackage: (pkgPath: string) => Effect.Effect<Option.Option<PackageInfo>>
  readonly refresh: () => Effect.Effect<ProjectMap>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectMap") {}

export const use = serviceUse(Service)

const configFileGlobs = [
  "*.config.*",
  "tsconfig*",
  ".eslintrc*",
  ".prettierrc*",
  ".babelrc*",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  ".gitignore",
  ".gitattributes",
  "biome.json*",
  "oxlintrc*",
  "*.code-workspace",
]

const generatedDirNames = [
  "node_modules",
  "dist",
  ".build",
  ".opencode",
  ".git",
  ".turbo",
  "out",
  ".sst",
  ".nyc_output",
  "coverage",
  ".rollup",
]

const protectedFilePatterns = [
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  ".env",
  ".env.*",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
]

const emptyMap: ProjectMap = {
  packages: [],
  configFiles: [],
  generatedDirs: [],
  protectedPaths: [],
  boundaries: [],
  desktop: { main: "", preload: "", renderer: "" },
  mcpServers: [],
  instructions: [],
}

export const layer = (root: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const bus = yield* Bus.Service
      const cache = yield* Ref.make<Option.Option<ProjectMap>>(Option.none())

      yield* (yield* bus.subscribe(Event.Invalidated)).pipe(
        Stream.runForEach(() => Ref.set(cache, Option.none())),
        Effect.forkScoped,
      )

      const refreshBody = Effect.gen(function* () {
        const raw: unknown = yield* fs.readJson(path.join(root, "package.json")).pipe(
          Effect.catch(() => Effect.succeed({ workspaces: { packages: ["packages/*"] } })),
        )
        const pkg = raw as Record<string, unknown>
        let patterns: string[] = []
        const ws = pkg.workspaces
        if (Array.isArray(ws)) {
          patterns = ws as string[]
        } else if (ws && typeof ws === "object") {
          const wp = (ws as Record<string, unknown>).packages
          if (Array.isArray(wp)) patterns = wp as string[]
        }
        if (patterns.length === 0) patterns = ["packages/*"]

        const allDirs: string[] = []
        for (const pattern of patterns) {
          if (pattern.includes("*")) {
            const g = pattern.endsWith("/") ? `${pattern}package.json` : `${pattern}/package.json`
            const files: string[] = yield* fs.glob(g, { cwd: root, absolute: true }).pipe(
              Effect.catch(() => Effect.succeed([] as string[])),
            )
            allDirs.push(...files.map((f) => path.dirname(f)))
          } else {
            const fullPath = path.join(root, pattern)
            if (yield* fs.existsSafe(path.join(fullPath, "package.json"))) {
              allDirs.push(fullPath)
            }
          }
        }
        const dirs = [...new Set(allDirs)].sort()

        const results: (PackageInfo | null)[] = yield* Effect.forEach(
          dirs,
          (dir) =>
            Effect.gen(function* () {
              const rawPkg: unknown = yield* fs.readJson(path.join(dir, "package.json")).pipe(
                Effect.catch(() => Effect.succeed(null)),
              )
              if (!rawPkg || typeof rawPkg !== "object") return null
              const p = rawPkg as Record<string, unknown>
              const deps = {
                ...(typeof p.dependencies === "object" && p.dependencies
                  ? (p.dependencies as Record<string, string>)
                  : {}),
                ...(typeof p.devDependencies === "object" && p.devDependencies
                  ? (p.devDependencies as Record<string, string>)
                  : {}),
              }
              const scripts =
                typeof p.scripts === "object" && p.scripts ? (p.scripts as Record<string, string>) : {}
              return {
                name: (typeof p.name === "string" ? p.name : path.basename(dir)) as string,
                path: path.relative(root, dir),
                entrypoint: typeof p.main === "string" ? p.main : undefined,
                testCommand: scripts.test,
                buildCommand: scripts.build ?? scripts.typecheck,
                dependencies: Object.keys(deps),
              } as PackageInfo
            }),
          { concurrency: 8 },
        )
        const packages: PackageInfo[] = results.filter((p): p is PackageInfo => p != null)

        const [configFiles, generatedDirsArr, protectedPaths] = yield* Effect.all([
          Effect.forEach(configFileGlobs, (pattern) =>
            fs.glob(pattern, { cwd: root, absolute: true, dot: true }).pipe(
              Effect.catch(() => Effect.succeed([] as string[])),
            ),
          ).pipe(Effect.map((arrays) => [...new Set(arrays.flat())].sort().map((f) => path.relative(root, f)))),
          Effect.forEach(generatedDirNames, (name) =>
            fs.existsSafe(path.join(root, name)).pipe(Effect.map((ok) => (ok ? name : null))),
          ).pipe(Effect.map((arr) => arr.filter((n): n is string => n !== null))),
          Effect.forEach(protectedFilePatterns, (pattern) =>
            fs.glob(pattern, { cwd: root, absolute: true, dot: true }).pipe(
              Effect.catch(() => Effect.succeed([] as string[])),
              Effect.map((matches) => matches.map((m) => path.relative(root, m))),
            ),
          ).pipe(Effect.map((arrays) => [...new Set(arrays.flat())].sort())),
        ])

        const boundaries: { readonly from: string; readonly to: string }[] = []
        for (const pkg of packages) {
          for (const dep of pkg.dependencies) {
            const target = packages.find((p) => p.name === dep)
            if (target) boundaries.push({ from: pkg.path, to: target.path })
          }
        }

        const desktopDir = path.join(root, "packages", "desktop")
        const [hasMain, hasPreload, hasRenderer] = yield* Effect.all([
          fs.existsSafe(path.join(desktopDir, "src", "main", "index.ts")),
          fs.existsSafe(path.join(desktopDir, "src", "preload", "index.ts")),
          fs.existsSafe(path.join(desktopDir, "src", "renderer", "index.html")),
        ])
        const desktop = {
          main: hasMain ? "packages/desktop/src/main/index.ts" : "",
          preload: hasPreload ? "packages/desktop/src/preload/index.ts" : "",
          renderer: hasRenderer ? "packages/desktop/src/renderer/index.html" : "",
        }

        const mcpServers: string[] = yield* Effect.gen(function* () {
          const servers: string[] = []
          const cfgPath = path.join(root, ".opencode", "config.json")
          if (!(yield* fs.existsSafe(cfgPath))) return servers
          const cfg: unknown = yield* fs.readJson(cfgPath).pipe(Effect.catch(() => Effect.succeed({})))
          const data = cfg as Record<string, unknown>
          const mcp = data.mcp ?? data.MCP ?? []
          if (!Array.isArray(mcp)) return servers
          for (const server of mcp as Record<string, unknown>[]) {
            if (server.type === "local") servers.push(`local:${String(server.command ?? "")}`)
            else if (server.type === "remote") servers.push(`remote:${String(server.url ?? "")}`)
            else servers.push(String(server.name ?? server.command ?? "unknown"))
          }
          return servers
        })

        const instructions: string[] = []
        if (yield* fs.existsSafe(path.join(root, "AGENTS.md"))) instructions.push("AGENTS.md")
        if (yield* fs.existsSafe(path.join(root, "PROJECT.md"))) instructions.push("PROJECT.md")

        const map: ProjectMap = {
          packages,
          configFiles,
          generatedDirs: generatedDirsArr,
          protectedPaths,
          boundaries,
          desktop,
          mcpServers,
          instructions,
        }
        yield* Ref.set(cache, Option.some(map))
        return map
      })

      const get: Interface["get"] = () =>
        Effect.gen(function* () {
          const cached = yield* Ref.get(cache)
          if (Option.isSome(cached)) return cached.value
          return yield* refreshBody
        }).pipe(Effect.catch(() => Effect.succeed(emptyMap)))

      const getPackage: Interface["getPackage"] = (pkgPath) =>
        Effect.gen(function* () {
          const map = yield* get()
          const found = map.packages.find((p) => p.path === pkgPath || p.name === pkgPath)
          return found ? Option.some(found) : Option.none()
        })

      const refresh: Interface["refresh"] = () =>
        Effect.gen(function* () {
          return yield* refreshBody
        }).pipe(Effect.catch(() => Effect.succeed(emptyMap)))

      return Service.of({ get, getPackage, refresh })
    }),
  )

export const defaultLayer = layer(process.cwd()).pipe(
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Bus.defaultLayer),
)

export * as ProjectMap from "./project-map"
