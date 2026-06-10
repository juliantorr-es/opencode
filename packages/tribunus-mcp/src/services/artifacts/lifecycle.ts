import { ArtifactStateError } from "./errors.js"
import type { ArtifactState } from "./types.js"
import { VALID_TRANSITIONS } from "./types.js"

export function validateTransition(artifactId: string, currentState: ArtifactState, target: ArtifactState): void {
  const allowed = VALID_TRANSITIONS[currentState]
  if (!allowed || !allowed.includes(target)) {
    throw new ArtifactStateError(artifactId, currentState, target)
  }
}
