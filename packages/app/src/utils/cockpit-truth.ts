import type { ArtifactRuntimeKind, ArtifactWorkspaceMode } from "@/context/artifact"
import type { LifecycleState } from "@/context/lifecycle"
import type { TerminalRuntimeKind } from "@/utils/terminal-runtime"
import { formatLifecycleStateLabel, isHighSignalLifecycleState } from "@/utils/runtime-lifecycle"

export type SessionRecoveryState =
  | "coordination_unavailable"
  | "coordination_rebuilding"
  | "coordination_recovered"
  | "coordination_degraded"
  | "coordination_refused"

export type SessionStatusLike = { type: string } | undefined
export type SessionRecoveryStatus = { type: SessionRecoveryState }

const sessionRecoveryLabels: Record<SessionRecoveryState, string> = {
  coordination_unavailable: "Coordination unavailable",
  coordination_rebuilding: "Coordination rebuilding",
  coordination_recovered: "Coordination recovered",
  coordination_degraded: "Coordination degraded",
  coordination_refused: "Coordination refused",
}

const sessionRecoveryStates = Object.keys(sessionRecoveryLabels) as SessionRecoveryState[]

const terminalRuntimeLabels: Record<TerminalRuntimeKind, string> = {
  "native-pty": "Native PTY",
  webcontainer: "WebContainer",
  wasm: "WASM",
  remote: "Remote",
  unavailable: "Unknown",
}

const artifactRuntimeLabels: Record<ArtifactRuntimeKind, string> = {
  "native-pty": "Native PTY",
  webcontainer: "WebContainer",
  remote: "Remote",
  unknown: "Unknown",
}

const workspaceModeLabels: Record<ArtifactWorkspaceMode, string> = {
  local: "Local workspace",
  snapshot: "Snapshot workspace",
  synced: "Synced workspace",
  virtual_fs_sandbox: "Virtual FS sandbox",
  unknown: "Unknown",
}

export const formatPlatformMode = (value: string | undefined) => {
  if (value === "desktop") return "Desktop"
  if (value === "web") return "Web"
  return "Unknown"
}

export const formatTerminalRuntimeKind = (value: TerminalRuntimeKind | undefined) => {
  if (!value) return "Unknown"
  return terminalRuntimeLabels[value]
}

export const formatArtifactRuntimeKind = (value: ArtifactRuntimeKind | undefined) => {
  if (!value) return "Unknown"
  return artifactRuntimeLabels[value]
}

export const formatWorkspaceMode = (value: ArtifactWorkspaceMode | undefined) => {
  if (!value) return "Unknown"
  return workspaceModeLabels[value]
}

export const formatWorkspaceTruth = (value: boolean | undefined) => {
  if (value === true) return "Real Workspace"
  if (value === false) return "Sandboxed"
  return "Unknown"
}

export const formatArtifactCapability = (value: boolean) => {
  return value ? "Available" : "Unavailable"
}

export function formatSessionRecoveryStatusLabel(value: SessionRecoveryState) {
  return sessionRecoveryLabels[value]
}

export function isSessionRecoveryStatus(value: SessionStatusLike): value is SessionRecoveryStatus {
  if (!value) return false
  return sessionRecoveryStates.includes(value.type as SessionRecoveryState)
}

export function isSessionRecoveryMutationBlocked(value: SessionStatusLike) {
  if (!isSessionRecoveryStatus(value)) return false
  return value.type !== "coordination_recovered"
}

export function formatSessionChromeStatusLabel(input: {
  sessionStatus?: SessionStatusLike
  lifecycleState: LifecycleState
  fallbackLabel: string
}) {
  if (isSessionRecoveryStatus(input.sessionStatus)) {
    return formatSessionRecoveryStatusLabel(input.sessionStatus.type)
  }
  if (isHighSignalLifecycleState(input.lifecycleState)) {
    return `Lifecycle: ${formatLifecycleStateLabel(input.lifecycleState)}`
  }
  return input.fallbackLabel
}

export { formatLifecycleStateLabel, isHighSignalLifecycleState }
