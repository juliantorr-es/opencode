import { describe, expect, test } from "bun:test"
import { applyArtifactEventV0, type ArtifactEventV0 } from "./artifact-event"
import type { Artifact, ArtifactContextType } from "./artifact"

describe("applyArtifactEventV0", () => {
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

  test("creates a new artifact", () => {
    const ctx = createMockContext()
    const event: ArtifactEventV0 = {
      schema: "tribunus.artifact_event.v0",
      eventID: "evt1",
      kind: "artifact.created",
      sessionID: "s1",
      artifactID: "a1",
      timestamp: 100,
      type: "text",
      title: "My Artifact",
      producer: "system"
    }

    applyArtifactEventV0(event, ctx)

    const a = ctx.getArtifact("a1")
    expect(a).toBeDefined()
    expect(a?.status).toBe("generating") // derived
    expect(a?.title).toBe("My Artifact")
    expect(a?.producer).toBe("system")
  })

  test("updates an existing artifact", () => {
    const ctx = createMockContext()
    ctx._store["a1"] = {
      id: "a1", sessionID: "s1", type: "text", title: "My Artifact", status: "generating", timestamp: 100
    }

    const event: ArtifactEventV0 = {
      schema: "tribunus.artifact_event.v0",
      eventID: "evt2",
      kind: "artifact.updated",
      sessionID: "s1",
      artifactID: "a1",
      timestamp: 200,
      inlineContent: "Updated content",
      runtime: "native-pty"
    }

    applyArtifactEventV0(event, ctx)

    const a = ctx.getArtifact("a1")
    expect(a?.content).toBe("Updated content")
    expect(a?.runtime).toBe("native-pty")
    expect(a?.status).toBe("generating") // implicit from kind updated when status not set
    expect(a?.timestamp).toBe(200)
  })

  test("completes an existing artifact", () => {
    const ctx = createMockContext()
    ctx._store["a1"] = {
      id: "a1", sessionID: "s1", type: "text", title: "My Artifact", status: "generating", timestamp: 100
    }

    const event: ArtifactEventV0 = {
      schema: "tribunus.artifact_event.v0",
      eventID: "evt3",
      kind: "artifact.completed",
      sessionID: "s1",
      artifactID: "a1",
      timestamp: 300,
      inlineContent: "Final content"
    }

    applyArtifactEventV0(event, ctx)

    const a = ctx.getArtifact("a1")
    expect(a?.status).toBe("available")
    expect(a?.content).toBe("Final content")
  })

  test("fails an existing artifact", () => {
    const ctx = createMockContext()
    ctx._store["a1"] = {
      id: "a1", sessionID: "s1", type: "text", title: "My Artifact", status: "generating", timestamp: 100
    }

    const event: ArtifactEventV0 = {
      schema: "tribunus.artifact_event.v0",
      eventID: "evt4",
      kind: "artifact.failed",
      sessionID: "s1",
      artifactID: "a1",
      timestamp: 400,
      errorReason: "Failed to compile"
    }

    applyArtifactEventV0(event, ctx)

    const a = ctx.getArtifact("a1")
    expect(a?.status).toBe("error")
    expect(a?.reason).toBe("Failed to compile")
  })

  test("handles missing-prior updates by implicitly creating", () => {
    const ctx = createMockContext()

    const event: ArtifactEventV0 = {
      schema: "tribunus.artifact_event.v0",
      eventID: "evt5",
      kind: "artifact.updated",
      sessionID: "s1",
      artifactID: "missing_a",
      timestamp: 500,
      inlineContent: "Content for missing",
      producer: "playwright"
    }

    applyArtifactEventV0(event, ctx)

    const a = ctx.getArtifact("missing_a")
    expect(a).toBeDefined()
    expect(a?.content).toBe("Content for missing")
    expect(a?.status).toBe("generating")
    expect(a?.producer).toBe("playwright")
  })

  test("handles missing-prior completion by implicitly creating", () => {
    const ctx = createMockContext()

    const event: ArtifactEventV0 = {
      schema: "tribunus.artifact_event.v0",
      eventID: "evt6",
      kind: "artifact.completed",
      sessionID: "s1",
      artifactID: "missing_b",
      timestamp: 600,
      title: "Implicit Complete",
      inlineContent: "Done"
    }

    applyArtifactEventV0(event, ctx)

    const a = ctx.getArtifact("missing_b")
    expect(a).toBeDefined()
    expect(a?.title).toBe("Implicit Complete")
    expect(a?.status).toBe("available") // derived from completed
    expect(a?.content).toBe("Done")
  })

  test("marks unavailable", () => {
    const ctx = createMockContext()

    const event: ArtifactEventV0 = {
      schema: "tribunus.artifact_event.v0",
      eventID: "evt7",
      kind: "artifact.unavailable",
      sessionID: "s1",
      artifactID: "a2",
      timestamp: 700,
      errorReason: "Not found"
    }

    applyArtifactEventV0(event, ctx)

    const a = ctx.getArtifact("a2")
    expect(a?.status).toBe("unavailable")
    expect(a?.reason).toBe("Not found")
  })

  test("preserves workspaceMode on creation and updates", () => {
    const ctx = createMockContext()

    const event1: ArtifactEventV0 = {
      schema: "tribunus.artifact_event.v0",
      eventID: "evt8",
      kind: "artifact.created",
      sessionID: "s1",
      artifactID: "a3",
      timestamp: 800,
      workspaceMode: "virtual_fs_sandbox"
    }

    applyArtifactEventV0(event1, ctx)
    const a = ctx.getArtifact("a3")
    expect(a?.workspaceMode).toBe("virtual_fs_sandbox")

    const event2: ArtifactEventV0 = {
      schema: "tribunus.artifact_event.v0",
      eventID: "evt9",
      kind: "artifact.updated",
      sessionID: "s1",
      artifactID: "a3",
      timestamp: 900,
      inlineContent: "Checking preservation",
      workspaceMode: "virtual_fs_sandbox" // Same or omitted
    }

    applyArtifactEventV0(event2, ctx)
    const updated = ctx.getArtifact("a3")
    expect(updated?.workspaceMode).toBe("virtual_fs_sandbox")
  })
})
