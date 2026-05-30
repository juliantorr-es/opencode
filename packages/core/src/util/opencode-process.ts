import { sanitizeEnv } from "./env-blocklist"

export const OPENCODE_RUN_ID = "OPENCODE_RUN_ID"
export const OPENCODE_PROCESS_ROLE = "OPENCODE_PROCESS_ROLE"

export function ensureRunID() {
  return (process.env[OPENCODE_RUN_ID] ??= crypto.randomUUID())
}

export function ensureProcessRole(fallback: "main" | "worker") {
  return (process.env[OPENCODE_PROCESS_ROLE] ??= fallback)
}

export function ensureProcessMetadata(fallback: "main" | "worker") {
  return {
    runID: ensureRunID(),
    processRole: ensureProcessRole(fallback),
  }
}

export function sanitizedProcessEnv(overrides?: Record<string, string>) {
  const env = sanitizeEnv(process.env)
  return overrides ? Object.assign(env, overrides) : env
}
