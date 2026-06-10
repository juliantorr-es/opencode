/**
 * Review Export Runner — focused compatibility adapter for the four
 * Oxc-dependent review export tools. NOT a generic OMP factory loader.
 *
 * These tools export CustomToolFactory functions requiring @oh-my-pi/pi-coding-agent.
 * This runner provides the minimal pi/ctx harness needed to instantiate and execute them.
 *
 * Will be removed once the Oxc stack is extracted into @tribunus-ai/repository-intelligence.
 *
 * Usage: bun run review-export-runner.ts <tool-name> '<json-args>'
 *   tool-name: code_review_export | review_packet_export | semantic_review_packet_export | verify_review_packets
 */

import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import * as z from "zod"

const OMP_TOOLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".omp", "tools")

interface ToolResult {
  content: Array<{ type: string; text: string }>
  details?: Record<string, unknown>
}

async function main() {
  const toolName = process.argv[2]
  const argsJson = process.argv[3] || "{}"

  if (!toolName) {
    process.stderr.write(JSON.stringify({ error: "Usage: review-export-runner.ts <tool-name> '<json-args>'" }) + "\n")
    process.exit(1)
  }

  let params: Record<string, unknown>
  try {
    params = JSON.parse(argsJson)
  } catch {
    process.stderr.write(JSON.stringify({ error: `Invalid JSON args: ${argsJson}` }) + "\n")
    process.exit(1)
  }

  const pi = {
    cwd: process.cwd(),
    zod: z,
    resolve: (p: string) => resolve(process.cwd(), p),
  }

  const ctx = {
    sessionId: process.env.OMP_SESSION_ID || "review-export-runner",
  }

  const toolPath = resolve(OMP_TOOLS_DIR, `${toolName}.ts`)

  try {
    const mod = await import(toolPath)
    const factory = mod.default as (pi: { cwd: string; zod: typeof z; resolve: (p: string) => string }) => { execute: (callId: string, params: Record<string, unknown>, onUpdate?: unknown, ctx?: unknown, signal?: unknown) => Promise<ToolResult> }

    if (typeof factory !== "function") {
      process.stderr.write(JSON.stringify({ error: `Tool '${toolName}' does not export a default factory` }) + "\n")
      process.exit(1)
    }

    const tool = (factory as (p: typeof pi) => ReturnType<typeof factory>)(pi)
    const result = await tool.execute(`review-export-${Date.now()}`, params, undefined, ctx, undefined)
    process.stdout.write(JSON.stringify(result) + "\n")
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: `Tool '${toolName}' failed: ${(e as Error).message}` }) + "\n")
    process.exit(1)
  }
}

main()
