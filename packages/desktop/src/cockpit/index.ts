/**
 * Cockpit — Tribunus cockpit panel components.
 *
 * Lit Web Component panels for the desktop shell. Coexists alongside
 * the legacy SolidJS renderer. Panels are registered as custom elements
 * and can be used independently or mounted via the cockpit container.
 *
 * # Custom Elements
 * - <cockpit-panel> — Panel (base with header/toolbar/content/resize)
 * - <cockpit-session-dashboard> — SessionDashboard
 * - <cockpit-mission-board> — MissionBoard
 * - <cockpit-gate-monitor> — GateMonitor
 *
 * # PGlite Binding
 * Call `setPGliteInstance(pg)` and `setPGliteRaw(pg)` during cockpit
 * initialization to enable live query subscriptions.
 */

export { Panel } from "./panel"
export { SessionDashboard, type SessionRecord, type SessionFilter } from "./session-dashboard"
export { MissionBoard, type MissionRecord, type KanbanColumn } from "./mission-board"
export { GateMonitor, type GateEvaluation, type GateFilter } from "./gate-monitor"
export { setPGliteInstance, setPollInterval, liveQuery, liveQueryOne } from "./projection-stream"
export { setPGliteRaw, rawQuery } from "./pglite-raw"

/* ── Initialization ─────────────────────────────────────── */

/**
 * Initialize cockpit subsystems. Call once during desktop boot after the
 * PGlite client is available.
 *
 * @param pg - A PGlite client instance with the `live` extension loaded.
 */
export async function initCockpit(pg: unknown): Promise<void> {
  const { setPGliteInstance } = await import("./projection-stream")
  const { setPGliteRaw } = await import("./pglite-raw")
  setPGliteInstance(pg)
  setPGliteRaw(pg as { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> })
}
