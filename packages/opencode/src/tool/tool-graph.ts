import { Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.tool-graph" })

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolNode {
  id: string
  category: ToolGraphCategory
  description?: string
}

export interface ToolEdge {
  from: string
  to: string
  reason: string
}

export interface ToolGraph {
  nodes: Map<string, ToolNode>
  edges: ToolEdge[]
  /** Tool ID → downstream tool IDs */
  outgoing: Map<string, string[]>
  /** Tool ID → upstream tool IDs */
  incoming: Map<string, string[]>
}

// ─── 14 Graph Categories ──────────────────────────────────────────────────────

/**
 * Canonical graph categories — each tool belongs to one category.
 * Categories are the foundation for pipeline recommendations:
 * after using a tool, the graph suggests downstream tools
 * based on edge relationships, not on string-match heuristics.
 */
export type ToolGraphCategory =
  | "read"        // file reading, source inspection, artifact inspection
  | "write"       // file creation and editing
  | "search"      // pattern matching, grep, find, glob
  | "execute"     // bash, shell, task execution
  | "plan"        // planning, roadmap, proposal, comment
  | "delegate"    // agent delegation, task spawning
  | "checkpoint"  // git checkpoint management
  | "publish"     // publishing checkpoints and findings
  | "discover"    // state discovery, findings inspection
  | "validate"    // validation, type checking, schema validation
  | "review"      // code review, criticism, QA
  | "coordinate"  // inter-agent coordination, messaging
  | "fragment"    // fragment produce/consolidate
  | "question"    // agent questions, feedback, failure reporting

/** Per-category justification for the 14-category partitioning. */
export const CATEGORY_JUSTIFICATION: Record<ToolGraphCategory, string> = {
  read:        "Read tools observe files, sources, and artifacts — the foundation of all context-sensitive actions.",
  write:       "Write tools mutate files — the canonical output surface for agents.",
  search:      "Search tools discover locations — they produce file:line references that feed read tools.",
  execute:     "Execute tools run commands — they produce output files that feed read tools.",
  plan:        "Plan tools produce structured intent — they feed delegation and execution.",
  delegate:    "Delegate tools spawn agents — they consume plan output and produce task state.",
  checkpoint:  "Checkpoint tools persist work — they feed publish tools for remote sharing.",
  publish:     "Publish tools share work remotely — they consume checkpoint output.",
  discover:    "Discover tools inspect agent state — they feed publish tools with findings.",
  validate:    "Validate tools verify correctness — they produce failures that feed review/discover.",
  review:      "Review tools produce criticism and QA reports — they feed plan and delegate tools.",
  coordinate:  "Coordinate tools enable inter-agent communication — they feed delegate and discover.",
  fragment:    "Fragment tools manage shared-file regions — produce feeds consolidate.",
  question:    "Question tools gather human input — they feed plan, delegate, and execute.",
}

// ─── Diagnostic Fallback ──────────────────────────────────────────────────────

/** Fallback suggested tools when graph resolution fails. */
export const DIAGNOSTIC_FALLBACK = ["grep", "read", "question"]

// ─── 28 Seeded Edges (8 Pipelines) ────────────────────────────────────────────

/**
 * Seeded edges encode known tool pipelines.
 * These are the baseline — the graph can grow at runtime as new
 * tools register through setToolGraph().
 *
 * Pipelines:
 *   1. smart_find → read_source, read, read_artifact
 *   2. grep → read_source, read
 *   3. fragment.produce → fragment.consolidate
 *   4. smart_delegate → task_board
 *   5. roadmap_init → roadmap_prioritize → smart_delegate
 *   6. json_query → read_source
 *   7. bash → read
 *   8. checkpoint → publish_checkpoint
 *   9. discover_findings → publish_finding
 */
const SEEDED_EDGES: ToolEdge[] = [
  // Pipeline 1: smart_find → read_source, read, read_artifact
  { from: "smart_find", to: "read_source", reason: "Found file paths feed source reading" },
  { from: "smart_find", to: "read", reason: "Found file paths feed file reading" },
  { from: "smart_find", to: "read_artifact", reason: "Found artifact paths feed artifact reading" },

  // Pipeline 2: grep → read_source, read
  { from: "grep", to: "read_source", reason: "Found matches feed source reading at file:line" },
  { from: "grep", to: "read", reason: "Found matches feed file reading at file:line" },
  { from: "smart_grep", to: "read_source", reason: "Found matches feed source reading at file:line" },
  { from: "smart_grep", to: "read", reason: "Found matches feed file reading at file:line" },

  // Pipeline 3: fragment.produce → fragment.consolidate
  { from: "fragment", to: "consolidate", reason: "Fragment production feeds consolidation" },

  // Pipeline 4: smart_delegate → task_board
  { from: "smart_delegate", to: "task_board", reason: "Delegation spawns agents visible on task board" },

  // Pipeline 5: roadmap_init → roadmap_prioritize → smart_delegate
  { from: "roadmap_init", to: "roadmap_prioritize", reason: "Initialisation feeds prioritization" },
  { from: "roadmap_prioritize", to: "smart_delegate", reason: "Prioritized items feed delegation" },

  // Pipeline 6: json_query → read_source
  { from: "json_query", to: "read_source", reason: "JSON query results reference source files" },

  // Pipeline 7: bash → read
  { from: "bash", to: "read", reason: "Build output files should be inspected" },
  { from: "smart_bash", to: "read", reason: "Build output files should be inspected" },

  // Pipeline 8: checkpoint → publish_checkpoint
  { from: "checkpoint", to: "publish_checkpoint", reason: "Checkpoint creation feeds publication" },

  // Pipeline 9: discover_findings → publish_finding
  { from: "discover_findings", to: "publish_finding", reason: "Discovered findings feed publication" },

  // Additional cross-pipeline edges
  { from: "read_source", to: "smart_edit", reason: "Source reading feeds targeted editing" },
  { from: "read_source", to: "smart_write", reason: "Source reading feeds file creation" },
  { from: "read", to: "smart_edit", reason: "File reading feeds targeted editing" },
  { from: "read", to: "smart_write", reason: "File reading feeds file creation" },
  { from: "smart_edit", to: "read_source", reason: "Editing should be verified by re-reading" },
  { from: "smart_write", to: "read", reason: "Written files should be verified by reading" },
  { from: "smart_edit", to: "smart_bun", reason: "Type-check after editing" },
  { from: "smart_write", to: "smart_bun", reason: "Type-check after writing" },
]

// ─── Category → Tool ID Mapping ───────────────────────────────────────────────

const CATEGORY_TOOLS: Record<ToolGraphCategory, string[]> = {
  read:        ["read", "read_source", "read_artifact", "read_lib", "read_messages", "read-action"],
  write:       ["write", "smart_write", "smart_edit", "edit", "smart_batch", "replace_symbol", "smart_sd", "apply_patch", "search_replace"],
  search:      ["grep", "smart_grep", "smart_find", "glob", "json_query"],
  execute:     ["bash", "smart_bash", "shell", "task", "smart_bun"],
  plan:        ["plan", "comment-plan", "revise-plan", "propose-plan", "roadmap", "roadmap_init", "roadmap_prioritize", "roadmap_next", "todo"],
  delegate:    ["smart_delegate", "task"],
  checkpoint:  ["checkpoint", "prepare_checkpoint"],
  publish:     ["publish_checkpoint", "publish_finding", "generate_published_checkpoint_report"],
  discover:    ["discover_findings", "task_board", "analytics", "discover"],
  validate:    ["validate", "rig_schema_validate", "verify", "test"],
  review:      ["review-criticism", "qa-observed-clean", "inspect_failure", "comment-plan"],
  coordinate:  ["coordination", "send-message", "read-messages", "coordinate"],
  fragment:    ["fragment", "consolidate"],
  question:    ["question", "tool-feedback", "tool-failure"],
}

// ─── Module-Level Graph State ─────────────────────────────────────────────────

let _graph: ToolGraph | undefined = undefined

/** Inject a pre-built graph. Called by ToolRegistry.buildGraph(). */
export function setToolGraph(graph: ToolGraph): void {
  _graph = graph
}

/** Return the current graph or undefined. */
export function getToolGraph(): ToolGraph | undefined {
  return _graph
}

// ─── Graph Construction ───────────────────────────────────────────────────────

/** Build the ToolGraph from seeded edges and category tool lists. */
export const buildGraph: Effect.Effect<ToolGraph, never, never> = Effect.sync(() => {
  const nodes = new Map<string, ToolNode>()
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()

  // Populate nodes from category mapping
  for (const [category, toolIDs] of Object.entries(CATEGORY_TOOLS)) {
    for (const id of toolIDs) {
      nodes.set(id, {
        id,
        category: category as ToolGraphCategory,
        description: CATEGORY_JUSTIFICATION[category as ToolGraphCategory],
      })
    }
  }

  // Seed edges
  const edges: ToolEdge[] = []
  for (const edge of SEEDED_EDGES) {
    // Only add edge if both nodes exist
    if (nodes.has(edge.from) && nodes.has(edge.to)) {
      edges.push(edge)
      addToMap(outgoing, edge.from, edge.to)
      addToMap(incoming, edge.to, edge.from)
    }
  }

  const graph: ToolGraph = { nodes, edges, outgoing, incoming }
  setToolGraph(graph)
  log.info("Tool graph built", { nodes: nodes.size, edges: edges.length })
  return graph
})

// ─── Graph Queries ────────────────────────────────────────────────────────────

/**
 * Find all downstream tool IDs reachable from `toolId`.
 * Uses BFS with optional maxDepth to prevent infinite loops.
 * Returns diagnostic fallback for unknown tool IDs.
 */
export function findDownstream(toolId: string, maxDepth = 3): string[] {
  const graph = _graph
  if (!graph) {
    log.warn("Tool graph not available, returning diagnostic fallback")
    return DIAGNOSTIC_FALLBACK
  }

  if (!graph.nodes.has(toolId)) {
    log.warn("Unknown tool ID in findDownstream", { toolId })
    return DIAGNOSTIC_FALLBACK
  }

  const visited = new Set<string>()
  const queue: { id: string; depth: number }[] = [{ id: toolId, depth: 0 }]
  const result: string[] = []

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth >= maxDepth) continue

    const neighbors = graph.outgoing.get(current.id) ?? []
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor)
        result.push(neighbor)
        if (current.depth + 1 < maxDepth) {
          queue.push({ id: neighbor, depth: current.depth + 1 })
        }
      }
    }
  }

  return result
}

/**
 * Find all upstream tool IDs that reach `toolId`.
 * Uses reverse BFS with optional maxDepth.
 */
export function findUpstream(toolId: string, maxDepth = 3): string[] {
  const graph = _graph
  if (!graph) {
    log.warn("Tool graph not available, returning diagnostic fallback")
    return DIAGNOSTIC_FALLBACK
  }

  if (!graph.nodes.has(toolId)) {
    log.warn("Unknown tool ID in findUpstream", { toolId })
    return DIAGNOSTIC_FALLBACK
  }

  const visited = new Set<string>()
  const queue: { id: string; depth: number }[] = [{ id: toolId, depth: 0 }]
  const result: string[] = []

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth >= maxDepth) continue

    const neighbors = graph.incoming.get(current.id) ?? []
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor)
        result.push(neighbor)
        if (current.depth + 1 < maxDepth) {
          queue.push({ id: neighbor, depth: current.depth + 1 })
        }
      }
    }
  }

  return result
}

/**
 * Suggest a single-step pipeline continuation for the tool.
 * Always returns Effect.succeed([]) — never fails.
 * Falls back to legacy categories if graph is null.
 */
export function suggestPipeline(
  toolId: string,
  legacyFallback?: Record<string, string[]>,
): Effect.Effect<string[], never, never> {
  return Effect.gen(function* () {
    const graph = _graph
    if (!graph) {
      log.warn("Tool graph not available for suggestPipeline, falling back to legacy categories")
      if (legacyFallback) {
        // Resolve category from tool ID using legacy fallback
        const cat = toolCategoryLegacy(toolId)
        return legacyFallback[cat] ?? DIAGNOSTIC_FALLBACK
      }
      return DIAGNOSTIC_FALLBACK
    }

    if (!graph.nodes.has(toolId)) return []

    const immediate = graph.outgoing.get(toolId) ?? []
    // If no direct downstream edges, use graph edges from same category
    if (immediate.length === 0) {
      const node = graph.nodes.get(toolId)
      if (node) {
        const categoryPeers = CATEGORY_TOOLS[node.category] ?? []
        return categoryPeers.filter((id) => id !== toolId)
      }
    }

    return immediate
  })
}

// ─── Legacy Category Resolution (Private Fallback) ────────────────────────────

function toolCategoryLegacy(toolID: string): string {
  if (toolID.includes("read") || toolID === "read") return "read"
  if (toolID.includes("write") || toolID === "write" || toolID.includes("edit")) return "write"
  if (toolID.includes("grep") || toolID.includes("search") || toolID.includes("find")) return "search"
  if (toolID.includes("bash") || toolID.includes("run") || toolID === "task") return "execute"
  if (toolID.includes("checkpoint") || toolID.includes("todo")) return "manage"
  if (toolID.includes("plan") || toolID.includes("question")) return "plan"
  return "diagnose"
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function addToMap(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key)
  if (existing) existing.push(value)
  else map.set(key, [value])
}
