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
import { Config } from "@/config/config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import { Schema } from "effect"
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
import * as ToolCache from "./cache"
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
import { DelegateTool } from "./delegate"
import { SessionDiffTool } from "./session-diff"
import { GithubTriageTool } from "./github-triage"
import { GithubPrSearchTool } from "./github-pr-search"
import { Glob } from "@opencode-ai/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context } from "effect"
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
import { Storage } from "@/storage/storage"
import { RecordStressWaveTool } from "./record-stress-wave"
import { RecordExecutionWaveTool } from "./record-execution-wave"
import { DuckDBQueryTool } from "./duckdb-query"
import { DuckDB } from "@/storage/db.duckdb"
import { DuckDBConfig } from "@/storage/duckdb-config"
import { DatabaseAdapter } from "@/storage/adapter"
import { DatabaseConfig } from "@/effect/database-config"
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
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: { providerID: ProviderID; modelID: ModelID; agent: Agent.Info }) => Effect.Effect<Tool.Def[]>
  readonly cacheStats: () => Effect.Effect<ToolCache.CacheStats>
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
    const replaceSymbol = yield* ReplaceSymbolTool
    const rigJsonlQuery = yield* RigJsonlQueryTool
    const rigSchemaValidate = yield* RigSchemaValidateTool
    const generateReport = yield* GenerateReportTool
    const prepareDelegation = yield* PrepareDelegationTool
    const prepublicationAdmitted = yield* PrepublicationAdmittedTool
    const prepublicationBlocked = yield* PrepublicationBlockedTool
    const prepublicationInconclusive = yield* PrepublicationInconclusiveTool
    const outOfScopeFinding = yield* OutOfScopeFindingTool
    const delegate = yield* DelegateTool
    const sessionDiff = yield* SessionDiffTool
    const githubTriage = yield* GithubTriageTool
    const githubPrSearch = yield* GithubPrSearchTool
    const agent = yield* Agent.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

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
                Effect.catchAll((error) =>
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
            if (!isPluginTool(def)) continue
            custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
          }
        }

        const plugins = yield* plugin.list()
        for (const p of plugins) {
          for (const [id, def] of Object.entries(p.tool ?? {})) {
            custom.push(fromPlugin(id, def))
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
        })

        return {
          custom,
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
            tool.qa_observed_clean,
            tool.read_source,
            tool.read_lib,
            tool.smart_edit,
            tool.smart_write,
            tool.smart_batch,
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
      return [...s.builtin, ...s.custom] as Tool.Def[]
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
              tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
              tool.id === SkillTool.id ? yield* describeSkill(input.agent) : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            jsonSchema,
            execute: tool.execute,
            formatValidationError: tool.formatValidationError,
            cacheable: tool.cacheable,
            timeout: tool.timeout,
            maxConcurrency: tool.maxConcurrency,
            retry: tool.retry,
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

    return Service.of({ ids, all, named, tools, cacheStats })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer
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
    .pipe(Layer.provide(RuntimeFlags.defaultLayer)),
)

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isPluginTool(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && "args" in value && "description" in value && "execute" in value
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
