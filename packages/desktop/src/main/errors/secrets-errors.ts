export interface SecretIpcErrorMapping {
  readonly code: "invalid_request" | "permission_denied" | "not_found" | "unavailable" | "internal"
  readonly message: string
  readonly recoverability: "recoverable" | "non-recoverable" | "retryable"
}

export abstract class SecretError extends Error {
  abstract readonly ipc: SecretIpcErrorMapping
  constructor(message: string) { super(message); this.name = "SecretError" }
}

export class SecretEncryptionUnavailableError extends SecretError {
  readonly ipc: SecretIpcErrorMapping = { code: "unavailable", message: "Encryption is not available on this system", recoverability: "non-recoverable" }
  constructor() { super("Encryption unavailable"); this.name = "SecretEncryptionUnavailableError" }
}

export class SecretNotFoundError extends SecretError {
  readonly ipc: SecretIpcErrorMapping = { code: "not_found", message: "Secret not found", recoverability: "non-recoverable" }
  constructor(ref: string) { super(`Secret not found: ${ref}`); this.name = "SecretNotFoundError" }
}

export class SecretInvalidReferenceError extends SecretError {
  readonly ipc: SecretIpcErrorMapping = { code: "invalid_request", message: "Invalid secret reference", recoverability: "non-recoverable" }
  constructor() { super("Invalid secret reference"); this.name = "SecretInvalidReferenceError" }
}

export class SecretCorruptIndexError extends SecretError {
  readonly ipc: SecretIpcErrorMapping = { code: "internal", message: "Secret index is corrupted", recoverability: "non-recoverable" }
  constructor() { super("Corrupt secret index"); this.name = "SecretCorruptIndexError" }
}

export class SecretDecryptionError extends SecretError {
  readonly ipc: SecretIpcErrorMapping = { code: "internal", message: "Failed to decrypt secret", recoverability: "non-recoverable" }
  constructor() { super("Decryption failed"); this.name = "SecretDecryptionError" }
}

export class SecretPersistenceError extends SecretError {
  readonly ipc: SecretIpcErrorMapping = { code: "internal", message: "Failed to persist secret", recoverability: "non-recoverable" }
  constructor() { super("Persistence failed"); this.name = "SecretPersistenceError" }
}

export function mapSecretError(error: unknown): SecretIpcErrorMapping | null {
  if (error instanceof SecretError) return error.ipc
  return null
}
