import type { IpcErrorCode } from "../../ipc/errors"

/** Maps a domain error to a public IPC error code. */
export interface IpcErrorMapping {
  readonly code: IpcErrorCode
  readonly message: string
  readonly recoverability: "recoverable" | "non-recoverable" | "retryable"
}

/** Base class for typed init/sidecar errors */
export abstract class InitError extends Error {
  abstract readonly ipc: IpcErrorMapping
  constructor(message: string) { super(message); this.name = "InitError" }
}

export class SidecarUnavailableError extends InitError {
  readonly ipc: IpcErrorMapping = { code: "unavailable", message: "Sidecar is not running", recoverability: "recoverable" }
  constructor() { super("Sidecar is not running"); this.name = "SidecarUnavailableError" }
}

export class SidecarTimeoutError extends InitError {
  readonly ipc: IpcErrorMapping
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`)
    this.name = "SidecarTimeoutError"
    this.ipc = { code: "timeout", message: `${operation} timed out`, recoverability: "retryable" }
  }
}

export class RestartInProgressError extends InitError {
  readonly ipc: IpcErrorMapping = { code: "conflict", message: "Sidecar restart already in progress", recoverability: "recoverable" }
  constructor() { super("Restart already in progress"); this.name = "RestartInProgressError" }
}

export class ProjectDirectoryNotFoundError extends InitError {
  readonly ipc: IpcErrorMapping
  constructor(dir: string) {
    super(`Directory not found: ${dir}`)
    this.name = "ProjectDirectoryNotFoundError"
    this.ipc = { code: "not_found", message: "Project directory not found", recoverability: "non-recoverable" }
  }
}

export class ProjectDirectoryInvalidError extends InitError {
  readonly ipc: IpcErrorMapping = { code: "invalid_request", message: "Invalid project directory", recoverability: "non-recoverable" }
  constructor() { super("Invalid project directory"); this.name = "ProjectDirectoryInvalidError" }
}

export class UpdaterUnavailableError extends InitError {
  readonly ipc: IpcErrorMapping = { code: "unavailable", message: "Auto-updater is not available", recoverability: "non-recoverable" }
  constructor() { super("Updater not available"); this.name = "UpdaterUnavailableError" }
}

export class UpdateCheckFailedError extends InitError {
  readonly ipc: IpcErrorMapping = { code: "unavailable", message: "Update check failed", recoverability: "retryable" }
  constructor(cause?: string) { super(`Update check failed${cause ? ": " + cause : ""}`); this.name = "UpdateCheckFailedError" }
}

export class DebugLogExportError extends InitError {
  readonly ipc: IpcErrorMapping = { code: "internal", message: "Failed to export debug logs", recoverability: "non-recoverable" }
  constructor() { super("Debug log export failed"); this.name = "DebugLogExportError" }
}

/** Maps any InitError to its IPC error mapping. Null for non-InitError values. */
export function mapInitError(error: unknown): IpcErrorMapping | null {
  if (error instanceof InitError) return error.ipc
  return null
}
