import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js"
import { resolveTool } from "./registry.js"
import { checkCapability } from "../governance/capabilities.js"
import { makeReceipt } from "../governance/receipts.js"
import { sha256Hex } from "../shared/digests.js"
import { ToolError } from "../shared/errors.js"
import { runWithContext, type InvocationContext } from "../governance/invocation-context.js"
import { ALLOWED_ENV } from "../governance/subprocess.js"
import { DEFAULT_BUDGET } from "../governance/limits.js"

export interface DispatchResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

export async function dispatchToolCall(request: CallToolRequest, signal: AbortSignal) {
  const { name, arguments: args } = request.params
  const input = (args ?? {}) as Record<string, unknown>

  const tool = resolveTool(name)
  if (!tool) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    }
  }

  // Check capabilities
  const capCheck = checkCapability(name)
  if (!capCheck.allowed) {
    return {
      content: [{ type: "text", text: `Capability denied: tool "${name}" requires [${capCheck.missing.join(", ")}]. Set TRIBUNUS_CAPABILITIES to enable.` }],
      isError: true,
    }
  }

  // Build invocation context
  const envDigest = sha256Hex(
    Object.entries(process.env)
      .filter(([k]) => ALLOWED_ENV.has(k))
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  )
  const { receipt, finalize } = makeReceipt(name, envDigest)
  const ctx: InvocationContext = {
    invocationId: receipt.invocation_id,
    toolName: name,
    capabilities: new Set(tool.requiredCapabilities),
    receipt,
    budget: DEFAULT_BUDGET,
    signal,
    envPolicyDigest: envDigest,
    startedAt: Date.now(),
  }

  try {
    const result = await runWithContext(ctx, () => tool.execute(ctx, input))
    finalize({
      success: true,
      timeout: false,
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      created: [],
      modified: [],
      outputDigests: {},
      errors: [],
    })
    process.stderr.write(JSON.stringify(receipt) + "\n")
    return formatResult(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const category = error instanceof ToolError ? error.category : "internal_error"
    finalize({
      success: false,
      timeout: signal.aborted,
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: message,
      created: [],
      modified: [],
      outputDigests: {},
      errors: [`[${category}] ${message}`],
    })
    process.stderr.write(JSON.stringify(receipt) + "\n")
    return {
      content: [{ type: "text", text: `[${category}] ${message}` }],
      isError: true,
    }
  }
}

function formatResult(result: unknown): DispatchResult {
  if (result && typeof result === "object" && "content" in result) {
    return result as DispatchResult
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  }
}
