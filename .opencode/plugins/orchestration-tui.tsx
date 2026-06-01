/** @jsxImportSource @opentui/solid */
import { type JSX } from "@opentui/solid"
import { useBindings } from "@opentui/keymap/solid"
import { type KeyEvent, type Renderable } from "@opentui/core"
import { createBindingLookup, type BindingConfig } from "@opentui/keymap/extras"
import type { TuiPlugin, TuiPluginApi, TuiPluginMeta, TuiPluginModule, TuiSlotPlugin, TuiHostSlotMap } from "@opencode-ai/plugin/tui"
import { Database } from "bun:sqlite"
import { resolve } from "node:path"

// ── DB helpers ──
let _db: Database | null = null
function getDb(worktree: string): Database | null {
  if (_db) return _db
  try {
    const p = resolve(worktree, "docs/json/opencode/state.db")
    const { existsSync } = require("node:fs") as typeof import("node:fs")
    if (!existsSync(p)) return null
    _db = new Database(p, { readonly: true })
    return _db
  } catch { return null }
}

function query(sql: string, ...params: any[]): any[] {
  if (!_db) return []
  try { return _db.query(sql).all(...params) as any[] } catch { return [] }
}

// ── Colors ──
const C = {
  bg: "#0d1117", panel: "#161b22", border: "#30363d",
  text: "#c9d1d9", muted: "#8b949e",
  blue: "#58a6ff", green: "#3fb950", yellow: "#d29922",
  red: "#f85149", purple: "#bc8cff", cyan: "#56d4dd",
}

function skin(api: TuiPluginApi) {
  const m = api.theme.current
  return {
    bg: (m.background as string) || C.bg, panel: (m.backgroundPanel as string) || C.panel,
    border: (m.border as string) || C.border, text: (m.text as string) || C.text,
    muted: (m.textMuted as string) || C.muted, blue: (m.primary as string) || C.blue,
    green: (m.success as string) || C.green, yellow: (m.warning as string) || C.yellow,
    red: (m.error as string) || C.red, purple: (m.secondary as string) || C.purple,
    cyan: (m.info as string) || C.cyan,
  }
}

type S = ReturnType<typeof skin>

// ═══════════════════════════════════════════════════════════
// 1. LIVE FLEET SIDEBAR — agent status + progress
// ═══════════════════════════════════════════════════════════
const FleetSidebar = (props: { api: TuiPluginApi; s: S; sessionId: string }) => {
  const lanes = query(`SELECT lane_id, agent, status, delegated_at FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) ORDER BY delegated_at DESC LIMIT 30`)
  const grouped = new Map<string, any[]>()
  for (const l of lanes) {
    const g = grouped.get(l.lane_id) || []
    g.push(l)
    grouped.set(l.lane_id, g)
  }

  const sc = (status: string) => status === "completed" ? props.s.green : status === "pending" ? props.s.blue : status === "stale" || status === "failed" ? props.s.red : props.s.muted
  const si = (status: string) => status === "completed" ? "✓" : status === "pending" ? "●" : status === "stale" ? "💀" : status === "failed" ? "✗" : " "

  return (
    <box flexDirection="column" gap={1}>
      {/* Session stats */}
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
        <text fg={props.s.blue}>● {lanes.filter((l: any) => l.status === "pending").length}</text>
        <text fg={props.s.green}>✓ {lanes.filter((l: any) => l.status === "completed").length}</text>
        <text fg={props.s.red}>✗ {lanes.filter((l: any) => l.status === "failed" || l.status === "stale").length}</text>
      </box>

      {/* Lane list */}
      {[...grouped.entries()].slice(0, 6).map(([lane, agents]) => (
        <box flexDirection="column" gap={0}>
          <text fg={props.s.muted}><b>{lane.slice(0, 12)}</b></text>
          {agents.map((a: any) => (
            <text fg={sc(a.status)}>  {si(a.status)} {a.agent.slice(0, 16)}</text>
          ))}
        </box>
      ))}
      {lanes.length === 0 && <text fg={props.s.muted}>No agents deployed</text>}
    </box>
  )
}

// ═══════════════════════════════════════════════════════════
// 2. AGENT HANDOFF FEED — recent messages in sidebar
// ═══════════════════════════════════════════════════════════
const HandoffFeed = (props: { s: S }) => {
  const msgs = query(`SELECT sender, kind, subject, sent_at FROM messages WHERE kind = 'handoff' ORDER BY sent_at DESC LIMIT 5`)
  return (
    <box flexDirection="column" gap={1}>
      <text fg={props.s.muted}><b>Recent handoffs</b></text>
      {msgs.map((m: any) => (
        <text fg={props.s.text}>
          <span fg={props.s.blue}>{m.sender.slice(0, 10)}</span>
          <span fg={props.s.muted}> {(m.subject || "").slice(0, 40)}</span>
        </text>
      ))}
      {msgs.length === 0 && <text fg={props.s.muted}>No handoffs yet</text>}
    </box>
  )
}

// ═══════════════════════════════════════════════════════════
// 3. HOTSPOT WARNINGS — error-prone files
// ═══════════════════════════════════════════════════════════
const HotspotWarnings = (props: { s: S }) => {
  const hotspots = query(`SELECT file_path, type_errors, test_failures FROM error_hotspots ORDER BY (type_errors + test_failures) DESC LIMIT 5`)
  if (hotspots.length === 0) return <box />
  return (
    <box flexDirection="column" gap={1}>
      <text fg={props.s.red}><b>🔥 Hotspots</b></text>
      {hotspots.map((h: any) => (
        <text fg={props.s.yellow}>
          {h.file_path.split("/").pop()?.replace(/\.[^.]+$/, "") || h.file_path.slice(0, 20)}
          <span fg={props.s.muted}> {h.type_errors}T {h.test_failures}F</span>
        </text>
      ))}
    </box>
  )
}

// ═══════════════════════════════════════════════════════════
// 4. SESSION PROMPT ENRICHMENT — coordination context
// ═══════════════════════════════════════════════════════════
const SessionPromptLeft = (props: { api: TuiPluginApi; s: S; sessionId: string }) => {
  const pending = query(`SELECT COUNT(*) as cnt FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) AND status = 'pending'`)[0]?.cnt || 0
  const done = query(`SELECT COUNT(*) as cnt FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) AND status = 'completed'`)[0]?.cnt || 0
  return (
    <box flexDirection="row" gap={1}>
      {pending > 0 && <text fg={props.s.blue}>●{pending}</text>}
      {done > 0 && <text fg={props.s.green}>✓{done}</text>}
      <text fg={props.s.muted}>agents</text>
    </box>
  )
}

// ═══════════════════════════════════════════════════════════
// 5. HOME BOTTOM — fleet overview
// ═══════════════════════════════════════════════════════════
const HomeBottom = (props: { api: TuiPluginApi; s: S }) => {
  const lanes = query(`SELECT lane_id, agent, status FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) ORDER BY delegated_at DESC LIMIT 40`)
  const grouped = new Map<string, any[]>()
  for (const l of lanes) {
    const g = grouped.get(l.lane_id) || []
    g.push(l)
    grouped.set(l.lane_id, g)
  }

  if (lanes.length === 0) return <box />

  return (
    <box width="100%" maxWidth={75} alignItems="center" paddingTop={1} flexShrink={0} gap={1}>
      <box border borderColor={props.s.border} backgroundColor={props.s.panel} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} width="100%" flexDirection="column" gap={1}>
        <text fg={props.s.blue}><b>🚀 Active Fleet</b></text>
        <box flexDirection="row" gap={2} flexWrap="wrap">
          {[...grouped.entries()].slice(0, 6).map(([lane, agents]) => (
            <box flexDirection="column" gap={0}>
              <text fg={props.s.muted}>{lane.slice(0, 10)}</text>
              {agents.slice(0, 3).map((a: any) => (
                <text fg={a.status === "completed" ? props.s.green : a.status === "pending" ? props.s.blue : props.s.red}>
                  {a.status === "completed" ? "✓" : a.status === "pending" ? "●" : "✗"} {a.agent.slice(0, 12)}
                </text>
              ))}
            </box>
          ))}
        </box>
      </box>
    </box>
  )
}

// ═══════════════════════════════════════════════════════════
// SLOTS
// ═══════════════════════════════════════════════════════════

const createSlots = (api: TuiPluginApi): TuiSlotPlugin[] => {
  const s = skin(api)
  let sessionId = ""

  // Poll for new completions
  let lastDone = 0
  setInterval(() => {
    const done = query(`SELECT COUNT(*) as cnt FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) AND status = 'completed'`)[0]?.cnt || 0
    if (done > lastDone && lastDone > 0) {
      api.ui.toast({ variant: "info", title: "Agent Done", message: `${done - lastDone} agent(s) completed.`, duration: 2500 })
    }
    lastDone = done
  }, 5000)

  return [
    // ── Sidebar fleet ──
    {
      order: 100,
      slots: {
        sidebar_title(ctx, value) {
          sessionId = value.session_id
          const done = query(`SELECT COUNT(*) as cnt FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) AND status = 'completed'`)[0]?.cnt || 0
          const pending = query(`SELECT COUNT(*) as cnt FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) AND status = 'pending'`)[0]?.cnt || 0
          return (
            <text fg={s.blue}>
              <b>Fleet</b>
              <span fg={s.muted}> {pending}p {done}d</span>
            </text>
          )
        },
        sidebar_content(ctx, value) {
          return (
            <box flexDirection="column" gap={1}>
              <FleetSidebar api={api} s={s} sessionId={value.session_id} />
              <box height={1} backgroundColor={s.border} />
              <HandoffFeed s={s} />
              <box height={1} backgroundColor={s.border} />
              <HotspotWarnings s={s} />
            </box>
          )
        },
        sidebar_footer(ctx, value) {
          const errors = query(`SELECT SUM(type_errors + test_failures) as cnt FROM error_hotspots`)[0]?.cnt || 0
          return <text fg={errors > 0 ? s.red : s.muted}>{errors > 0 ? `🔥 ${errors} errors` : "✓ clean"}</text>
        },
      },
    },
    // ── Session prompt enrichment ──
    {
      order: 50,
      slots: {
        session_prompt_right(ctx, value) {
          return <SessionPromptLeft api={api} s={s} sessionId={value.session_id} />
        },
      },
    },
    // ── Home bottom fleet overview ──
    {
      order: 100,
      slots: {
        home_bottom(ctx) {
          return <HomeBottom api={api} s={s} />
        },
      },
    },
  ]
}

// ═══════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════

const CMD = {
  fleet_refresh: "orchestration.fleet.refresh",
  fleet_summary: "orchestration.fleet.summary",
  agent_toast: "orchestration.agent.toast",
}

const defaultBindings: BindingConfig<Renderable, KeyEvent> = {
  [CMD.fleet_refresh]: "ctrl+shift+r",
  [CMD.fleet_summary]: "ctrl+shift+s",
}

const tui: TuiPlugin = async (api, options, meta) => {
  if (options?.enabled === false) return

  // 🎨 Install and activate the Obsidian Orchestra theme
  await api.theme.install("./plugins/obsidian-orchestra.json")
  api.theme.set("obsidian-orchestra")

  const keys = createBindingLookup(defaultBindings)

  // Register commands
  api.keymap.registerLayer({
    commands: [
      {
        name: CMD.fleet_refresh,
        title: "Refresh fleet",
        category: "Orchestration",
        namespace: "palette",
        slashName: "fleet-refresh",
        run() {
          const pending = query(`SELECT COUNT(*) as cnt FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) AND status = 'pending'`)[0]?.cnt || 0
          const done = query(`SELECT COUNT(*) as cnt FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) AND status = 'completed'`)[0]?.cnt || 0
          api.ui.toast({ variant: "info", title: "Fleet", message: `${pending} pending, ${done} done`, duration: 2000 })
        },
      },
      {
        name: CMD.fleet_summary,
        title: "Fleet summary",
        category: "Orchestration",
        namespace: "palette",
        slashName: "fleet-summary",
        run() {
          const lanes = query(`SELECT DISTINCT lane_id FROM lane_agents`)
          const agents = query(`SELECT COUNT(*) as cnt FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent)`)
          api.ui.toast({ variant: "info", title: "Fleet Summary", message: `${lanes.length} lanes, ${agents[0]?.cnt || 0} agents`, duration: 3000 })
        },
      },
    ],
    bindings: keys.gather("orchestration", [CMD.fleet_refresh, CMD.fleet_summary]),
  })

  // Register all slots
  for (const slot of createSlots(api)) {
    api.slots.register(slot)
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: "orchestration-tui",
  tui,
}

export default plugin
