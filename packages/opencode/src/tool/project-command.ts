import path from "path"
import { Effect, Schema } from "effect"

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm"

const LOCKFILE_PM: Array<[string, PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
]

const PM_PREFIXES: Array<[string, PackageManager]> = [
  ["bun", "bun"],
  ["pnpm", "pnpm"],
  ["yarn", "yarn"],
  ["npm", "npm"],
]

export const resolvePackageManager = Effect.fn("ToolProjectCommand.resolvePackageManager")(function* (root: string) {
  const packageJson = (yield* readPackageJson(root)) as Record<string, unknown> | undefined
  const pm = packageJson?.packageManager
  if (typeof pm === "string") {
    const prefix = PM_PREFIXES.find(([key]) => pm.startsWith(key))
    if (prefix) return prefix[1]
  }

  for (const [file, pm] of LOCKFILE_PM) {
    const hasLockfile = yield* exists(path.join(root, file))
    if (hasLockfile) return pm
  }

  return "bun" satisfies PackageManager
})

export const resolveScriptCommand = Effect.fn("ToolProjectCommand.resolveScriptCommand")(function* (input: {
  root: string
  script: string
  fallback?: string[]
}) {
  const packageJson = (yield* readPackageJson(input.root)) as Record<string, unknown> | undefined
  const scripts = packageJson?.scripts as Record<string, unknown> | undefined

  if (scripts && typeof scripts[input.script] === "string") {
    const pm = yield* resolvePackageManager(input.root)
    return { command: pm, args: ["run", input.script], script: input.script, packageManager: pm }
  }

  if (input.fallback) {
    return {
      command: input.fallback[0]!,
      args: input.fallback.slice(1),
      script: input.script,
      packageManager: yield* resolvePackageManager(input.root),
    }
  }

  const pm = yield* resolvePackageManager(input.root)
  return { command: pm, args: ["run", input.script], script: input.script, packageManager: pm }
})

export const runCommand = Effect.fn("ToolProjectCommand.runCommand")(function* (input: {
  command: string
  args: string[]
  cwd: string
  shellCommand?: string
}) {
  return yield* Effect.promise(async () => {
    const command = input.shellCommand
      ? [process.platform === "win32" ? "cmd" : "sh", ...(process.platform === "win32" ? ["/c"] : ["-lc"]), input.shellCommand]
      : [input.command, ...input.args]
    const proc = Bun.spawn(command, {
      cwd: input.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  })
})

const readPackageJson = Effect.fn("ToolProjectCommand.readPackageJson")(function* (root: string) {
  const file = Bun.file(path.join(root, "package.json"))
  return yield* Effect.promise(() => file.json()).pipe(Effect.catch(() => Effect.succeed(undefined)))
})

const exists = Effect.fn("ToolProjectCommand.exists")(function* (target: string) {
  return yield* Effect.promise(() => Bun.file(target).exists())
})
