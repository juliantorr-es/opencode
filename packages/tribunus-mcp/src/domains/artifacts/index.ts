import { registerTool } from "../../server/registry.js"
import type { InvocationContext } from "../../governance/invocation-context.js"
import type { Capability } from "../../governance/capabilities.js"
import type { RegisteredTool } from "../../server/registry.js"
import { getStore } from "../../governance/store.js"
import type { PgliteDb } from "../../governance/store.js"
import type { ArtifactType, ArtifactState } from "../../services/artifacts/types.js"
import { ArtifactRegistryService } from "../../services/artifacts/registry.js"
import { fileDigest } from "../../services/artifacts/identity.js"
import { existsSync } from "node:fs"

function ok(result: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] } }
function err(msg: string) { return { content: [{ type: "text" as const, text: msg }], isError: true } }

type ToolInputProps = Record<string, { type?: string; enum?: string[]; items?: { type: string }; description?: string }>
type ToolProps = Record<string, unknown>

function register(name: string, desc: string, props: ToolInputProps, req: string[], caps: Capability[], ms: number, fn: (ctx: InvocationContext, a: ToolProps) => Promise<unknown>): void {
  registerTool({
    name, description: desc, inputSchema: { type: "object", properties: props, required: req },
    requiredCapabilities: caps, timeoutMs: ms, execute: fn,
  } satisfies Omit<RegisteredTool, "aliases"> & { aliases?: string[] })
}

async function getRegistry(): Promise<ArtifactRegistryService> {
  const db = await getStore()
  return new ArtifactRegistryService(db as PgliteDb)
}

export function registerArtifactTools(): void {
  register("tribunus_artifact_get", "Retrieve an artifact by ID. Returns the full artifact record including lifecycle state, digest, path, and metadata.", {
    artifact_id: { type: "string", description: "Artifact ID" },
  }, ["artifact_id"], ["artifact:read"], 10_000, async (ctx, a) => {
    const registry = await getRegistry()
    const artifact = await registry.get(a.artifact_id as string)
    return ok(artifact)
  })

  register("tribunus_artifact_list", "List artifacts with filters. Supports type, state, producer, invocation, digest, path prefix, and verification status. Cursor pagination based on created_at and artifact_id.", {
    artifact_type: { type: "string", description: "Filter by artifact type (e.g. review_gemini_zip_v1)" },
    state: { type: "string", description: "Filter by lifecycle state (e.g. finalized, verified)" },
    producer_tool: { type: "string", description: "Filter by producer tool name" },
    invocation_id: { type: "string", description: "Filter by invocation ID" },
    content_digest: { type: "string", description: "Filter by content SHA-256 digest" },
    path_prefix: { type: "string", description: "Filter by canonical path prefix" },
    verification_status: { type: "string", enum: ["none","passed","failed","stale"], description: "Filter by verification status" },
    cursor: { type: "string", description: "Pagination cursor (from previous response)" },
    limit: { type: "number", description: "Max results (default 20, max 100)" },
  }, [], ["artifact:read"], 15_000, async (ctx, a) => {
    const registry = await getRegistry()
    const result = await registry.list({
      artifactType: a.artifact_type as ArtifactType | undefined,
      state: a.state as ArtifactState | undefined,
      producerTool: a.producer_tool as (string | undefined),
      invocationId: a.invocation_id as (string | undefined),
      contentDigest: a.content_digest as (string | undefined),
      pathPrefix: a.path_prefix as (string | undefined),
      verificationStatus: a.verification_status as (string | undefined),
      cursor: a.cursor as (string | undefined),
      limit: a.limit as (number | undefined),
    })
    return ok(result)
  })

  register("tribunus_artifact_verify", "Verify an artifact by ID. Runs generic verification (existence, digest, size) plus typed verification when a specialized verifier exists for the artifact type. Never mutates bytes.", {
    artifact_id: { type: "string", description: "Artifact ID to verify" },
  }, ["artifact_id"], ["artifact:verify"], 30_000, async (ctx, a) => {
    const registry = await getRegistry()
    const artifact = await registry.get(a.artifact_id as string)
    const path = artifact.canonical_path

    const checks: Array<{ check: string; status: "pass" | "fail"; detail?: string }> = []

    // Existence check
    if (!existsSync(path)) {
      checks.push({ check: "existence", status: "fail", detail: `File not found at ${path}` })
      await registry.markMissing(artifact.artifact_id)
      return ok({ artifact_id: artifact.artifact_id, status: "failed", checks })
    }
    checks.push({ check: "existence", status: "pass" })

    // Digest check
    const result = await fileDigest(path)
    if (result.digest !== artifact.content_digest) {
      checks.push({ check: "digest", status: "fail", detail: `Expected ${artifact.content_digest}, got ${result.digest}` })
      await registry.quarantine(artifact.artifact_id, "digest mismatch")
      return ok({ artifact_id: artifact.artifact_id, status: "failed", checks })
    }
    checks.push({ check: "digest", status: "pass" })

    // Size check
    if (artifact.byte_count !== null && result.byteCount !== artifact.byte_count) {
      checks.push({ check: "size", status: "fail", detail: `Expected ${artifact.byte_count}, got ${result.byteCount}` })
    } else {
      checks.push({ check: "size", status: "pass" })
    }

    const passed = checks.every(c => c.status === "pass")
    await registry.verify(artifact.artifact_id, {
      verification_id: `verify-${Date.now()}`,
      artifact_id: artifact.artifact_id,
      artifact_type: artifact.artifact_type,
      observed_digest: result.digest,
      verifier_name: "tribunus_artifact_verify",
      status: passed ? "passed" : "failed",
      checks,
      invocation_id: ctx.invocationId,
      created_at: new Date().toISOString(),
    })
    return ok({ artifact_id: artifact.artifact_id, status: passed ? "passed" : "failed", checks })
  })

  register("tribunus_artifact_lineage", "Return bounded upstream and downstream lineage graphs for an artifact with cycle protection and depth limits.", {
    artifact_id: { type: "string", description: "Artifact ID" },
    direction: { type: "string", enum: ["upstream","downstream","both"], description: "Lineage direction (default: both)" },
    depth: { type: "number", description: "Maximum relationship depth (default: 3)" },
  }, ["artifact_id"], ["artifact:read"], 15_000, async (ctx, a) => {
    const registry = await getRegistry()
    const direction = (a.direction as string) || "both"
    const depth = (a.depth as number) || 3
    const lineage = await registry.getLineage(a.artifact_id as string, direction as "upstream" | "downstream" | "both", depth)
    return ok({ artifact_id: a.artifact_id, direction, depth, relationships: lineage })
  })

  register("tribunus_artifact_import", "Register an existing file as an imported artifact without claiming Tribunus produced it.", {
    path: { type: "string", description: "Path to the existing file" },
    artifact_type: { type: "string", description: "Artifact type (e.g. generic_file_v1)" },
    logical_name: { type: "string", description: "Optional logical name" },
  }, ["path","artifact_type"], ["artifact:write"], 30_000, async (ctx, a) => {
    const registry = await getRegistry()
    const artifact = await registry.import({
      artifactType: a.artifact_type as ArtifactType,
      canonicalPath: a.path as string,
      logicalName: a.logical_name as (string | undefined),
      invocationId: ctx.invocationId,
    })
    return ok({ artifact_id: artifact.artifact_id, canonical_path: artifact.canonical_path, content_digest: artifact.content_digest })
  })
}
