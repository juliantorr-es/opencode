import { describe, it, expect, beforeAll, beforeEach } from "bun:test"
import { Effect } from "effect"
import * as ToolGraph from "../../src/tool/tool-graph"

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build the graph synchronously before tests that need it. */
function buildSync(): ToolGraph.ToolGraph {
  return Effect.runSync(ToolGraph.buildGraph)
}

// ─── Graph Construction ───────────────────────────────────────────────────────

describe("ToolGraph construction", () => {
  it("builds a graph with nodes from all 14 categories", () => {
    const graph = buildSync()
    expect(graph.nodes.size).toBeGreaterThan(50)
    // Verify key categories exist
    const categories = new Set([...graph.nodes.values()].map((n) => n.category))
    expect(categories.has("read")).toBe(true)
    expect(categories.has("write")).toBe(true)
    expect(categories.has("search")).toBe(true)
    expect(categories.has("execute")).toBe(true)
  })

  it("seeds 24 edges from the 9 pipelines", () => {
    const graph = buildSync()
    expect(graph.edges.length).toBeGreaterThanOrEqual(24)
  })

  it("has correct outgoing for grep → read_source, read", () => {
    const graph = buildSync()
    const downstream = graph.outgoing.get("grep") ?? []
    expect(downstream).toContain("read_source")
    expect(downstream).toContain("read")
  })

  it("has correct outgoing for smart_find → read_source, read, read_artifact", () => {
    const graph = buildSync()
    const downstream = graph.outgoing.get("smart_find") ?? []
    expect(downstream).toContain("read_source")
    expect(downstream).toContain("read")
    expect(downstream).toContain("read_artifact")
  })

  it("has correct incoming for read_source ← grep, smart_grep, smart_find", () => {
    const graph = buildSync()
    const upstream = graph.incoming.get("read_source") ?? []
    expect(upstream).toContain("grep")
    expect(upstream).toContain("smart_grep")
    expect(upstream).toContain("smart_find")
  })

  it("has checkpoint → publish_checkpoint pipeline", () => {
    const graph = buildSync()
    const downstream = graph.outgoing.get("checkpoint") ?? []
    expect(downstream).toContain("publish_checkpoint")
  })

  it("has discover_findings → publish_finding pipeline", () => {
    const graph = buildSync()
    const downstream = graph.outgoing.get("discover_findings") ?? []
    expect(downstream).toContain("publish_finding")
  })
})

// ─── findDownstream ───────────────────────────────────────────────────────────

describe("findDownstream", () => {
  beforeEach(() => {
    buildSync()
  })

  it("returns downstream tools for a known tool", () => {
    const result = ToolGraph.findDownstream("grep")
    expect(result).toContain("read_source")
    expect(result).toContain("read")
  })

  it("returns multi-level downstream for smart_find (read_source → smart_edit)", () => {
    const result = ToolGraph.findDownstream("smart_find", 3)
    expect(result).toContain("read_source")
    expect(result).toContain("read")
    expect(result).toContain("smart_edit") // downstream of read_source
  })

  it("returns diagnostic fallback for unknown tool ID", () => {
    const result = ToolGraph.findDownstream("nonexistent_tool_xyz")
    expect(result).toEqual(ToolGraph.DIAGNOSTIC_FALLBACK)
  })

  it("returns diagnostic fallback when graph is not built", () => {
    ToolGraph.setToolGraph(undefined as unknown as ToolGraph.ToolGraph)
    const result = ToolGraph.findDownstream("grep")
    expect(result).toEqual(ToolGraph.DIAGNOSTIC_FALLBACK)
  })

  it("respects maxDepth = 1 (only immediate neighbors)", () => {
    const result = ToolGraph.findDownstream("smart_find", 1)
    expect(result).toContain("read_source")
    expect(result).not.toContain("smart_edit") // smart_edit is depth 2
  })
})

// ─── findUpstream ─────────────────────────────────────────────────────────────

describe("findUpstream", () => {
  beforeEach(() => {
    buildSync()
  })

  it("returns upstream tools that feed into a known tool", () => {
    const result = ToolGraph.findUpstream("read_source")
    expect(result).toContain("grep")
    expect(result).toContain("smart_grep")
    expect(result).toContain("smart_find")
  })

  it("returns diagnostic fallback for unknown tool ID", () => {
    const result = ToolGraph.findUpstream("nonexistent_tool_xyz")
    expect(result).toEqual(ToolGraph.DIAGNOSTIC_FALLBACK)
  })

  it("returns diagnostic fallback when graph is not built", () => {
    ToolGraph.setToolGraph(undefined as unknown as ToolGraph.ToolGraph)
    const result = ToolGraph.findUpstream("read_source")
    expect(result).toEqual(ToolGraph.DIAGNOSTIC_FALLBACK)
  })
})

// ─── suggestPipeline ──────────────────────────────────────────────────────────

describe("suggestPipeline", () => {
  beforeEach(() => {
    buildSync()
  })

  it("returns Effect.succeed with downstream tools for known tool", () => {
    const result = Effect.runSync(ToolGraph.suggestPipeline("grep"))
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain("read_source")
  })

  it("returns Effect.succeed with empty array for unknown tool — never fails", () => {
    const result = Effect.runSync(ToolGraph.suggestPipeline("nonexistent_tool_xyz"))
    expect(result).toEqual([])
  })

  it("falls back to legacy categories when graph is null", () => {
    ToolGraph.setToolGraph(undefined as unknown as ToolGraph.ToolGraph)
    const legacy = {
      search: ["read", "webfetch"],
      read: ["grep", "glob"],
      write: ["read"],
      execute: ["bash", "task"],
      manage: ["checkpoint"],
      plan: ["question"],
      diagnose: ["grep", "read"],
    }
    const result = Effect.runSync(ToolGraph.suggestPipeline("grep", legacy))
    // grep maps to "search" in legacy, so should get ["read", "webfetch"]
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain("read")
  })
})

// ─── DIAGNOSTIC_FALLBACK ──────────────────────────────────────────────────────

describe("DIAGNOSTIC_FALLBACK", () => {
  it("contains grep, read, question", () => {
    expect(ToolGraph.DIAGNOSTIC_FALLBACK).toContain("grep")
    expect(ToolGraph.DIAGNOSTIC_FALLBACK).toContain("read")
    expect(ToolGraph.DIAGNOSTIC_FALLBACK).toContain("question")
  })

  it("has exactly 3 entries", () => {
    expect(ToolGraph.DIAGNOSTIC_FALLBACK.length).toBe(3)
  })
})

// ─── setToolGraph / getToolGraph ──────────────────────────────────────────────

describe("setToolGraph / getToolGraph roundtrip", () => {
  it("sets and retrieves the graph", () => {
    const graph = buildSync()
    expect(ToolGraph.getToolGraph()).toBe(graph)
  })

  it("returns undefined before build", () => {
    ToolGraph.setToolGraph(undefined as unknown as ToolGraph.ToolGraph)
    expect(ToolGraph.getToolGraph()).toBeUndefined()
  })
})

// ─── CATEGORY_JUSTIFICATION ───────────────────────────────────────────────────

describe("CATEGORY_JUSTIFICATION", () => {
  it("has entries for all 14 categories", () => {
    const keys = Object.keys(ToolGraph.CATEGORY_JUSTIFICATION)
    expect(keys.length).toBe(14)
  })

  it("every justification is a non-empty string", () => {
    for (const [category, justification] of Object.entries(ToolGraph.CATEGORY_JUSTIFICATION)) {
      expect(justification.length, `Category "${category}" has empty justification`).toBeGreaterThan(0)
    }
  })
})

// ─── Edge integrity ───────────────────────────────────────────────────────────

describe("Edge integrity", () => {
  beforeEach(() => {
    buildSync()
  })

  it("every edge 'from' node exists in the graph", () => {
    const graph = ToolGraph.getToolGraph()!
    for (const edge of graph.edges) {
      expect(graph.nodes.has(edge.from), `Edge from "${edge.from}" has no node`).toBe(true)
    }
  })

  it("every edge 'to' node exists in the graph", () => {
    const graph = ToolGraph.getToolGraph()!
    for (const edge of graph.edges) {
      expect(graph.nodes.has(edge.to), `Edge to "${edge.to}" has no node`).toBe(true)
    }
  })

  it("every edge has a non-empty reason", () => {
    const graph = ToolGraph.getToolGraph()!
    for (const edge of graph.edges) {
      expect(edge.reason.length, `Edge ${edge.from}→${edge.to} has empty reason`).toBeGreaterThan(0)
    }
  })
})
