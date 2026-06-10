export interface ResourceBudget {
  maxRows: number
  maxBytes: number
  maxDurationMs: number
}

export const DEFAULT_BUDGET: ResourceBudget = {
  maxRows: 1000,
  maxBytes: 1024 * 1024, // 1 MiB
  maxDurationMs: 300_000, // 5 min
}

export function clampBudget(requested: Partial<ResourceBudget>, caps: ResourceBudget): ResourceBudget {
  return {
    maxRows: Math.min(requested.maxRows ?? caps.maxRows, caps.maxRows),
    maxBytes: Math.min(requested.maxBytes ?? caps.maxBytes, caps.maxBytes),
    maxDurationMs: Math.min(requested.maxDurationMs ?? caps.maxDurationMs, caps.maxDurationMs),
  }
}
