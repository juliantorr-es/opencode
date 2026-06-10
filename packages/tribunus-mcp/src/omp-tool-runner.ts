/**
 * OMP Tool Runner — adapts .omp/tools/*.ts CustomToolFactory exports
 * into a stdin→stdout CLI interface callable by the Tribunus MCP server.
 *
 * Usage: echo '{"tool":"task_board","params":{}}' | bun run omp-tool-runner.ts
 *
 * Reads one JSON line from stdin: { tool: string, params: Record<string, unknown> }
 * Writes one JSON line to stdout: { content: [{ type: "text", text: string }], details?: unknown }
 * Errors are written to stderr as JSON with { error: string }
 */

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import * as z from "zod"

const __dirname = dirname(fileURLToPath(import.meta.url))
const OMP_TOOLS_DIR = resolve(__dirname, "..", "..", ".omp", "tools")

// ── Minimal pi mock ─────────────────────────────────────────────────────────

const pi = {
  cwd: process.cwd(),
  zod: z,
  readFile: (p: string) => readFileSync(p, "utf-8"),
  writeFile: (p: string, data: string) => {
    const { writeFileSync, mkdirSync } = require("node:fs")
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, data, "utf-8")
  },
  resolve: (p: string) => resolve(pi.cwd, p),
}

const ctx = {
  sessionId: process.env.OMP_SESSION_ID || "mcp-proxy",
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  let input = ""
  for await (const chunk of process.stdin) {
    input += chunk
  }

  let request: { tool: string; params: Record<string, unknown> }
  try {
    request = JSON.parse(input)
  } catch {
    process.stderr.write(JSON.stringify({ error: "Invalid JSON input" }) + "\n")
    process.exit(1)
  }

  const { tool, params } = request
  if (!tool) {
    process.stderr.write(JSON.stringify({ error: "Missing 'tool' field" }) + "\n")
    process.exit(1)
  }

  // Resolve tool module path
  const toolPath = resolve(OMP_TOOLS_DIR, `${tool}.ts`)
  let factory: { default?: (pi: typeof import("./omp-tool-runner") extends never ? never : unknown) => unknown }

  try {
    factory = await import(toolPath)
  } catch (e) {
    process.stderr.write(
      JSON.stringify({ error: `Failed to load tool '${tool}': ${(e as Error).message}` }) + "\n",
    )
    process.exit(1)
  }

  const createTool = factory.default
  if (typeof createTool !== "function") {
    process.stderr.write(
      JSON.stringify({ error: `Tool '${tool}' does not export a default factory function` }) + "\n",
    )
    process.exit(1)
  }

  try {
    const toolInstance = (createTool as (pi: unknown) => { execute: (callId: string, params: Record<string, unknown>, onUpdate?: unknown, ctx?: unknown, signal?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> })(pi)
    const result = await toolInstance.execute(`mcp-${Date.now()}`, params || {}, undefined, ctx, undefined)
    process.stdout.write(JSON.stringify(result) + "\n")
  } catch (e) {
    process.stderr.write(
      JSON.stringify({ error: `Tool '${tool}' execution failed: ${(e as Error).message}` }) + "\n",
    )
    process.exit(1)
  }
}

main().catch((e) => {
  process.stderr.write(JSON.stringify({ error: String(e) }) + "\n")
  process.exit(1)
})
