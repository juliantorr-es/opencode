/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions, type JSX } from "@opentui/solid"
import { useBindings } from "@opentui/keymap/solid"
import { RGBA, type KeyEvent, type Renderable } from "@opentui/core"
import { createBindingLookup, type BindingConfig } from "@opentui/keymap/extras"
import type { TuiPlugin, TuiPluginApi, TuiPluginMeta, TuiPluginModule, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import { Database } from "bun:sqlite"
import { resolve } from "node:path"

// ── Database access ──
function getDb(worktree: string): Database | null {
  try {
    const dbPath = resolve(worktree, "docs/json/opencode/state.db")
    const { existsSync } = require("node:fs") as typeof import("node:fs")
    if (!existsSync(dbPath)) return null
    return new Database(dbPath, { readonly: true })
  } catch { return null }
}

function getFleet(worktree: string): any[] {
  const db = getDb(worktree)
  if (!db) return []
  try {
    return db.query(`
      SELECT lane_id, agent, status, delegated_at, elapsed_ms FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY lane_id, agent ORDER BY id DESC) as rn
        FROM lane_agents
      ) WHERE rn = 1 ORDER BY delegated_at DESC LIMIT 20
    `).all() as any[]
  } catch { return [] }
}

function getStats(worktree: string): { pending: number; done: number; failed: number } {
  const db = getDb(worktree)
  if (!db) return { pending: 0, done: 0, failed: 0 }
  try {
    const pending = (db.query(`SELECT COUNT(*) as cnt FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) AND status = 'pending'`).get() as any)?.cnt || 0
    const done = (db.query(`SELECT COUNT(*) as cnt FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) AND status = 'completed'`).get() as any)?.cnt || 0
    const failed = (db.query(`SELECT COUNT(*) as cnt FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) AND status IN ('failed','stale')`).get() as any)?.cnt || 0
    return { pending, done, failed }
  } catch { return { pending: 0, done: 0, failed: 0 } }
}

// ── Color palette ──
const colors = {
  panel: "#161b22",
  border: "#30363d",
  text: "#c9d1d9",
  muted: "#8b949e",
  accent: "#58a6ff",
  success: "#3fb950",
  warning: "#d29922",
  error: "#f85149",
  purple: "#bc8cff",
}

type Skin = typeof colors

function skin(api: TuiPluginApi): Skin {
  const map = api.theme.current
  return {
    panel: (map.backgroundPanel as string) || colors.panel,
    border: (map.border as string) || colors.border,
    text: (map.text as string) || colors.text,
    muted: (map.textMuted as string) || colors.muted,
    accent: (map.primary as string) || colors.accent,
    success: (map.success as string) || colors.success,
    warning: (map.warning as string) || colors.warning,
    error: (map.error as string) || colors.error,
    purple: (map.secondary as string) || colors.purple,
  }
}

const statusColor = (status: string, s: Skin): string => {
  if (status === "completed") return s.success
  if (status === "pending" || status === "started") return s.accent
  if (status === "failed" || status === "stale") return s.error
  return s.muted
}

const statusIcon = (status: string): string => {
  if (status === "completed") return "✅"
  if (status === "pending") return "🔵"
  if (status === "started") return "🟢"
  if (status === "stale") return "💀"
  if (status === "failed") return "❌"
  return "⬜"
}

// ── Commands ──
const CMD = {
  fleet_toggle: "fleet.toggle",
  fleet_refresh: "fleet.refresh",
}

const keymap: BindingConfig<Renderable, KeyEvent> = {
  [CMD.fleet_toggle]: "ctrl+shift+f",
  [CMD.fleet_refresh]: "ctrl+r",
}

// ═══════════════════════════════════════════════════════════
// FLEET SIDEBAR — live lane/agent status
// ═══════════════════════════════════════════════════════════
const FleetSidebar = (props: { api: TuiPluginApi; worktree: string }) => {
  const s = skin(props.api)
  const stats = getStats(props.worktree)
  const fleet = getFleet(props.worktree)
  
  // Group by lane
  const lanes = new Map<string, any[]>()
  for (const f of fleet) {
    const l = lanes.get(f.lane_id) || []
    l.push(f)
    lanes.set(f.lane_id, l)
  }

  return (
    <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1} paddingLeft={1} paddingRight={1}>
      {/* Stats header */}
      <box flexDirection="row" gap={1} paddingBottom={1} border borderColor={s.border} paddingTop={1} paddingBottom={1} paddingLeft={1} paddingRight={1}>
        <text fg={s.accent}><b>{stats.pending}</b></text>
        <text fg={s.muted}>pending</text>
        <text fg={s.success}><b>{stats.done}</b></text>
        <text fg={s.muted}>done</text>
        {stats.failed > 0 && (
          <>
            <text fg={s.error}><b>{stats.failed}</b></text>
            <text fg={s.muted}>failed</text>
          </>
        )}
      </box>
      
      {/* Lane list */}
      {[...lanes.entries()].slice(0, 5).map(([laneId, agents]) => (
        <box flexDirection="column" gap={0} paddingBottom={1}>
          <text fg={s.muted}><b>{laneId.slice(0, 10)}</b></text>
          {agents.slice(0, 4).map((a: any) => (
            <text fg={statusColor(a.status, s)}>
              {"  "}{statusIcon(a.status)} {a.agent.slice(0, 14)}
            </text>
          ))}
        </box>
      ))}
      
      {fleet.length === 0 && (
        <text fg={s.muted}>No agents yet</text>
      )}
    </box>
  )
}

// ═══════════════════════════════════════════════════════════
// SLOT PLUGIN: fleet sidebar content
// ═══════════════════════════════════════════════════════════
const sidebarSlot = (worktree: string): TuiSlotPlugin => ({
  order: 200,
  slots: {
    sidebar_content(ctx, value) {
      const api = ctx as unknown as TuiPluginApi
      return <FleetSidebar api={api} worktree={worktree} />
    },
  },
})

// ═══════════════════════════════════════════════════════════
// TUI PLUGIN
// ═══════════════════════════════════════════════════════════
const tui: TuiPlugin = async (api, options, meta) => {
  if (options?.enabled === false) return

  const worktree = (options?.worktree as string) || process.cwd()
  const keys = createBindingLookup(keymap)

  // Register commands
  api.keymap.registerLayer({
    commands: [
      {
        name: CMD.fleet_toggle,
        title: "Toggle fleet sidebar",
        category: "Orchestration",
        namespace: "palette",
        slashName: "fleet",
        run() {
          api.ui.toast({
            variant: "info",
            title: "Fleet",
            message: `Fleet sidebar is always visible below.`,
            duration: 2000,
          })
        },
      },
      {
        name: CMD.fleet_refresh,
        title: "Refresh fleet stats",
        category: "Orchestration",
        run() {
          api.ui.toast({
            variant: "info",
            title: "Fleet",
            message: "Fleet refreshed.",
            duration: 1000,
          })
        },
      },
    ],
    bindings: keys.gather("fleet", [CMD.fleet_toggle, CMD.fleet_refresh]),
  })

  // Register sidebar slot
  api.slots.register(sidebarSlot(worktree))

  // ── Agent completion toasts ──
  // Poll periodically for newly completed agents
  let lastDone = 0
  const pollInterval = setInterval(() => {
    const stats = getStats(worktree)
    if (stats.done > lastDone) {
      api.ui.toast({
        variant: "info",
        title: "Agent Complete",
        message: `${stats.done - lastDone} agent(s) completed. ${stats.pending} still running.`,
        duration: 3000,
      })
      lastDone = stats.done
    }
  }, 5000)

  api.lifecycle.onDispose(() => {
    clearInterval(pollInterval)
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "fleet-tui",
  tui,
}

export default plugin
