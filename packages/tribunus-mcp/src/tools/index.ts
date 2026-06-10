import { registerTool } from "../server/registry.js"
import type { InvocationContext } from "../governance/invocation-context.js"
import { governedRun } from "../governance/subprocess.js"

function ok(result: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] } }

export function registerCrossCuttingTools(): void {
  registerTool({
    name: "tribunus_health",
    description: "Probe external dependencies (Git, Bun, Cargo, Rust, DuckDB, xcrun, Python, macmon) and return availability and versions without mutations.",
    inputSchema: { type: "object", properties: {}, required: [] },
    requiredCapabilities: [],
    timeoutMs: 30_000,
    execute: async (_ctx: InvocationContext) => {
      const probes: Array<[string, string[]]> = [
        ["git", ["--version"]],
        ["bun", ["--version"]],
        ["cargo", ["--version"]],
        ["rustc", ["--version"]],
        ["python3", ["--version"]],
        ["xcrun", ["--version"]],
      ]
      const results: Record<string, { available: boolean; version?: string; error?: string }> = {}
      for (const [cmd, args] of probes) {
        const r = await governedRun(cmd, args, { timeout: 10_000 })
        results[cmd] = { available: r.ok, version: r.ok ? r.stdout.trim() : undefined, error: r.ok ? undefined : r.stderr.slice(0, 200) }
      }
      try {
        const r = await fetch(process.env.MACMONT_URL || "http://localhost:9090/metrics")
        results["macmon"] = { available: r.ok, version: r.ok ? "responding" : `HTTP ${r.status}` }
      } catch (e) {
        results["macmon"] = { available: false, error: String(e).slice(0, 100) }
      }
      return ok(results)
    },
  })

  registerTool({
    name: "tribunus_describe",
    description: "Return the effective manifest for all available tools including authority, capabilities, and schema digests.",
    inputSchema: { type: "object", properties: {}, required: [] },
    requiredCapabilities: [],
    timeoutMs: 5_000,
    aliases: ["tribunus_tools_describe"],
    execute: async (_ctx: InvocationContext) => {
      const { listTools } = await import("../server/registry.js")
      const tools = listTools().map(t => ({
        name: t.name,
        description: t.description,
        requiredCapabilities: t.requiredCapabilities,
        inputSchema: t.inputSchema,
        timeoutMs: t.timeoutMs,
        aliases: t.aliases,
      }))
      return ok({ tool_count: tools.length, tools })
    },
  })
}
