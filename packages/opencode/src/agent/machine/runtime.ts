import { Context, Duration, Effect, Layer, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Service as BinaryManagerService, defaultLayer as BinaryManagerLayer } from "@/binary/manager"
import { spawnSync } from "child_process"
import { resolve } from "path"
import {
  MachineDependenciesService,
  type MachineDef,
  type MachineDependencies,
  MachineRunner,
  MachineState,
  type GrepResult,
  type FindResult,
  type BunResult,
  type MachineId,
} from "./types"

const log = Log.create({ service: "agent.machine.runtime" })

// ─── Tool Implementation Helpers ──────────────────────────────────────────────

function execTool(cmd: string, args: string[], cwd?: string, timeout = 30000): Effect.Effect<string> {
  return (Effect.sync(() => {
    const result = spawnSync(cmd, args, {
      encoding: "utf8" as const,
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    })
    if (result.error) throw result.error
    return result.stdout ?? ""
  }) as Effect.Effect<string>)
}

// ─── Machine Dependencies Implementation ───────────────────────────────────

const makeDependencies: Effect.Effect<MachineDependencies, never, AppFileSystem.Service | BinaryManagerService> = Effect.gen(function* () {
  const fs = yield* AppFileSystem.Service
  const binaryManager = yield* BinaryManagerService

  // Resolve binary paths once at startup (they auto-download if needed)
  const rgPath = yield* binaryManager.resolve("rg")
  const fdPath = yield* binaryManager.resolve("fd")

  const deps: MachineDependencies = {
    // ── Orchestration (stubs — real impl wires through coordination files) ──
    spawn: (_machineId, _laneId, _mission) => Effect.sync(() => _laneId),
    sendDirective: (_targetSession, _kind, _subject, _body) => Effect.void,
    checkHandoffs: () => Effect.sync(() => []),
    recordActivity: (_action, _target, _details) => Effect.void,
    log: (level, message) =>
      Effect.sync(() => {
        if (level === "error") log.error(message)
        else if (level === "warn") log.warn(message)
        else log.info(message)
      }),

    // ── Tool: grep (powered by rg) ──
    grep: (pattern, options) =>
      Effect.gen(function* () {
        const args = ["--no-heading", "--line-number", "--color", "never"]
        if (options?.maxResults) args.push("-m", String(options.maxResults))
        if (options?.contextLines) args.push("-C", String(options.contextLines))
        if (options?.glob) args.push("-g", options.glob)
        args.push(pattern)
        if (options?.path) args.push(options.path)
        const output = yield* execTool(rgPath, args)
        const files = output.split("\n").filter(Boolean).map((line) => {
          const parts = line.split(":")
          return { file: parts[0] ?? "", line: Number(parts[1]) || 0, text: parts.slice(2).join(":") }
        })
        return { files, totalMatches: files.length } satisfies GrepResult
      }),

    // ── Tool: find files (powered by fd) ──
    findFiles: (pattern, options) =>
      Effect.gen(function* () {
        const searchPath = options?.path ?? process.cwd()
        const args = [pattern, searchPath, "--max-results", "50"]
        if (options?.maxDepth) args.push("--max-depth", String(options.maxDepth))
        if (options?.type) args.push("--type", options.type)
        const output = yield* execTool(fdPath, args)
        const files = output.split("\n").filter(Boolean).map((p) => ({
          path: p,
          type: "file" as const,
        }))
        return { files } satisfies FindResult
      }),

    // ── Tool: read source ──
    readSource: (file, _options) =>
      Effect.gen(function* () {
        const exists = yield* fs.existsSafe(file).pipe(Effect.catch(() => Effect.succeed(false as const)))
        if (!exists) return `File not found: ${file}`
        const content = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        return content
      }),

    // ── Tool: git ──
    git: (operation, args, options) =>
      Effect.gen(function* () {
        const gitArgs = [operation]
        if (args) gitArgs.push(...args.split(" "))
        const cwd = options?.path ?? resolve(process.cwd(), "packages/opencode")
        return yield* execTool("git", gitArgs, cwd)
      }),

    // ── Tool: bun ──
    bun: (command, options) =>
      Effect.gen(function* () {
        const cwd = options?.cwd ?? resolve(process.cwd(), "packages/opencode")
        const bunArgs = [command]
        if (options?.args) bunArgs.push(options.args)
        const timeout = (options?.timeoutSeconds ?? 120) * 1000
        const r = (yield* Effect.sync(() =>
          spawnSync("bun", bunArgs, {
            encoding: "utf8" as const,
            cwd,
            timeout,
            maxBuffer: 10 * 1024 * 1024,
          }),
        )) as any
        return {
          exitCode: r.status,
          stdout: r.stdout ?? "",
          stderr: r.stderr ?? "",
        } satisfies BunResult
      }),

    // ── Tool: smart write ──
    smartWrite: (file, content, _reason) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(file, content).pipe(Effect.catch(() => Effect.void))
      }),

    // ── Tool: smart batch ──
    smartBatch: (edits) =>
      Effect.gen(function* () {
        for (const edit of edits) {
          const exists = yield* fs.existsSafe(edit.file).pipe(Effect.catch(() => Effect.succeed(false as const)))
          if (!exists) continue
          const current = yield* fs.readFileString(edit.file).pipe(Effect.catch(() => Effect.succeed("")))
          const updated = current.replace(edit.oldText, edit.newText)
          if (updated !== current) {
            yield* fs.writeFileString(edit.file, updated).pipe(Effect.catch(() => Effect.void))
          }
        }
      }),
  }

  return deps as unknown as MachineDependencies
})

// ─── Machine Dependencies Layer ─────────────────────────────────────────

export const machineDependenciesLayer = Layer.effect(
  MachineDependenciesService,
  makeDependencies,
)

// ─── Machine Runner Implementation ────────────────────────────────────────────

function runMachineLoop(
  def: MachineDef,
  initialState: MachineState,
  deps: MachineDependencies,
  onComplete: (state: MachineState) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    let state = initialState
    let running = true

    while (running) {
      const result = yield* def.handle(state, {
        _tag: "Start",
        laneId: state.laneId,
        mission: (state.data as any)?.mission ?? "",
      })

      state = result

      switch (result.phase) {
        case "completed":
        case "failed":
        case "cancelled":
          running = false
          break
        case "blocked":
          yield* deps.log("info", `Machine ${def.id} blocked: ${result.errors.join(", ")}`)
          running = false
          break
        default:
          yield* deps.log("info", `Machine ${def.id} → phase ${result.phase}`)
          break
      }
    }

    yield* deps.log("info", `Machine ${def.id} finished: ${state.phase}`)
    yield* onComplete(state)
  })
}

// ─── Machine Registry Service ─────────────────────────────────────────────

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentMachineRegistry") {}

export interface Interface {
  readonly register: (def: MachineDef<any>) => Effect.Effect<void>
  readonly spawn: <R>(
    machineId: MachineId,
    laneId: string,
    mission: string,
  ) => Effect.Effect<string, never, R>
  readonly getRunner: (laneId: string) => Effect.Effect<MachineRunner | undefined>
  readonly listRunners: () => Effect.Effect<ReadonlyArray<MachineRunner>>
  readonly cancel: (laneId: string) => Effect.Effect<void>
  readonly cancelAll: () => Effect.Effect<void>
}

const make = Effect.gen(function* () {
  const machines = new Map<string, MachineDef>()
  const runners = new Map<string, MachineRunner>()

  const register = (def: MachineDef<any>): Effect.Effect<void> =>
    Effect.sync(() => {
      machines.set(def.id, def as MachineDef)
    })

  const spawn = (
    machineId: MachineId,
    laneId: string,
    mission: string,
  ) =>
    Effect.gen(function* () {
      const def = machines.get(machineId)
      if (!def) {
        return yield* Effect.die(new Error(`Unknown machine: ${machineId}`))
      }
      const deps = yield* MachineDependenciesService
      const state = new MachineState(
        machineId,
        "idle",
        laneId,
        "",
        { mission },
      )

      yield* deps.log("info", `Spawning machine ${machineId} for lane ${laneId}`)

      const runner = new MachineRunner(def, state, null as any)
      runners.set(laneId, runner)
      return laneId
    })

  const getRunner = (laneId: string): Effect.Effect<MachineRunner | undefined> =>
    Effect.sync(() => runners.get(laneId))

  const listRunners = (): Effect.Effect<ReadonlyArray<MachineRunner>> =>
    Effect.sync(() => Array.from(runners.values()))

  const cancel = (laneId: string): Effect.Effect<void> =>
    Effect.sync(() => {
      runners.delete(laneId)
    })

  const cancelAll = (): Effect.Effect<void> =>
    Effect.sync(() => {
      runners.clear()
    })

  return {
    register,
    spawn,
    getRunner,
    listRunners,
    cancel,
    cancelAll,
  } as Interface
})

export const layer = Layer.effect(Service, make)
export const defaultLayer = Layer.provide(
  Layer.provide(layer, machineDependenciesLayer),
  BinaryManagerLayer,
)
