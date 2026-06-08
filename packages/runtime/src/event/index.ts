// ── Runtime Event Module ───────────────────────────────────
//
// Lane 1: EventStore runtime — recording and querying runtime
// events through the database adapter.
// Lane 2: Agent-facing query tools — Effect service + tool
// definitions for session event history queries.
// Lane 3: DuckDB analytical queries for runtime event data.
//
// This module re-exports all layers of the event system.

export * as RuntimeEvent from "./runtime-event"
export * as EventStore from "./event-store"
export * as EventStoreBridge from "./event-bridge"
export { RuntimeEventTable } from "./event.pg.sql"
export { EventName, EventNameValues } from "./event-names"

// Lane 2 — Agent-facing event history queries
export * as EventAgentQueries from "./agent-queries"

// Lane 3 — DuckDB analytical query functions
export {
  queryFailureHotspots,
  querySlowTools,
  queryFileContention,
  queryPhaseGateDenials,
  queryErrorSummary,
  querySessionTimeline,
} from "./event-queries"

export type {
  FailureHotspot,
  SlowTool,
  FileContention,
  PhaseGateDenial,
  ErrorSummary,
  SessionEvent,
} from "./event-queries"
