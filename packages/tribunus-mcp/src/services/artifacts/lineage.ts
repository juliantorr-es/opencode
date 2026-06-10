/**
 * Artifact Lineage — directed relationships between artifacts.
 */

import type { ArtifactRelationship, RelationshipKind } from "./types.js"
import type { PgliteDb } from "../../governance/store.js"
import { ArtifactRegistryService } from "./registry.js"

export async function addLineage(
  registry: ArtifactRegistryService,
  sourceId: string,
  destId: string,
  kind: RelationshipKind,
  invocationId?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  // Validate both artifacts exist
  await registry.get(sourceId)
  await registry.get(destId)

  // Reject derivation cycles for containment/derivation relationships
  if (kind === "derived_from" || kind === "compiled_from" || kind === "contains") {
    await checkNoCycle(registry, sourceId, destId)
  }

  await registry.addRelationship(sourceId, destId, kind, invocationId, metadata)
}

async function checkNoCycle(
  registry: ArtifactRegistryService,
  sourceId: string,
  destId: string,
): Promise<void> {
  // Check if destId already appears in sourceId's upstream lineage
  const upstream = await registry.getLineage(sourceId, "upstream", 10)
  for (const rel of upstream) {
    if (rel.source_artifact_id === destId || rel.destination_artifact_id === destId) {
      throw new Error(`Cycle detected: ${destId} already appears in ${sourceId}'s upstream lineage`)
    }
  }
}
