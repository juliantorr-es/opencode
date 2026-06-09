import type { IpcErrorMapping } from "./init-errors"
// Reuse the same IpcErrorMapping interface pattern

export interface StoreIpcErrorMapping {
  readonly code: "invalid_request" | "permission_denied" | "unavailable" | "internal"
  readonly message: string
  readonly recoverability: "recoverable" | "non-recoverable" | "retryable"
}

export abstract class StoreError extends Error {
  abstract readonly ipc: StoreIpcErrorMapping
  constructor(message: string) { super(message); this.name = "StoreError" }
}

export class ReservedNamespaceError extends StoreError {
  readonly ipc: StoreIpcErrorMapping
  constructor(namespace: string) {
    super(`Access denied: '${namespace}' is a reserved store namespace`)
    this.name = "ReservedNamespaceError"
    this.ipc = { code: "permission_denied", message: "Reserved store namespace", recoverability: "non-recoverable" }
  }
}

export class InvalidNamespaceError extends StoreError {
  readonly ipc: StoreIpcErrorMapping = { code: "invalid_request", message: "Invalid store namespace", recoverability: "non-recoverable" }
  constructor(namespace: string) { super(`Invalid namespace: ${namespace}`); this.name = "InvalidNamespaceError" }
}

export class InvalidKeyError extends StoreError {
  readonly ipc: StoreIpcErrorMapping = { code: "invalid_request", message: "Invalid store key", recoverability: "non-recoverable" }
  constructor(key: string) { super(`Invalid key: ${key}`); this.name = "InvalidKeyError" }
}

export class StorePersistenceError extends StoreError {
  readonly ipc: StoreIpcErrorMapping = { code: "internal", message: "Store persistence failure", recoverability: "non-recoverable" }
  constructor() { super("Store persistence failure"); this.name = "StorePersistenceError" }
}

export class StoreUnavailableError extends StoreError {
  readonly ipc: StoreIpcErrorMapping = { code: "unavailable", message: "Store is not available", recoverability: "recoverable" }
  constructor() { super("Store unavailable"); this.name = "StoreUnavailableError" }
}

export function mapStoreError(error: unknown): StoreIpcErrorMapping | null {
  if (error instanceof StoreError) return error.ipc
  return null
}
