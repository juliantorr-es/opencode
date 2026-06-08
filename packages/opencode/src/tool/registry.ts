import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import * as Tool from "./tool"
import * as ToolGraph from "./tool-graph"
import { Config } from "@/config/config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import { Schema, Effect, Layer, Context } from "effect"
import z from "zod"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { RepoCloneTool } from "./repo_clone"
import { RepoOverviewTool } from "./repo_overview"
import { RepositoryCache } from "@/reference/repository-cache"
import * as Log from "@opencode-ai/core/util/log"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { ValidateTool } from "./validate"
import { TestTool } from "./test"
import { InspectFailureTool } from "./inspect_failure"
import { ReportTool } from "./report"
import { SearchReplaceTool } from "./search_replace"
import { PrepareCheckpointTool } from "./prepare_checkpoint"
import { CheckpointTool } from "./checkpoint"
import { PublishCheckpointTool } from "./publish_checkpoint"
import { GeneratePublishedCheckpointReportTool } from "./generate_published_checkpoint_report"
import { CoordinationTool } from "./coordination"
import { RigGitTool } from "./rig-git"
import { SendMessageTool } from "./send-message"
import { ReadMessagesTool } from "./read-messages"
import { ToolFailureTool } from "./tool-failure"
import { ToolFeedbackTool } from "./tool-feedback"
import { ProposePlanTool } from "./propose-plan"
import { RevisePlanTool } from "./revise-plan"
import { CommentPlanTool } from "./comment-plan"
import { ReviewCriticismTool } from "./review-criticism"
import { QaObservedCleanTool } from "./qa-observed-clean"
import { PublishFindingTool } from "./publish-finding"
import { DiscoverFindingsTool } from "./discover-findings"
import { CurateContextTool } from "./curate-context"
import { ReadArtifactTool } from "./read-artifact"
import { ReadSourceTool } from "./read-source"
import { ReadLibTool } from "./read-lib"
import { SmartEditTool } from "./smart-edit"
import { SmartWriteTool } from "./smart-write"
import { SmartBatchTool } from "./smart-batch"
import { ReplaceSymbolTool } from "./replace-symbol"
import { RigJsonlQueryTool } from "./rig-jsonl-query"
import { RigSchemaValidateTool } from "./rig-schema-validate"
import { GenerateReportTool } from "./generate-report"
import { PrepareDelegationTool } from "./prepare-delegation"
import { PrepublicationAdmittedTool } from "./prepublication-admitted"
import { PrepublicationBlockedTool } from "./prepublication-blocked"
import { PrepublicationInconclusiveTool } from "./prepublication-inconclusive"
import { OutOfScopeFindingTool } from "./out-of-scope-finding"
import { ReviewManifestTool } from "./review-manifest"
import { Glob } from "@opencode-ai/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "../file/ripgrep"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Bus } from "../bus"
import { Agent } from "../agent/agent"
import { Git } from "@/git"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { Reference } from "@/reference/reference"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RecordStressWaveTool } from "./record-stress-wave"
import { RecordExecutionWaveTool } from "./record-execution-wave"
import { DuckDBQueryTool } from "./duckdb-query"
import { DuckDB } from "@/storage/db.duckdb"
import { DuckDBConfig } from "@/storage/duckdb-config"
import { DatabaseAdapter } from "@/storage/adapter"
import { DatabaseConfig } from "@/effect/database-config"
import { layer as EventStoreLayer } from "@/event/event-store"
import { layer as EventAgentQueriesLayer } from "@/event/agent-queries"
import { Storage } from "@/storage/storage"
import { AnalyticsTool } from "./analytics"
import { JSONQueryTool } from "./json-query"
import { LessonRegisterTool } from "./lesson-register"
import { LogActivityTool } from "./log-activity"
import { PreflightCheckTool } from "./preflight-check"
import { ProduceFragmentTool } from "./produce-fragment"
import { RoadmapDeprecateTool } from "./roadmap-deprecate"
import { RoadmapInitTool } from "./roadmap-init"
import { RoadmapNextTool } from "./roadmap-next"
import { RoadmapPrioritizeTool } from "./roadmap-prioritize"
import { RoadmapProgressTool } from "./roadmap-progress"
import { SmartBashTool } from "./smart-bash"
import { SmartBunTool } from "./smart-bun"
import { SmartFindTool } from "./smart-find"
import { SmartGitTool } from "./smart-git"
import { SmartGrepTool } from "./smart-grep"
import { SmartSdTool } from "./smart-sd"
import { TaskBoardTool } from "./task-board"
import { VerifyHandoffTool } from "./verify-handoff"
import { DelegateTool } from "./delegate"
import { SessionDiffTool } from "./session-diff"
import { GithubTriageTool } from "./github-triage"
import { GithubPrSearchTool } from "./github-pr-search"
import {
  LastFailedToolsTool,
  LastEditedFilesTool,
  PermissionDenialsTool,
  PhaseTransitionsTool,
  LastCheckpointTool,
  SuccessfulTestTool,
  EventsForFileTool,
  EventsForErrorCodeTool,
  EventsSinceCheckpointTool,
} from "../event/agent-queries"
import {
  GetOperatingPictureTool,
  GetProjectMapTool,
  GetWorkingSetTool,
  GetFileContextTool,
  GetRelatedContextTool,
  QueryEventHistoryTool,
  GetValidationContextTool,
  GetClaimContextTool,
  UpdateScratchpadTool,
  MarkContextStaleTool,
  RequestContextRefreshTool,
} from "../context/tools"
import { defaultLayer as FileMemoryLayer } from "../context/file-memory"
import * as ToolCache from "./cache"

const log = Log.create({ service: "tool.registry" })

export function webSearchEnabled(providerID: ProviderID, flags = { exa: false, parallel: false }) {
  return providerID === ProviderID.opencode || flags.exa || flags.parallel
}

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
  modeDescriptions: Map<string, Record<string, string>>
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: { providerID: ProviderID; modelID: ModelID; agent: Agent.Info }) => Effect.Effect<Tool.Def[]>
  readonly cacheStats: () => Effect.Effect<ToolCache.CacheStats>
  /** Graph-based next-tool suggestion. Delegates to ToolGraph.suggestPipeline. */
  readonly suggestNext: (toolId: string) => Effect.Effect<string[], never, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const skill = yield* Skill.Service
    const truncate = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const cache = yield* ToolCache.Service

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const repoClone = yield* RepoCloneTool
    const repoOverview = yield* RepoOverviewTool
    const shell = yield* ShellTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const validate = yield* ValidateTool
    const test = yield* TestTool
    const inspectFailure = yield* InspectFailureTool
    const report = yield* ReportTool
    const searchReplace = yield* SearchReplaceTool
    const prepareCheckpoint = yield* PrepareCheckpointTool
    const checkpoint = yield* CheckpointTool
    const publishCheckpoint = yield* PublishCheckpointTool
    const publishedCheckpointReport = yield* GeneratePublishedCheckpointReportTool
    const skilltool = yield* SkillTool
    const coordinationtool = yield* CoordinationTool
    const riggit = yield* RigGitTool
    const sendMessage = yield* SendMessageTool
    const readMessages = yield* ReadMessagesTool
    const recordStressWave = yield* RecordStressWaveTool
    const recordExecutionWave = yield* RecordExecutionWaveTool
    const duckdbQuery = yield* DuckDBQueryTool
    const toolFailure = yield* ToolFailureTool
    const toolFeedback = yield* ToolFeedbackTool
    const proposePlan = yield* ProposePlanTool
    const revisePlan = yield* RevisePlanTool
    const commentPlan = yield* CommentPlanTool
    const reviewCriticism = yield* ReviewCriticismTool
    const qaObservedClean = yield* QaObservedCleanTool
    const publishFinding = yield* PublishFindingTool
    const discoverFindings = yield* DiscoverFindingsTool
    const curateContext = yield* CurateContextTool
    const readArtifact = yield* ReadArtifactTool
    const readSource = yield* ReadSourceTool
    const readLib = yield* ReadLibTool
    const smartEdit = yield* SmartEditTool
    const smartWrite = yield* SmartWriteTool
    const smartBatch = yield* SmartBatchTool
    const analytics = yield* AnalyticsTool
    const jsonQuery = yield* JSONQueryTool
    const lessonRegister = yield* LessonRegisterTool
    const logActivity = yield* LogActivityTool
    const preflightCheck = yield* PreflightCheckTool
    const produceFragment = yield* ProduceFragmentTool
    const roadmapDeprecate = yield* RoadmapDeprecateTool
    const roadmapInit = yield* RoadmapInitTool
    const roadmapNext = yield* RoadmapNextTool
    const roadmapPrioritize = yield* RoadmapPrioritizeTool
    const roadmapProgress = yield* RoadmapProgressTool
    const smartBash = yield* SmartBashTool
    const smartBun = yield* SmartBunTool
    const smartFind = yield* SmartFindTool
    const smartGit = yield* SmartGitTool
    const smartGrep = yield* SmartGrepTool
    const smartSd = yield* SmartSdTool
    const taskBoard = yield* TaskBoardTool
    const verifyHandoff = yield* VerifyHandoffTool
    const replaceSymbol = yield* ReplaceSymbolTool
    const rigJsonlQuery = yield* RigJsonlQueryTool
    const rigSchemaValidate = yield* RigSchemaValidateTool
    const generateReport = yield* GenerateReportTool
    const prepareDelegation = yield* PrepareDelegationTool
    const prepublicationAdmitted = yield* PrepublicationAdmittedTool
    const prepublicationBlocked = yield* PrepublicationBlockedTool
    const prepublicationInconclusive = yield* PrepublicationInconclusiveTool
    const outOfScopeFinding = yield* OutOfScopeFindingTool
    const reviewManifest = yield* ReviewManifestTool
    const delegate = yield* DelegateTool
    const sessionDiff = yield* SessionDiffTool
    const githubTriage = yield* GithubTriageTool
    const githubPrSearch = yield* GithubPrSearchTool
    const lastFailedTools = yield* LastFailedToolsTool
    const lastEditedFiles = yield* LastEditedFilesTool
    const permissionDenials = yield* PermissionDenialsTool
    const phaseTransitions = yield* PhaseTransitionsTool
    const lastCheckpoint = yield* LastCheckpointTool
    const successfulTest = yield* SuccessfulTestTool
    const eventsForFile = yield* EventsForFileTool
    const eventsForErrorCode = yield* EventsForErrorCodeTool
    const eventsSinceCheckpoint = yield* EventsSinceCheckpointTool
    const getOperatingPicture = yield* GetOperatingPictureTool
    const getProjectMap = yield* GetProjectMapTool
    const getWorkingSet = yield* GetWorkingSetTool
    const getFileContext = yield* GetFileContextTool
    const getRelatedContext = yield* GetRelatedContextTool
    const queryEventHistory = yield* QueryEventHistoryTool
    const getValidationContext = yield* GetValidationContextTool
    const getClaimContext = yield* GetClaimContextTool
    const updateScratchpad = yield* UpdateScratchpadTool
    const markContextStale = yield* MarkContextStaleTool
    const requestContextRefresh = yield* RequestContextRefreshTool
    const agent = yield* Agent.Service
    // Capture the full construction-time context so tools can resolve
    // their dependencies at runtime regardless of fiber boundaries.
    const toolRuntime = yield* Effect.context<never>()

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []
        const modeDescriptions = new Map<string, Record<string, string>>()

        const BUILTIN_TOOL_IDS = new Set<string>([
          "invalid", "shell", "read", "glob", "grep", "edit", "write", "task", "fetch",
          "todo", "search", "repo_clone", "repo_overview", "skill", "patch", "validate",
          "test", "inspect_failure", "report", "search_replace", "prepare_checkpoint",
          "checkpoint", "publish_checkpoint", "generate_published_checkpoint_report",
          "question", "lsp", "plan", "coordination", "rig_git", "send_message",
          "read_messages", "record_stress_wave", "record_execution_wave", "duckdb_query",
          "tool_failure", "tool_feedback", "publish_finding", "discover_findings",
          "curate_context", "read_artifact", "propose_plan", "revise_plan", "comment_plan",
          "review_criticism", "qa_observed_clean", "read_source", "read_lib",
          "smart_edit", "smart_write", "smart_batch", "analytics", "json_query",
          "lesson_register", "log_activity", "preflight_check", "produce_fragment", "roadmap_deprecate",
          "roadmap_init", "roadmap_next", "roadmap_prioritize", "roadmap_progress",
          "smart_bash", "smart_bun", "smart_find", "smart_git", "smart_grep",
          "smart_sd", "task_board", "verify_handoff", "replace_symbol",
          "rig_jsonl_query", "rig_schema_validate", "generate_report",
          "prepare_delegation", "prepublication_admitted", "prepublication_blocked",
          "prepublication_inconclusive", "out_of_scope_finding", "delegate",
          "session_diff", "github_triage", "github_pr_search",
          "query_last_failed_tools", "query_last_edited_files", "query_permission_denials",
          "query_phase_transitions", "query_last_checkpoint", "query_last_successful_test",
          "query_events_for_file", "query_events_for_error", "query_events_since_checkpoint",
          "get_operating_picture", "get_project_map", "get_working_set", "get_file_context",
          "get_related_context", "query_event_history", "get_validation_context",
          "get_claim_context", "update_scratchpad", "mark_context_stale",
          "request_context_refresh", "review_manifest",
        ])

        function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
          // Plugin tools still expose Zod args publicly; keep that compatibility
          // boxed at the registry boundary and give the LLM the original JSON Schema.
          // Normalize missing args to `{}` once — pre-1.14.49 the code was
          // `z.object(def.args)` and Zod silently tolerated undefined (#27451, #27630).
          const args = def.args ?? {}
          const entries = Object.entries(args)
          const allZod = entries.every((entry) => isZodType(entry[1]))
          const zodParams = allZod ? z.object(args) : undefined
          const jsonSchema = zodParams ? zodJsonSchema(zodParams) : legacyJsonSchema(entries)
          const parameters = zodParams
            ? Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success)
            : Schema.Unknown
          return {
            id,
            parameters,
            jsonSchema,
            description: def.description,
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                // Bridge the host's Effect-based `ask` into a Promise-returning
                // function for the plugin to make sure context persists
                const bridge = yield* EffectBridge.make()
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => bridge.promise(toolCtx.ask(req)),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const output = typeof result === "string" ? result : result.output
                const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
                const attachments = typeof result === "string" ? undefined : result.attachments
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(output, {}, info)
                return {
                  title: typeof result === "string" ? "" : (result.title ?? ""),
                  output: out.truncated ? out.content : output,
                  attachments,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }).pipe(
               Effect.provideContext(toolRuntime),
                Effect.catch((error: unknown) =>
                  Effect.succeed({
                    title: id,
                    metadata: { status: "error" },
                    output: `[${id}] Plugin tool error: ${error instanceof Error ? error.message : String(error)}`,
                  }),
                ),
                Effect.withSpan("Tool.execute", {
                  attributes: {
                    "tool.name": id,
                    "session.id": toolCtx.sessionID,
                    "message.id": toolCtx.messageID,
                    ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
                  },
                }),
              ),
          }
        }

        function fromOmpTool(id: string, def: any): Tool.Def {
          const zodParams = def.parameters as z.ZodObject<any>
          const jsonSchema = zodJsonSchema(zodParams)
          const parameters = Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success)
          return {
            id,
            parameters,
            jsonSchema,
            description: def.description,
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                const onUpdate = (update: any) => {
                  // bridge updates
                }
                const ompCtx = {
                  sessionId: toolCtx.sessionID,
                  messageId: toolCtx.messageID,
                  agent: toolCtx.agent,
                  abort: toolCtx.abort,
                }
                const signal = toolCtx.abort
                const result = yield* Effect.promise(() =>
                  def.execute(toolCtx.callID || "unknown", args, onUpdate, ompCtx, signal),
                )
                const outputText = result && Array.isArray(result.content)
                  ? result.content.map((c: any) => c?.text ?? "").join("\n")
                  : result && typeof result === "object" && "content" in result
                  ? String(result.content || "")
                  : typeof result === "string"
                  ? result
                  : String(result ?? "")
                const metadata = (result && typeof result === "object" && result.details) ? result.details : {}
                const title = def.label ?? id
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(outputText, {}, info)
                return {
                  title,
                  output: out.truncated ? out.content : outputText,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }).pipe(
                Effect.provideContext(toolRuntime),
                Effect.catch((error: unknown) =>
                  Effect.succeed({
                    title: id,
                    metadata: { status: "error" },
                    output: `[${id}] OMP tool error: ${error instanceof Error ? error.message : String(error)}`,
                  }),
                ),
                Effect.withSpan("Tool.execute", {
                  attributes: {
                    "tool.name": id,
                    "session.id": toolCtx.sessionID,
                    "message.id": toolCtx.messageID,
                    ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
                  },
                }),
              ),
          }
        }

        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length) yield* config.waitForDependencies()
        for (const match of matches) {
          const namespace = path.basename(match, path.extname(match))
          // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
          // Import it as `file://` so Node on Windows accepts the dynamic import.
          const mod = yield* Effect.promise(() => import(pathToFileURL(match).href))
          for (const [id, def] of Object.entries(mod)) {
            let instantiatedDef = def
            if (isCustomToolFactory(def)) {
              try {
                const pi = {
                  zod: z,
                  cwd: ctx.directory,
                }
                instantiatedDef = def(pi)
              } catch (err) {
                log.warn("failed to instantiate custom tool factory", { id, error: String(err) })
                continue
              }
            }

            if (isOmpTool(instantiatedDef)) {
              const toolId = id === "default" ? namespace : `${namespace}_${id}`
              const isOmp = match.includes("/.omp/") || match.includes("\\.omp\\")
              const safeToolId = isOmp ? toolId : (BUILTIN_TOOL_IDS.has(toolId) ? `plugin_${toolId}` : toolId)
              custom.push(fromOmpTool(safeToolId, instantiatedDef))
            } else if (isPluginTool(instantiatedDef)) {
              const toolId = id === "default" ? namespace : `${namespace}_${id}`
              const isOmp = match.includes("/.omp/") || match.includes("\\.omp\\")
              const safeToolId = isOmp ? toolId : (BUILTIN_TOOL_IDS.has(toolId) ? `plugin_${toolId}` : toolId)
              custom.push(fromPlugin(safeToolId, instantiatedDef))
            }
          }
          if (mod.modeDescriptions !== null && typeof mod.modeDescriptions === "object") {
            modeDescriptions.set(namespace, mod.modeDescriptions as Record<string, string>)
          }
        }

        const plugins = yield* plugin.list()
        for (const p of plugins) {
          const pluginId = (p as any).pluginId
          if (pluginId) {
            const allowed = yield* plugin.checkCapability(pluginId, "tool.register")
            if (!allowed) {
              log.warn("plugin tool registration denied", { pluginId })
              continue
            }
          }
          for (const [id, def] of Object.entries(p.tool ?? {})) {
            const safeId = pluginId ? `plugin-${pluginId.replace(/^@/, "").replace(/[/._]/g, "-").replace(/[^a-zA-Z0-9-]/g, "")}-${id}` : id
            const finalId = BUILTIN_TOOL_IDS.has(safeId) ? `${safeId}_plugin` : safeId
            custom.push(fromPlugin(finalId, def))
          }
        }

        yield* config.get()
        const questionEnabled = ["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          search: Tool.init(websearch),
          repo_clone: Tool.init(repoClone),
          repo_overview: Tool.init(repoOverview),
          skill: Tool.init(skilltool),
          patch: Tool.init(patchtool),
          validate: Tool.init(validate),
          test: Tool.init(test),
          inspect_failure: Tool.init(inspectFailure),
          report: Tool.init(report),
          search_replace: Tool.init(searchReplace),
          prepare_checkpoint: Tool.init(prepareCheckpoint),
          checkpoint: Tool.init(checkpoint),
          publish_checkpoint: Tool.init(publishCheckpoint),
          generate_published_checkpoint_report: Tool.init(publishedCheckpointReport),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
            coordination: Tool.init(coordinationtool),
            rig_git: Tool.init(riggit),
            send_message: Tool.init(sendMessage),
            read_messages: Tool.init(readMessages),
            record_stress_wave: Tool.init(recordStressWave),
            record_execution_wave: Tool.init(recordExecutionWave),
            duckdb_query: Tool.init(duckdbQuery),
            tool_failure: Tool.init(toolFailure),
            tool_feedback: Tool.init(toolFeedback),
            publish_finding: Tool.init(publishFinding),
            discover_findings: Tool.init(discoverFindings),
            curate_context: Tool.init(curateContext),
            read_artifact: Tool.init(readArtifact),
            propose_plan: Tool.init(proposePlan),
            revise_plan: Tool.init(revisePlan),
            comment_plan: Tool.init(commentPlan),
            review_criticism: Tool.init(reviewCriticism),
            qa_observed_clean: Tool.init(qaObservedClean),
            read_source: Tool.init(readSource),
            read_lib: Tool.init(readLib),
            smart_edit: Tool.init(smartEdit),
            smart_write: Tool.init(smartWrite),
            smart_batch: Tool.init(smartBatch),
            analytics: Tool.init(analytics),
            json_query: Tool.init(jsonQuery),
            lesson_register: Tool.init(lessonRegister),
            log_activity: Tool.init(logActivity),
            preflight_check: Tool.init(preflightCheck),
            produce_fragment: Tool.init(produceFragment),
            roadmap_deprecate: Tool.init(roadmapDeprecate),
            roadmap_init: Tool.init(roadmapInit),
            roadmap_next: Tool.init(roadmapNext),
            roadmap_prioritize: Tool.init(roadmapPrioritize),
            roadmap_progress: Tool.init(roadmapProgress),
            smart_bash: Tool.init(smartBash),
            smart_bun: Tool.init(smartBun),
            smart_find: Tool.init(smartFind),
            smart_git: Tool.init(smartGit),
            smart_grep: Tool.init(smartGrep),
            smart_sd: Tool.init(smartSd),
            task_board: Tool.init(taskBoard),
            verify_handoff: Tool.init(verifyHandoff),
            replace_symbol: Tool.init(replaceSymbol),
            rig_jsonl_query: Tool.init(rigJsonlQuery),
            rig_schema_validate: Tool.init(rigSchemaValidate),
            generate_report: Tool.init(generateReport),
            prepare_delegation: Tool.init(prepareDelegation),
            prepublication_admitted: Tool.init(prepublicationAdmitted),
            prepublication_blocked: Tool.init(prepublicationBlocked),
            prepublication_inconclusive: Tool.init(prepublicationInconclusive),
            out_of_scope_finding: Tool.init(outOfScopeFinding),
            delegate: Tool.init(delegate),
            session_diff: Tool.init(sessionDiff),
            github_triage: Tool.init(githubTriage),
            github_pr_search: Tool.init(githubPrSearch),
            query_last_failed_tools: Tool.init(lastFailedTools),
            query_last_edited_files: Tool.init(lastEditedFiles),
            query_permission_denials: Tool.init(permissionDenials),
            query_phase_transitions: Tool.init(phaseTransitions),
            query_last_checkpoint: Tool.init(lastCheckpoint),
            query_last_successful_test: Tool.init(successfulTest),
            query_events_for_file: Tool.init(eventsForFile),
            query_events_for_error: Tool.init(eventsForErrorCode),
            query_events_since_checkpoint: Tool.init(eventsSinceCheckpoint),
            get_operating_picture: Tool.init(getOperatingPicture),
            get_project_map: Tool.init(getProjectMap),
            get_working_set: Tool.init(getWorkingSet),
            get_file_context: Tool.init(getFileContext),
            get_related_context: Tool.init(getRelatedContext),
            query_event_history: Tool.init(queryEventHistory),
            get_validation_context: Tool.init(getValidationContext),
            get_claim_context: Tool.init(getClaimContext),
            update_scratchpad: Tool.init(updateScratchpad),
            mark_context_stale: Tool.init(markContextStale),
            request_context_refresh: Tool.init(requestContextRefresh),
            review_manifest: Tool.init(reviewManifest),
        })

        return {
          custom,
          modeDescriptions,
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.shell,
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            tool.task,
            tool.fetch,
            tool.todo,
            tool.search,
            tool.validate,
            tool.test,
            tool.inspect_failure,
            tool.report,
            tool.tool_failure,
            tool.tool_feedback,
            tool.propose_plan,
            tool.revise_plan,
            tool.comment_plan,
            tool.review_criticism,
            tool.review_manifest,
            tool.qa_observed_clean,
            tool.read_source,
            tool.read_lib,
            tool.smart_edit,
            tool.smart_write,
            tool.smart_batch,
            tool.analytics,
            tool.json_query,
            tool.lesson_register,
            tool.log_activity,
            tool.preflight_check,
            tool.produce_fragment,
            tool.roadmap_deprecate,
            tool.roadmap_init,
            tool.roadmap_next,
            tool.roadmap_prioritize,
            tool.roadmap_progress,
            tool.smart_bash,
            tool.smart_bun,
            tool.smart_find,
            tool.smart_git,
            tool.smart_grep,
            tool.smart_sd,
            tool.task_board,
            tool.verify_handoff,
            tool.replace_symbol,
            tool.rig_jsonl_query,
            tool.rig_schema_validate,
            tool.generate_report,
            tool.prepare_delegation,
            tool.prepublication_admitted,
            tool.prepublication_blocked,
            tool.prepublication_inconclusive,
            tool.out_of_scope_finding,
            tool.delegate,
            tool.session_diff,
            tool.github_triage,
            tool.github_pr_search,
            tool.query_last_failed_tools,
            tool.query_last_edited_files,
            tool.query_permission_denials,
            tool.query_phase_transitions,
            tool.query_last_checkpoint,
            tool.query_last_successful_test,
            tool.query_events_for_file,
            tool.query_events_for_error,
            tool.query_events_since_checkpoint,
            tool.get_operating_picture,
            tool.get_project_map,
            tool.get_working_set,
            tool.get_file_context,
            tool.get_related_context,
            tool.query_event_history,
            tool.get_validation_context,
            tool.get_claim_context,
            tool.update_scratchpad,
            tool.mark_context_stale,
            tool.request_context_refresh,
            tool.search_replace,
            tool.prepare_checkpoint,
            tool.checkpoint,
            tool.publish_checkpoint,
            tool.generate_published_checkpoint_report,
            tool.record_stress_wave,
            tool.record_execution_wave,
            tool.publish_finding,
            tool.discover_findings,
            tool.curate_context,
            tool.read_artifact,
            ...(flags.experimentalScout ? [tool.repo_clone, tool.repo_overview] : []),
            tool.skill,
            tool.patch,
            ...(flags.experimentalLspTool ? [tool.lsp] : []),
            ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
            ...(flags.experimentalCoordination ? [
              tool.coordination,
              tool.rig_git,
              tool.send_message,
              tool.read_messages,
            ] : []),
            ...(flags.experimentalDuckDBQuery ? [tool.duckdb_query] : []),
          ],
          task: tool.task,
          read: tool.read,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      const customIds = new Set(s.custom.map((tool) => tool.id))
      const uniqueBuiltin = s.builtin.filter((tool) => !customIds.has(tool.id))
      return [...uniqueBuiltin, ...s.custom] as Tool.Def[]
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeSkill = Effect.fn("ToolRegistry.describeSkill")(function* (agent: Agent.Info) {
      const list = yield* skill.available(agent)
      if (list.length === 0) return "No skills are currently available."
      return [
        "Load a specialized skill that provides domain-specific instructions and workflows.",
        "",
        "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
        "",
        "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
        "",
        'Tool output includes a `<skill_content name="...">` block with the loaded content.',
        "",
        "The following skills provide specialized sets of instructions for particular tasks",
        "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
        "",
        Skill.fmt(list, { verbose: false }),
      ].join("\n")
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    // describeTool dispatches to the correct description generator for a given tool ID and agent.
    // For `task` and `skill`, it delegates to the existing dynamic list builders.
    // For tools that export `modeDescriptions`, it looks up the agent-name key in the Map
    // that was captured during dynamic import (see the mod.modeDescriptions guard above).
    // Phase 1 will wire `DynamicDescription` (tool.ts:15) — a function `(agent) => Effect<string>`
    // that tools can export instead of a static map for fully dynamic context adaptation.
    const describeTool = Effect.fn("ToolRegistry.describeTool")(function* (toolId: string, agent: Agent.Info) {
      if (toolId === TaskTool.id) return yield* describeTask(agent)
      if (toolId === SkillTool.id) return yield* describeSkill(agent)

      const s = yield* InstanceState.get(state)
      const variants = s.modeDescriptions.get(toolId)
      if (!variants) return ""

      const text = variants[agent.name]
      if (text !== undefined) return text

      yield* Effect.logWarning(
        `ToolRegistry.describeTool: tool "${toolId}" has modeDescriptions but no entry for agent "${agent.name}". Available keys: ${Object.keys(variants).join(", ")}`,
      )
      return ""
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const filtered = (yield* all()).filter((tool) => {
        if (tool.id === WebSearchTool.id) {
          return webSearchEnabled(input.providerID, { exa: flags.enableExa, parallel: flags.enableParallel })
        }

        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      return yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          using _ = log.time(tool.id)
          const output = {
            description: tool.description,
            parameters: tool.parameters,
            jsonSchema: tool.jsonSchema,
          }
          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          const jsonSchema =
            output.parameters === tool.parameters || output.jsonSchema !== tool.jsonSchema
              ? output.jsonSchema
              : undefined
          return {
            id: tool.id,
            description: [
              output.description,
              yield* describeTool(tool.id, input.agent),
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            jsonSchema,
            execute: tool.execute,
            formatValidationError: tool.formatValidationError,
            cacheable: (tool as any).cacheable,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    const cacheStats: Interface["cacheStats"] = Effect.fn("ToolRegistry.cacheStats")(function* () {
      return yield* cache.stats()
    })

    const suggestNext: Interface["suggestNext"] = Effect.fn("ToolRegistry.suggestNext")(function* (toolId: string) {
      return yield* ToolGraph.suggestPipeline(toolId)
    })

    // Build the cross-tool dependency graph after all tools are registered
    yield* ToolGraph.buildGraph

    return Service.of({ ids, all, named, tools, cacheStats, suggestNext })
  }),
)

export const defaultLayer = layer
    .pipe(
      Layer.provide(Config.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(Question.defaultLayer),
      Layer.provide(Todo.defaultLayer),
      Layer.provide(Skill.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(BackgroundJob.defaultLayer),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(Layer.mergeAll(Git.defaultLayer, RepositoryCache.defaultLayer)),
      Layer.provide(Reference.defaultLayer),
      Layer.provide(LSP.defaultLayer),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provide(Bus.layer),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Format.defaultLayer),
      Layer.provide(CrossSpawnSpawner.defaultLayer),
      Layer.provide(Ripgrep.defaultLayer),
      Layer.provide(Truncate.defaultLayer),
    )
    .pipe(Layer.provide(ToolCache.defaultLayer))
    .pipe(Layer.provide(DuckDBConfig.defaultLayer))
    .pipe(Layer.provide(DatabaseConfig.defaultLayer))
    .pipe(Layer.provide(DatabaseAdapter.defaultLayer))
    .pipe(Layer.provide(DuckDB.layer))
    .pipe(Layer.provide(Storage.defaultLayer))
    .pipe(Layer.provide(RuntimeFlags.defaultLayer))
    .pipe(Layer.provide(EventStoreLayer))
    .pipe(Layer.provide(EventAgentQueriesLayer))
    .pipe(Layer.provide(FileMemoryLayer))

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isPluginTool(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && "args" in value && "description" in value && "execute" in value
}

function isOmpTool(value: unknown): value is { parameters: z.ZodType; description: string; execute: Function; label?: string } {
  return typeof value === "object" && value !== null && "parameters" in value && "execute" in value
}

function isCustomToolFactory(value: unknown): value is (pi: any) => any {
  return typeof value === "function"
}

function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  }
}

function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return (
    $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest
  ) as JSONSchema7
}

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)

    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }

    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) =>
        (entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"
          ? false
          : true,
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export * as ToolRegistry from "./registry"
