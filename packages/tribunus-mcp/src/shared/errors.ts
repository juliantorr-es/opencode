export type ErrorCategory =
  | "invalid_arguments"
  | "capability_denied"
  | "path_denied"
  | "resource_limit"
  | "dependency_unavailable"
  | "timeout"
  | "cancelled"
  | "transient_network"
  | "external_tool_failure"
  | "integrity_failure"
  | "conflict"
  | "not_found"
  | "unsupported"
  | "internal_error"

export class ToolError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "ToolError"
  }
}
