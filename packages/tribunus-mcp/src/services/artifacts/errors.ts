export class ArtifactError extends Error {
  constructor(
    message: string,
    public readonly artifactId?: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "ArtifactError"
  }
}

export class ArtifactNotFoundError extends ArtifactError {
  constructor(artifactId: string) {
    super(`Artifact ${artifactId} not found`, artifactId)
    this.name = "ArtifactNotFoundError"
  }
}

export class ArtifactStateError extends ArtifactError {
  constructor(artifactId: string, currentState: string, attemptedTransition: string) {
    super(`Cannot transition artifact ${artifactId} from ${currentState} to ${attemptedTransition}`, artifactId, { currentState, attemptedTransition })
    this.name = "ArtifactStateError"
  }
}

export class ArtifactConflictError extends ArtifactError {
  constructor(path: string, existingId: string) {
    super(`Artifact path ${path} already reserved by ${existingId}`, undefined, { path, existingId })
    this.name = "ArtifactConflictError"
  }
}

export class ArtifactDigestMismatchError extends ArtifactError {
  constructor(artifactId: string, expected: string, actual: string) {
    super(`Digest mismatch for ${artifactId}: expected ${expected}, got ${actual}`, artifactId, { expected, actual })
    this.name = "ArtifactDigestMismatchError"
  }
}

export class ArtifactPathDeniedError extends ArtifactError {
  constructor(path: string, reason: string) {
    super(`Artifact path denied: ${path} — ${reason}`, undefined, { path, reason })
    this.name = "ArtifactPathDeniedError"
  }
}
