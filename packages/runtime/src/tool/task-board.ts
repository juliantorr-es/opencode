import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./task-board.txt"

const Parameters = Schema.Struct({
  wave: Schema.optional(Schema.String).annotate({ description: "Filter by wave name" }),
  status: Schema.optional(Schema.String).annotate({
    description: "Filter by status: running | completed | failed | blocked",
  }),
  session_id: Schema.optional(Schema.String).annotate({ description: "Filter by session ID" }),
})

export const TaskBoardTool = Tool.define(
  "task_board",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const coordPath = `${instance.directory}/docs/json/opencode/coordination/messages.v1.jsonl`
          const sessionsBase = `${instance.directory}/docs/json/opencode/sessions`

          // Read coordination messages
          const messages: Array<Record<string, unknown>> = []
          const coordExists = yield* fs.existsSafe(coordPath)
          if (coordExists) {
            try {
              const content = yield* fs.readFileString(coordPath)
              for (const line of content.split("\n").filter(Boolean)) {
                try {
                  const m = JSON.parse(line) as Record<string, unknown>
                  if (m.kind === "task_status" || m.kind === "handoff" || m.kind === "heartbeat") {
                    messages.push(m)
                  }
                } catch { /* skip */ }
              }
            } catch { /* skip */ }
          }

          // Build tasks from coordination
          const tasks: Record<string, Record<string, unknown>> = {}
          for (const msg of messages) {
            if (params.wave && msg.wave !== params.wave) continue
            if (params.session_id && msg.session_id !== params.session_id) continue

            const id = (msg.task_id as string) || (msg.message_id as string) || `msg_${Math.random().toString(36).slice(2, 8)}`
            if (!tasks[id]) {
              tasks[id] = {
                task_id: id,
                source: "coordination",
                agent: msg.subagent_type || msg.sender || "?",
                description: msg.subject || "",
                wave: msg.wave,
                events: [] as Array<Record<string, unknown>>,
              }
            }
            const events = tasks[id].events as Array<Record<string, unknown>>
            events.push({
              status: msg.task_status || msg.status || msg.kind || "unknown",
              at: msg.sent_at,
              detail: String(msg.body ?? "").slice(0, 120),
            })
          }

          // Read heartbeats for fleet status
          const heartbeats: Record<string, Record<string, unknown>> = {}
          const sessionsExists = yield* fs.existsSafe(sessionsBase)
          if (sessionsExists) {
            try {
              const sessionDirs = yield* fs.readDirectory(sessionsBase)
              for (const sessionDir of sessionDirs) {
                if (params.session_id && sessionDir !== params.session_id) continue
                const hbPath = path.join(sessionsBase, sessionDir, "analytics", "heartbeat.v1.jsonl")
                const hbExists = yield* fs.existsSafe(hbPath)
                if (!hbExists) continue

                try {
                  const hbContent = yield* fs.readFileString(hbPath)
                  for (const line of hbContent.split("\n").filter(Boolean)) {
                    try {
                      const hb = JSON.parse(line) as Record<string, unknown>
                      const key = `${String(hb.session_id ?? "").slice(0, 8) || "?"}|${hb.agent || "?"}`
                      if (!heartbeats[key]) {
                        heartbeats[key] = { session_id: hb.session_id, agent: hb.agent, phases: [] as Array<Record<string, unknown>> }
                      }
                      const phases = heartbeats[key].phases as Array<Record<string, unknown>>
                      phases.push({
                        tool: hb.tool,
                        phase: hb.phase,
                        detail: String(hb.detail ?? "").slice(0, 100),
                        at: hb.at || "",
                      })
                    } catch { /* skip */ }
                  }
                } catch { /* skip */ }
              }
            } catch { /* skip */ }
          }

          // Build fleet from heartbeats
          const fleet: Array<Record<string, unknown>> = []
          const alerts: Array<Record<string, unknown>> = []
          const now = Date.now()
          for (const [, hb] of Object.entries(heartbeats)) {
            const phases = (hb.phases ?? []) as Array<Record<string, unknown>>
            if (!phases.length) continue
            const last = phases[phases.length - 1]
            const firstAt = phases[0]?.at as string | undefined
            const lastAt = last?.at as string | undefined
            const elapsed = firstAt ? Math.floor((now - new Date(firstAt).getTime()) / 1000) : 0
            const phase = last?.phase as string | undefined
            const isRunning = !["completed", "failed"].includes(phase ?? "")
            const lastHbAgo = lastAt ? Math.floor((now - new Date(lastAt).getTime()) / 1000) : 999
            const stale = isRunning && lastHbAgo > 60

            if (stale) {
              alerts.push({
                severity: "warning",
                session: String(hb.session_id ?? "").slice(0, 16),
                agent: hb.agent,
                message: `No heartbeat for ${lastHbAgo}s`,
              })
            }
            if (isRunning && elapsed > 120) {
              alerts.push({
                severity: "info",
                session: String(hb.session_id ?? "").slice(0, 16),
                agent: hb.agent,
                message: `Running for ${elapsed}s`,
              })
            }

            fleet.push({
              session: String(hb.session_id ?? "").slice(0, 16),
              agent: hb.agent,
              status: isRunning ? "running" : phase,
              current: `${last?.tool || ""}:${phase || ""}`,
              detail: last?.detail || "",
              elapsed_s: elapsed,
              stale,
              tool_count: new Set(phases.map((p) => p.tool)).size,
            })
          }
          fleet.sort((a, b) => (a.status === "running" ? -1 : 1) || ((b.elapsed_s as number) - (a.elapsed_s as number)))

          // Build dashboard
          const dashboard: Array<Record<string, unknown>> = []
          for (const [, task] of Object.entries(tasks)) {
            const events = (task.events ?? []) as Array<Record<string, unknown>>
            const latest = events.length ? String(events[events.length - 1].status ?? "unknown") : "unknown"
            if (params.status && latest !== params.status) continue

            let elapsed = 0
            let stale = false
            if (events.length) {
              try {
                const first = new Date(events[0].at as string).getTime()
                const last = new Date(events[events.length - 1].at as string).getTime()
                elapsed = Math.floor((now - first) / 1000)
                if (latest === "running" && (now - last) > 30000) stale = true
              } catch { /* skip */ }
            }

            dashboard.push({
              task_id: String(task.task_id ?? "").slice(0, 16),
              source: task.source,
              agent: task.agent,
              description: task.description,
              wave: task.wave,
              status: latest,
              stale,
              elapsed_seconds: elapsed,
              event_count: events.length,
              timeline: events.slice(-10).map((e) => ({
                status: e.status,
                at: String(e.at ?? "").slice(0, 19),
                detail: String(e.detail ?? "").slice(0, 80),
              })),
            })
          }

          const statusOrder: Record<string, number> = { running: 0, blocked: 1, completed: 2, failed: 3 }
          dashboard.sort(
            (a, b) => (statusOrder[a.status as string] ?? 4) - (statusOrder[b.status as string] ?? 4),
          )

          const counts: Record<string, number> = {}
          for (const t of dashboard) {
            const st = t.status as string
            counts[st] = (counts[st] || 0) + 1
          }
          const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(" | ") || "no tasks"

          return {
            title: "task_board",
            metadata: { total: dashboard.length, fleet_total: fleet.length },
            output: JSON.stringify(
              {
                dashboard,
                total: dashboard.length,
                fleet,
                fleet_total: fleet.length,
                alerts,
                summary,
                hint: "Use wave=<name>, status=<running|completed|failed|blocked>, or session_id=<id> to filter.",
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as TaskBoard from "./task-board"
