import { Context, Duration, Effect, Schema } from "effect"

// ─── Machine ID ───────────────────────────────────────────────────────────────

export const MachineId = Schema.Literals([
  "general-man",
  "secretary",
  "cartographer",
  "surveyor",
  "compass",
  "soundings",
  "logbook",
  "architect",
  "foundation",
  "load-bearer",
  "building-inspector",
  "blueprint",
  "zoning-board",
  "critic",
  "witness",
  "coroner",
  "precedent",
  "blast-radius",
  "reasonable-doubt",
  "exhibit-a",
  "appeal",
  "surgeon",
  "scalpel",
  "vitals",
  "stress-test",
  "second-opinion",
  "tourniquet",
  "monitor",
  "trial",
  "journalist",
  "scoop",
  "editor",
  "byline",
  "press",
  "retort",
  "headline",
  "qa-observer",
  "red-team",
  "ems",
])
export type MachineId = Schema.Schema.Type<typeof MachineId>

// ─── Machine Phase ────────────────────────────────────────────────────────────

export const Phase = Schema.Literals([
  "idle",
  "learning",
  "planning",
  "review",
  "execution",
  "validation",
  "publication",
  "completed",
  "failed",
  "blocked",
  "cancelled",
])
export type Phase = Schema.Schema.Type<typeof Phase>

// ─── Machine State ────────────────────────────────────────────────────────────

export class MachineState<D extends Record<string, any> = Record<string, any>> {
  constructor(
    readonly machineId: MachineId,
    readonly phase: Phase,
    readonly laneId: string,
    readonly sessionId: string,
    readonly data: D,
    readonly errors: ReadonlyArray<string> = [],
    readonly startedAt: number = Date.now(),
    readonly phaseChangedAt: number = Date.now(),
  ) {}

  transition<T extends Record<string, any>>(
    nextPhase: Phase,
    data?: Partial<D>,
  ): MachineState<T> {
    return new MachineState<T>(
      this.machineId,
      nextPhase,
      this.laneId,
      this.sessionId,
      { ...this.data, ...data } as T,
      this.errors,
      this.startedAt,
      Date.now(),
    )
  }

  withError(error: string): MachineState<D> {
    return new MachineState<D>(
      this.machineId,
      this.phase,
      this.laneId,
      this.sessionId,
      this.data,
      [...this.errors, error],
      this.startedAt,
      this.phaseChangedAt,
    )
  }

  get elapsed(): number {
    return Date.now() - this.startedAt
  }

  get phaseElapsed(): number {
    return Date.now() - this.phaseChangedAt
  }
}

// ─── Machine Events ───────────────────────────────────────────────────────────

export type MachineEvent =
  | { readonly _tag: "Start"; readonly laneId: string; readonly mission: string }
  | { readonly _tag: "PhaseComplete"; readonly phase: Phase; readonly result: unknown }
  | { readonly _tag: "PhaseFailed"; readonly phase: Phase; readonly error: string }
  | { readonly _tag: "Blocked"; readonly reason: string; readonly options: ReadonlyArray<{ id: string; description: string }> }
  | { readonly _tag: "Directive"; readonly action: string; readonly payload: Record<string, unknown> }
  | { readonly _tag: "Cancel" }
  | { readonly _tag: "Timeout"; readonly phase: Phase }

// ─── Machine Handler ──────────────────────────────────────────────────────────

export type MachineHandler<D extends Record<string, any> = Record<string, any>> = (
  state: MachineState<D>,
  event: MachineEvent,
) => Effect.Effect<
  MachineState<D>,
  never,
  MachineDependenciesService
>

// ─── Machine Definition ───────────────────────────────────────────────────────

export interface MachineDef<D extends Record<string, any> = Record<string, any>> {
  readonly id: MachineId
  readonly description: string
  readonly subMachines: ReadonlyArray<MachineId>
  readonly handle: MachineHandler<D>
  readonly timeout: Duration.Duration
}

// ─── Tool Result Types ────────────────────────────────────────────────────────

export interface GrepResult {
  readonly files: ReadonlyArray<{ file: string; line: number; text: string }>
  readonly totalMatches: number
}

export interface FindResult {
  readonly files: ReadonlyArray<{ path: string; type: "file" | "directory"; size?: number }>
}

export interface BunResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

// ─── Machine Dependencies (with tool capabilities) ────────────────────────────

export interface MachineDependencies {
  // Orchestration
  readonly spawn: (
    machineId: MachineId,
    laneId: string,
    mission: string,
  ) => Effect.Effect<string>
  readonly sendDirective: (
    targetSession: string,
    kind: string,
    subject: string,
    body: string,
  ) => Effect.Effect<void>
  readonly checkHandoffs: () => Effect.Effect<ReadonlyArray<unknown>>
  readonly recordActivity: (
    action: string,
    target: string,
    details: Record<string, unknown>,
  ) => Effect.Effect<void>
  readonly log: (level: string, message: string) => Effect.Effect<void>

  // Tool — grep/search
  readonly grep: (
    pattern: string,
    options?: { path?: string; glob?: string; maxResults?: number; contextLines?: number },
  ) => Effect.Effect<GrepResult>

  // Tool — find files
  readonly findFiles: (
    pattern: string,
    options?: { path?: string; maxDepth?: number; type?: "file" | "directory" },
  ) => Effect.Effect<FindResult>

  // Tool — read source
  readonly readSource: (
    file: string,
    options?: { focus?: string; summaryOnly?: boolean },
  ) => Effect.Effect<string>

  // Tool — git
  readonly git: (
    operation: string,
    args?: string,
    options?: { path?: string },
  ) => Effect.Effect<string>

  // Tool — bun/typecheck/test
  readonly bun: (
    command: string,
    options?: { cwd?: string; args?: string; timeoutSeconds?: number },
  ) => Effect.Effect<BunResult>

  // Tool — edit/write
  readonly smartWrite: (
    file: string,
    content: string,
    reason: string,
  ) => Effect.Effect<void>

  // Tool — smart batch (multiple edits atomically)
  readonly smartBatch: (
    edits: ReadonlyArray<{ file: string; oldText: string; newText: string; reason: string }>,
  ) => Effect.Effect<void>
}

export class MachineDependenciesService extends Context.Service<
  MachineDependenciesService,
  MachineDependencies
>()("@opencode/agent/MachineDependencies") {}

// ─── Machine Runner ───────────────────────────────────────────────────────────

export class MachineRunner {
  constructor(
    readonly def: MachineDef,
    readonly state: MachineState,
    readonly fiber: any,
  ) {}
}

// ─── Machine Registry ─────────────────────────────────────────────────────────

export interface MachineRegistry {
  readonly machines: Map<MachineId, MachineDef>
  readonly runners: Map<string, MachineRunner>
}

export class MachineRegistryService extends Context.Service<
  MachineRegistryService,
  MachineRegistry
>()("@opencode/agent/MachineRegistry") {}

// ─── Event Schema (for artifact recording) ────────────────────────────────────

export const MachineEventRecord = Schema.Struct({
  schema_version: Schema.Literal("v1"),
  machine_id: Schema.String,
  phase: Schema.String,
  lane_id: Schema.String,
  session_id: Schema.String,
  event_tag: Schema.String,
  detail: Schema.optional(Schema.String),
  recorded_at: Schema.String,
})
