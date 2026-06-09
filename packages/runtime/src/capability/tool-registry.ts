import { Context, Effect, Layer } from "effect"
import * as Schema from "effect/Schema"
import type { AuthorityGrant, CapabilityAuthorityResult } from "./authority"
import { evaluateCapabilityAuthority } from "./authority"
import { CapabilityMetadata } from "./metadata"
import type { ApprovalLevel, PrivilegeBoundary } from "./metadata"
import type { CoordinationRecoveryState } from "../coordination/recovery"

export const SourceType = Schema.Literals(["native", "mcp", "shell", "system", "agent", "workflow"])
export type SourceType = typeof SourceType.Type

export const ImportStatus = Schema.Literals(["trusted", "conservative", "incomplete", "rejected"])
export type ImportStatus = typeof ImportStatus.Type

export const McpProviderTrustLevel = Schema.Literals(["trusted", "conservative", "disabled"])
export type McpProviderTrustLevel = typeof McpProviderTrustLevel.Type

export const CapabilityToolDefinition = Schema.Struct({
  toolID: Schema.String,
  capabilityID: Schema.String,
  sourceType: SourceType,
  providerID: Schema.String,
  displayName: Schema.String,
  description: Schema.String,
  metadata: CapabilityMetadata,
  inputSchema: Schema.optional(Schema.Any),
  outputSchema: Schema.optional(Schema.Any),
  receiptBehavior: Schema.Literals(["authority-receipt", "none"]),
  importStatus: ImportStatus,
})
export type CapabilityToolDefinition = typeof CapabilityToolDefinition.Type

export type CapabilityToolCheckContext = {
  sessionID: string
  recoveryState: CoordinationRecoveryState
  grantedBoundaries: readonly PrivilegeBoundary[]
  approvalLevelGranted: ApprovalLevel
  authorityGrants?: readonly AuthorityGrant[]
}

export const CapabilityToolRegistryErrorReason = Schema.Literals([
  "invalid_definition",
  "rejected_import",
  "duplicate_tool_id",
  "tool_not_found",
  "unsafe_missing_metadata",
])
export type CapabilityToolRegistryErrorReason = typeof CapabilityToolRegistryErrorReason.Type

export class CapabilityToolRegistryError extends Schema.TaggedErrorClass<CapabilityToolRegistryError>()(
  "CapabilityToolRegistryError",
  {
    reason: CapabilityToolRegistryErrorReason,
    message: Schema.String,
  }
) {}

export class CapabilityToolRegistry extends Context.Service<
  CapabilityToolRegistry,
  {
    readonly registerCapabilityTool: (
      definition: CapabilityToolDefinition,
    ) => Effect.Effect<void, CapabilityToolRegistryError>
    readonly resolveCapabilityTool: (
      toolID: string,
    ) => Effect.Effect<CapabilityToolDefinition, CapabilityToolRegistryError>
    readonly evaluateToolCapability: (
      toolID: string,
      context: CapabilityToolCheckContext,
    ) => Effect.Effect<CapabilityAuthorityResult, CapabilityToolRegistryError>
    readonly resetCapabilityToolRegistry: () => Effect.Effect<void, never>
    readonly removeCapabilityToolsByProvider: (providerID: string) => Effect.Effect<void, never>
    readonly replaceCapabilityToolsForProvider: (
      providerID: string,
      definitions: readonly CapabilityToolDefinition[],
    ) => Effect.Effect<void, never>
    readonly register: (definition: CapabilityToolDefinition) => Effect.Effect<void, CapabilityToolRegistryError>
    readonly resolve: (toolID: string) => Effect.Effect<CapabilityToolDefinition, CapabilityToolRegistryError>
    readonly evaluate: (
      toolID: string,
      context: CapabilityToolCheckContext,
    ) => Effect.Effect<CapabilityAuthorityResult, CapabilityToolRegistryError>
  }
>()("@tribunus/CapabilityToolRegistry") {}

export const liveRegistryLayer = Layer.effect(
  CapabilityToolRegistry,
  Effect.gen(function* () {
    const map = new Map<string, CapabilityToolDefinition>()
    const providerIndex = new Map<string, Set<string>>()

    const registerCapabilityTool = (definition: CapabilityToolDefinition) =>
      Effect.sync(() => {
        if (!definition.toolID) {
          throw new CapabilityToolRegistryError({
            reason: "invalid_definition",
            message: "Missing toolID in capability tool definition",
          })
        }
        if (definition.importStatus === "rejected") {
          throw new CapabilityToolRegistryError({
            reason: "rejected_import",
            message: `Tool ${definition.toolID} was rejected during import`,
          })
        }
        if (map.has(definition.toolID)) {
          throw new CapabilityToolRegistryError({
            reason: "duplicate_tool_id",
            message: `Tool ID ${definition.toolID} already registered`,
          })
        }
        map.set(definition.toolID, definition)
        const providerSet = providerIndex.get(definition.providerID) ?? new Set<string>()
        providerSet.add(definition.toolID)
        providerIndex.set(definition.providerID, providerSet)
      })

    const removeCapabilityToolsByProvider = (providerID: string) =>
      Effect.sync(() => {
        const toolIDs = providerIndex.get(providerID)
        if (!toolIDs) return
        for (const toolID of toolIDs) {
          map.delete(toolID)
        }
        providerIndex.delete(providerID)
      })

    const replaceCapabilityToolsForProvider = (providerID: string, definitions: readonly CapabilityToolDefinition[]) =>
      Effect.sync(() => {
        const nextToolIDs = new Set<string>()
        for (const definition of definitions) {
          if (definition.providerID !== providerID) {
            throw new Error(`Tool ${definition.toolID} does not belong to provider ${providerID}`)
          }
          nextToolIDs.add(definition.toolID)
        }

        const oldToolIDs = providerIndex.get(providerID)
        if (oldToolIDs) {
          for (const toolID of oldToolIDs) {
            if (!nextToolIDs.has(toolID)) {
              map.delete(toolID)
            }
          }
        }

        providerIndex.set(providerID, new Set())
        for (const definition of definitions) {
          if (map.has(definition.toolID) && map.get(definition.toolID)?.providerID !== providerID) {
            throw new Error(`Tool ID ${definition.toolID} already registered by another provider`)
          }
          map.set(definition.toolID, definition)
          providerIndex.get(providerID)!.add(definition.toolID)
        }
      })

    const resolveCapabilityTool = (toolID: string) =>
      Effect.gen(function* () {
        const def = map.get(toolID)
        if (!def) {
          return yield* Effect.fail(
            new CapabilityToolRegistryError({
              reason: "tool_not_found",
              message: `Tool ${toolID} not found in capability tool registry`,
            })
          )
        }
        return def
      })

    const evaluateToolCapability = (
      toolID: string,
      context: CapabilityToolCheckContext,
    ) =>
      Effect.gen(function* () {
        const def = yield* resolveCapabilityTool(toolID)
        return evaluateCapabilityAuthority({
          metadata: def.metadata,
          recoveryState: context.recoveryState,
          grantedBoundaries: context.grantedBoundaries,
          approvalLevelGranted: context.approvalLevelGranted,
          availableAuthorityGrants: context.authorityGrants,
        })
      })

    return {
      registerCapabilityTool,
      resolveCapabilityTool,
      evaluateToolCapability,
      resetCapabilityToolRegistry: () =>
        Effect.sync(() => {
          map.clear()
          providerIndex.clear()
        }),
      removeCapabilityToolsByProvider,
      replaceCapabilityToolsForProvider,
      register: registerCapabilityTool,
      resolve: resolveCapabilityTool,
      evaluate: evaluateToolCapability,
    }
  })
)

function makeConservativeMcpMetadata(toolID: string, description: string): CapabilityMetadata {
  return {
    id: `tool.mcp.${toolID}`,
    description,
    privilegeBoundaries: ["unknown"],
    mutationClass: "side-effect",
    determinismClass: "external",
    approvalLevel: "human",
    blockedRecoveryStates: [
      "coordination_unavailable",
      "coordination_rebuilding",
      "coordination_degraded",
      "coordination_refused",
    ],
  }
}

function classifyMcpImportStatus(
  trustLevel: McpProviderTrustLevel,
  customMetadata?: Partial<CapabilityMetadata>,
): ImportStatus {
  if (trustLevel === "conservative") return "conservative"
  if (customMetadata === undefined || Object.keys(customMetadata).length === 0) {
    return "conservative"
  }

  const hasGovernanceMetadata =
    customMetadata.privilegeBoundaries !== undefined &&
    customMetadata.mutationClass !== undefined &&
    customMetadata.determinismClass !== undefined &&
    customMetadata.approvalLevel !== undefined

  return hasGovernanceMetadata ? "trusted" : "incomplete"
}

export function normalizeMcpToolDefinition(
  serverID: string,
  rawMcpTool: { name: string; description?: string; inputSchema?: any; outputSchema?: any },
  trustLevel: McpProviderTrustLevel = "conservative",
  customMetadata?: Partial<CapabilityMetadata>
): CapabilityToolDefinition {
  const toolID = `${serverID}.${rawMcpTool.name}`
  const capabilityID = `tool.mcp.${toolID}`
  const metadata = trustLevel === "conservative" || customMetadata === undefined
    ? makeConservativeMcpMetadata(toolID, rawMcpTool.description ?? `MCP tool ${toolID}`)
    : {
        ...makeConservativeMcpMetadata(toolID, customMetadata.description ?? rawMcpTool.description ?? `MCP tool ${toolID}`),
        ...customMetadata,
        id: capabilityID,
        description: customMetadata.description ?? rawMcpTool.description ?? `MCP tool ${toolID}`,
      }

  const importStatus = classifyMcpImportStatus(trustLevel, customMetadata)

  return {
    toolID,
    capabilityID,
    sourceType: "mcp",
    providerID: serverID,
    displayName: rawMcpTool.name,
    description: rawMcpTool.description || customMetadata?.description || "",
    metadata,
    inputSchema: rawMcpTool.inputSchema,
    outputSchema: rawMcpTool.outputSchema,
    receiptBehavior: "authority-receipt",
    importStatus,
  }
}
