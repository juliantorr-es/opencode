import { 
  type ArtifactStatus, 
  type ArtifactType, 
  type ArtifactContextType,
  type ArtifactRuntimeKind,
  type ArtifactWorkspaceMode,
  type ProducerTruth,
  type CommandArtifactMetadata
} from "./artifact"

export type ArtifactEventKind =
  | "artifact.created"
  | "artifact.updated"
  | "artifact.completed"
  | "artifact.failed"
  | "artifact.unavailable"

export interface ArtifactEventV0 {
  schema: "tribunus.artifact_event.v0"
  eventID: string
  kind: ArtifactEventKind
  sessionID: string
  artifactID: string
  timestamp: number

  // Payload
  type?: ArtifactType
  status?: ArtifactStatus
  title?: string

  // Producer Truth
  producer?: ProducerTruth
  runtime?: ArtifactRuntimeKind
  workspaceMode?: ArtifactWorkspaceMode
  affectsRealWorkspace?: boolean

  // References
  source?: string
  contentReference?: string
  inlineContent?: string
  errorReason?: string
  lifecycleRelation?: string

  commandMetadata?: CommandArtifactMetadata
}

export function applyArtifactEventV0(event: ArtifactEventV0, context: ArtifactContextType) {
  if (event.schema !== "tribunus.artifact_event.v0") {
    console.warn(`[ArtifactEventV0] Ignoring unknown schema: ${event.schema as string}`)
    return
  }

  const existing = context.getArtifact(event.artifactID)

  if (event.kind === "artifact.created") {
    if (existing) {
      console.warn(`[ArtifactEventV0] Ignoring create for existing artifact: ${event.artifactID}`)
      return
    }
    context.addArtifact({
      id: event.artifactID,
      sessionID: event.sessionID,
      type: event.type ?? "text",
      title: event.title ?? "Untitled Artifact",
      status: event.status ?? "generating",
      content: event.inlineContent,
      reason: event.errorReason,
      timestamp: event.timestamp,

      producer: event.producer,
      runtime: event.runtime,
      workspaceMode: event.workspaceMode,
      affectsRealWorkspace: event.affectsRealWorkspace,
      source: event.source,
      contentReference: event.contentReference,
      lifecycleRelation: event.lifecycleRelation,
      commandMetadata: event.commandMetadata,
    })
    return
  }

  // Handle missing-prior updates: act as "create" if it doesn't exist.
  if (!existing) {
    console.warn(`[ArtifactEventV0] Implicitly creating missing artifact from update: ${event.artifactID}`)
    context.addArtifact({
      id: event.artifactID,
      sessionID: event.sessionID,
      type: event.type ?? "text",
      title: event.title ?? "Untitled Artifact",
      status: event.status ?? deriveStatusFromKind(event.kind),
      content: event.inlineContent,
      reason: event.errorReason,
      timestamp: event.timestamp,

      producer: event.producer,
      runtime: event.runtime,
      workspaceMode: event.workspaceMode,
      affectsRealWorkspace: event.affectsRealWorkspace,
      source: event.source,
      contentReference: event.contentReference,
      lifecycleRelation: event.lifecycleRelation,
      commandMetadata: event.commandMetadata,
    })
    return
  }

  // Update existing
  const updates: Partial<Parameters<ArtifactContextType["updateArtifact"]>[1]> = {
    timestamp: event.timestamp,
  }

  if (event.status) updates.status = event.status
  else if (event.kind !== "artifact.updated") {
    updates.status = deriveStatusFromKind(event.kind)
  }

  if (event.type !== undefined) updates.type = event.type
  if (event.title !== undefined) updates.title = event.title
  if (event.inlineContent !== undefined) updates.content = event.inlineContent
  if (event.errorReason !== undefined) updates.reason = event.errorReason

  if (event.producer !== undefined) updates.producer = event.producer
  if (event.runtime !== undefined) updates.runtime = event.runtime
  if (event.workspaceMode !== undefined) updates.workspaceMode = event.workspaceMode
  if (event.affectsRealWorkspace !== undefined) updates.affectsRealWorkspace = event.affectsRealWorkspace
  if (event.source !== undefined) updates.source = event.source
  if (event.contentReference !== undefined) updates.contentReference = event.contentReference
  if (event.lifecycleRelation !== undefined) updates.lifecycleRelation = event.lifecycleRelation
  if (event.commandMetadata !== undefined) updates.commandMetadata = event.commandMetadata

  context.updateArtifact(event.artifactID, updates)
}

function deriveStatusFromKind(kind: ArtifactEventKind): ArtifactStatus {
  switch (kind) {
    case "artifact.created": return "generating"
    case "artifact.completed": return "available"
    case "artifact.failed": return "error"
    case "artifact.unavailable": return "unavailable"
    case "artifact.updated": return "generating" // Best effort fallback
  }
}
