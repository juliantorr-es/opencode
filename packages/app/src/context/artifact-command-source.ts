import type { ArtifactRuntimeKind, ArtifactWorkspaceMode } from "./artifact"
import type { ArtifactEventV0 } from "./artifact-event"

export interface CommandResultSourceV0 {
  schema: "tribunus.command_result_source.v0"
  commandID: string
  sessionID: string
  command: string
  cwd?: string
  exitCode?: number
  signal?: string
  startedAt: number
  completedAt?: number
  stdout?: string
  stderr?: string
  runtime: ArtifactRuntimeKind
  workspaceMode: ArtifactWorkspaceMode
  affectsRealWorkspace: boolean
  source?: {
    terminalID?: string
    toolCallID?: string
    messageID?: string
    correlationID?: string
  }
}

export function commandResultToArtifactEventsV0(input: CommandResultSourceV0): ArtifactEventV0[] {
  if (input.schema !== "tribunus.command_result_source.v0") {
    console.warn(`[CommandSourceV0] Ignoring unknown schema: ${(input as any).schema}`)
    return []
  }

  // We only map completed commands in v0
  if (input.completedAt === undefined) {
    return []
  }

  const isSuccess = input.exitCode === 0 && !input.signal
  const artifactID = `command_result:${input.sessionID}:${input.commandID}`
  
  let inlineContent = `> ${input.command}`
  if (input.cwd) inlineContent += `\n[cwd: ${input.cwd}]`
  
  if (input.stdout) inlineContent += `\n\n${input.stdout}`
  if (input.stderr) inlineContent += `\n\n${input.stderr}`

  let errorReason: string | undefined
  if (!isSuccess) {
    if (input.signal) {
      errorReason = `Killed by signal ${input.signal}`
    } else if (input.exitCode !== undefined) {
      errorReason = `Exited with code ${input.exitCode}`
    } else {
      errorReason = "Command failed"
    }
  }

  const event: ArtifactEventV0 = {
    schema: "tribunus.artifact_event.v0",
    eventID: `artifact_event:${artifactID}:${isSuccess ? "completed" : "failed"}`,
    kind: isSuccess ? "artifact.completed" : "artifact.failed",
    sessionID: input.sessionID,
    artifactID,
    timestamp: input.completedAt,
    
    type: "command_result",
    status: isSuccess ? "available" : "error",
    title: isSuccess ? `Command: ${input.command}` : `Command failed: ${input.command}`,
    
    producer: "terminal",
    runtime: input.runtime,
    workspaceMode: input.workspaceMode,
    affectsRealWorkspace: input.affectsRealWorkspace,
    
    inlineContent,
    errorReason,
    source: input.commandID,
    lifecycleRelation: isSuccess ? "completed" : "executing",
    
    commandMetadata: {
      command: input.command,
      cwd: input.cwd,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      exitCode: input.exitCode,
      signal: input.signal,
      stdoutBytes: input.stdout ? new Blob([input.stdout]).size : undefined,
      stderrBytes: input.stderr ? new Blob([input.stderr]).size : undefined,
      stdout: input.stdout,
      stderr: input.stderr
    }
  }

  return [event]
}
