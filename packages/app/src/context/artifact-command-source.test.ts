import { describe, expect, test } from "bun:test"
import { commandResultToArtifactEventsV0, type CommandResultSourceV0 } from "./artifact-command-source"
import { applyArtifactEventV0 } from "./artifact-event"
import type { Artifact, ArtifactContextType } from "./artifact"

describe("commandResultToArtifactEventsV0", () => {
  const createMockContext = () => {
    const store: Record<string, Artifact> = {}
    return {
      getArtifact: (id: string) => store[id],
      addArtifact: (artifact: Artifact) => { store[artifact.id] = artifact },
      updateArtifact: (id: string, updates: Partial<Artifact>) => {
        if (store[id]) {
          Object.assign(store[id], updates)
        }
      },
      _store: store,
    } as unknown as ArtifactContextType & { _store: Record<string, Artifact> }
  }

  test("ignores incomplete commands", () => {
    const input: CommandResultSourceV0 = {
      schema: "tribunus.command_result_source.v0",
      commandID: "cmd1",
      sessionID: "sess1",
      command: "echo hello",
      startedAt: 100,
      runtime: "native-pty",
      workspaceMode: "local",
      affectsRealWorkspace: false
    }

    const events = commandResultToArtifactEventsV0(input)
    expect(events.length).toBe(0)
  })

  test("maps successful native command to completed event", () => {
    const input: CommandResultSourceV0 = {
      schema: "tribunus.command_result_source.v0",
      commandID: "cmd2",
      sessionID: "sess1",
      command: "echo hello",
      cwd: "/test",
      exitCode: 0,
      startedAt: 100,
      completedAt: 200,
      stdout: "hello",
      runtime: "native-pty",
      workspaceMode: "local",
      affectsRealWorkspace: true
    }

    const events = commandResultToArtifactEventsV0(input)
    expect(events.length).toBe(1)
    
    const event = events[0]
    expect(event.kind).toBe("artifact.completed")
    expect(event.artifactID).toBe("command_result:sess1:cmd2")
    expect(event.type).toBe("command_result")
    expect(event.eventID).toBe("artifact_event:command_result:sess1:cmd2:completed")
    expect(event.title).toBe("Command: echo hello")
    expect(event.status).toBe("available")
    expect(event.producer).toBe("terminal")
    expect(event.runtime).toBe("native-pty")
    expect(event.workspaceMode).toBe("local")
    expect(event.affectsRealWorkspace).toBe(true)
    expect(event.commandMetadata?.command).toBe("echo hello")
    expect(event.commandMetadata?.cwd).toBe("/test")
    expect(event.commandMetadata?.exitCode).toBe(0)
    expect(event.commandMetadata?.stdout).toBe("hello")

    // Verify application
    const ctx = createMockContext()
    applyArtifactEventV0(event, ctx)
    const a = ctx.getArtifact(event.artifactID)
    expect(a).toBeDefined()
    expect(a?.status).toBe("available")
    expect(a?.type).toBe("command_result")
    expect(a?.commandMetadata?.command).toBe("echo hello")
  })

  test("maps failed command to failed event with error reason", () => {
    const input: CommandResultSourceV0 = {
      schema: "tribunus.command_result_source.v0",
      commandID: "cmd3",
      sessionID: "sess1",
      command: "bun test",
      exitCode: 1,
      startedAt: 100,
      completedAt: 200,
      stderr: "Test failed",
      runtime: "webcontainer",
      workspaceMode: "virtual_fs_sandbox",
      affectsRealWorkspace: false
    }

    const events = commandResultToArtifactEventsV0(input)
    expect(events.length).toBe(1)
    
    const event = events[0]
    expect(event.kind).toBe("artifact.failed")
    expect(event.type).toBe("command_result")
    expect(event.status).toBe("error")
    expect(event.title).toBe("Command failed: bun test")
    expect(event.errorReason).toBe("Exited with code 1")
    expect(event.runtime).toBe("webcontainer")
    expect(event.workspaceMode).toBe("virtual_fs_sandbox")
    expect(event.affectsRealWorkspace).toBe(false)
    expect(event.commandMetadata?.exitCode).toBe(1)
    expect(event.commandMetadata?.stderr).toBe("Test failed")

    // Verify application
    const ctx = createMockContext()
    applyArtifactEventV0(event, ctx)
    const a = ctx.getArtifact(event.artifactID)
    expect(a).toBeDefined()
    expect(a?.status).toBe("error")
    expect(a?.reason).toBe("Exited with code 1")
    expect(a?.commandMetadata?.exitCode).toBe(1)
  })

  test("maps command killed by signal", () => {
    const input: CommandResultSourceV0 = {
      schema: "tribunus.command_result_source.v0",
      commandID: "cmd4",
      sessionID: "sess1",
      command: "sleep 10",
      signal: "SIGTERM",
      startedAt: 100,
      completedAt: 200,
      runtime: "native-pty",
      workspaceMode: "local",
      affectsRealWorkspace: false
    }

    const events = commandResultToArtifactEventsV0(input)
    expect(events.length).toBe(1)
    
    const event = events[0]
    expect(event.kind).toBe("artifact.failed")
    expect(event.errorReason).toBe("Killed by signal SIGTERM")
  })
})
