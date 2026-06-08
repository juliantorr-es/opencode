export type InvalidationScope =
  | "file_summary"
  | "symbol_outline"
  | "module_summary"
  | "related_test_status"
  | "working_set_ranking"
  | "checkpoint_readiness"
  | "validation_clean_state"
  | "pr_readiness"
  | "hypothesis_confidence"
  | "project_map"
  | "claims"
  | "dirty_file_state"
  | "file_digests"
  | "plugin_capability_context"
  | "tool_registry_context"
  | "event_projections"
  | "duckdb_views"

const registry = new Map<string, readonly InvalidationScope[]>()

export function registerInvalidations(eventType: string, scopes: InvalidationScope[]): void {
  const existing = registry.get(eventType)
  if (existing) {
    registry.set(eventType, [...existing, ...scopes])
  } else {
    registry.set(eventType, scopes)
  }
}

export function getInvalidations(eventType: string): readonly InvalidationScope[] {
  return registry.get(eventType) ?? []
}

registerInvalidations("file.edited", [
  "file_summary", "symbol_outline", "module_summary", "related_test_status",
  "working_set_ranking", "checkpoint_readiness", "file_digests",
])
registerInvalidations("file.read", ["working_set_ranking"])
registerInvalidations("session.next.tool.failed", [
  "validation_clean_state", "hypothesis_confidence", "event_projections",
])
registerInvalidations("session.next.tool.success", ["validation_clean_state"])
registerInvalidations("session.next.prompted", ["working_set_ranking"])
registerInvalidations("permission.asked", ["claims"])
registerInvalidations("permission.replied", ["claims"])
registerInvalidations("coordination.path.claimed", ["claims"])
registerInvalidations("coordination.path.released", ["claims"])
registerInvalidations("git.status", ["dirty_file_state", "file_digests"])
registerInvalidations("project.updated", ["project_map"])
registerInvalidations("vcs.branch_updated", [
  "project_map", "claims", "dirty_file_state", "file_digests",
])
registerInvalidations("session.checkpoint", ["checkpoint_readiness", "event_projections"])
registerInvalidations("session.compacted", ["pr_readiness"])
registerInvalidations("mcp.tools_changed", ["tool_registry_context"])
registerInvalidations("plugin.configured", ["plugin_capability_context"])
registerInvalidations("duckdb.view_updated", ["duckdb_views"])
registerInvalidations("context.request_refresh", ["event_projections"])
