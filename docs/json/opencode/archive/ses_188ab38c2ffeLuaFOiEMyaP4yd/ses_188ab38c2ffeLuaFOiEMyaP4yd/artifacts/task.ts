import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Cause, Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Coordination } from "./coordination"
import { CoordEvents } from "../coordination/coord-events"
import { Bus } from "../bus"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "",
  "",
  [
    "Background mode: background=true launches the subagent asynchronously and returns immediately.",
    "Foreground is the default; use it when you need the result before continuing.",
    "Use background only for independent work that can run while you continue elsewhere.",
    "You will be notified automatically when it finishes.",
  ].join(" "),
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  wave: Schema.optional(Schema.Number).annotate({
    description: "The orchestration wave number this task belongs to (for coordination tracking)",
  }),
  wave_type: Schema.optional(Schema.String).annotate({
    description: "The orchestration wave type this task belongs to (e.g. 'execution', 'critique', 'validation')",
  }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description: "Run the agent in the background. You will be notified when it completes.",
  }),
})

function output(sessionID: SessionID, text: string) {
  return [`<task id="${sessionID}" state="completed">`, "<task_result>", text, "</task_result>", "</task>"].join("\n")
}

function backgroundOutput(sessionID: SessionID) {
  return [
    `<task id="${sessionID}" state="running">`,
    "<summary>Background task started</summary>",
    "<task_result>",
    "Background task started. You will be notified automatically when it finishes; do not poll for progress.",
    "Do not duplicate its work. Continue only with non-overlapping work, or stop if there is nothing else useful to do.",
    "</task_result>",
    "</task>",
  ].join("\n")
}

function backgroundMessage(input: {
  sessionID: SessionID
  description: string
  state: "completed" | "error"
  text: string
}) {
  const tag = input.state === "completed" ? "task_result" : "task_error"
  const title =
    input.state === "completed"
      ? `Background task completed: ${input.description}`
      : `Background task failed: ${input.description}`
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    `<summary>${title}</summary>`,
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function writeTaskStatus(sessionID: SessionID, taskID: SessionID, subagentType: string, status: string, description: string, wave: number, waveType: string) {
  try {
    const dir = join(process.cwd(), "docs", "json", "opencode", "coordination")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({
      schema_version: "v1",
      message_id: `${Date.now()}_task_status`,
      session_id: sessionID,
      sender: "task_tool",
      recipient: "*",
      kind: "task_status",
      task_status: status,
      task_id: taskID,
      subagent_type: subagentType,
      wave: wave,
      wave_type: waveType,
      subject: description,
      body: `Task ${taskID} ${status}`,
      sent_at: new Date().toISOString(),
    })
    appendFileSync(join(dir, "messages.v1.jsonl"), line + "\n", "utf-8")
  } catch { /* best-effort */ }
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const bus = yield* Bus.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parent = yield* sessions.get(ctx.sessionID)
      const parentAgent = parent.agent
        ? yield* agent.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          permission: [
            ...deriveSubagentSessionPermission({
              parentSessionPermission: parent.permission ?? [],
              parentAgent,
              subagent: next,
            }),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        }))

      // Record coordination claim for this task
      yield* Coordination.claimTask(
        nextSession.id,
        ctx.sessionID,
        params.subagent_type,
        params.description,
        params.wave ?? 0,
        (params.wave_type ?? "") as Coordination.WaveType | "",
      )
      yield* bus.publish(CoordEvents.TaskStatusChanged, {
        session_id: ctx.sessionID,
        task_id: nextSession.id,
        task_type: params.subagent_type ?? "unknown",
        status: "running",
        description: params.description,
        agent_name: params.subagent_type,
        changed_at: Date.now(),
      })
      writeTaskStatus(ctx.sessionID, nextSession.id, params.subagent_type ?? "unknown", "running", params.description, params.wave ?? 0, (params.wave_type ?? "") as string)

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(Effect.orDie)
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const UX_FEEDBACK_SUFFIX = "\n\n=== TOOL UX FEEDBACK (include in your return if applicable) ===\nIf any tool was confusing, slow, or error-prone, add a tool_ux array to your structured handoff:\n{\"tool_ux\": [{\"tool\": \"<name>\", \"what_i_tried\": \"...\", \"what_went_wrong\": \"...\", \"what_would_help\": \"...\"}]}"
        const enhancedPrompt = params.prompt + UX_FEEDBACK_SUFFIX
        const parts = yield* ops.resolvePromptParts(enhancedPrompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          agent: next.name,
          tools: {
            ...(next.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
            ...(next.permission.some((rule) => rule.permission === id) ? {} : { task: false }),
            ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
          },
          parts,
        })
        const text = result.parts.findLast((item) => item.type === "text")?.text ?? ""
        yield* Coordination.releaseTask(nextSession.id, text)
        yield* bus.publish(CoordEvents.TaskStatusChanged, {
          session_id: ctx.sessionID,
          task_id: nextSession.id,
          task_type: params.subagent_type ?? "unknown",
          status: "completed",
          description: params.description,
          agent_name: params.subagent_type,
          changed_at: Date.now(),
        })
        writeTaskStatus(ctx.sessionID, nextSession.id, params.subagent_type ?? "unknown", "completed", params.description, params.wave ?? 0, (params.wave_type ?? "") as string)
        return text
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: backgroundMessage({
                  sessionID: nextSession.id,
                  description: params.description,
                  state,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const existing = yield* background.get(nextSession.id)
      if (existing?.status === "running") {
        return yield* Effect.fail(new Error(`Task ${nextSession.id} is already running.`))
      }

      if (runInBackground) {
        const info = yield* background.start({
          id: nextSession.id,
          type: id,
          title: params.description,
          metadata,
          run: runTask().pipe(
            Effect.tap((text) => {
              writeTaskStatus(ctx.sessionID, nextSession.id, params.subagent_type ?? "unknown", "completed", params.description, params.wave ?? 0, (params.wave_type ?? "") as string)
              return inject("completed", text).pipe(Effect.ignore)
            }),
            Effect.catchCause((cause) => {
                const errorMsg = errorText(Cause.squash(cause))
                const handle = Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.gen(function* () {
                      yield* Coordination.failTask(nextSession.id, errorMsg)
                      yield* bus.publish(CoordEvents.TaskStatusChanged, {
                        session_id: ctx.sessionID,
                        task_id: nextSession.id,
                        task_type: params.subagent_type ?? "unknown",
                        status: "failed",
                        description: params.description,
                        agent_name: params.subagent_type,
                        changed_at: Date.now(),
                      })
                      writeTaskStatus(ctx.sessionID, nextSession.id, params.subagent_type ?? "unknown", "failed", params.description, params.wave ?? 0, (params.wave_type ?? "") as string)
                      yield* inject("error", errorMsg).pipe(Effect.ignore)
                    })
                return handle.pipe(Effect.andThen(Effect.failCause(cause)))
              }),
          ) as any,

        })

        return {
          title: params.description,
          metadata: {
            ...metadata,
            jobId: info.id,
          },
          output: backgroundOutput(nextSession.id),
        }
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () => {
          const useEffect = Effect.gen(function* () {
            const text = yield* runTask()
            return {
              title: params.description,
              metadata,
              output: output(nextSession.id, text),
            }
          })
          return Effect.catch(
            useEffect,
            (error: unknown) =>
              Effect.gen(function* () {
                const errorMsg = error instanceof Error ? error.message : String(error)
                yield* Coordination.failTask(nextSession.id, errorMsg)
                yield* bus.publish(CoordEvents.TaskStatusChanged, {
                  session_id: ctx.sessionID,
                  task_id: nextSession.id,
                  task_type: params.subagent_type ?? "unknown",
                  status: "failed",
                  description: params.description,
                  agent_name: params.subagent_type,
                  changed_at: Date.now(),
                })
                writeTaskStatus(ctx.sessionID, nextSession.id, params.subagent_type ?? "unknown", "failed", params.description, params.wave ?? 0, (params.wave_type ?? "") as string)
                return yield* Effect.fail(error)
              }),
          )
        },
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) yield* cancel
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents ? DESCRIPTION + BACKGROUND_DESCRIPTION : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie) as any,
    }
  }),
)
