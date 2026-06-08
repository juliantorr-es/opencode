import { describe, it, expect } from "bun:test"
import { createServerTestCell } from "./test-cell"

describe("Server Runtime Test Cell v0", () => {
  // First run
  it("smoke test: can boot and teardown sequentially twice without conflicts", async () => {
    // First run
    const cell1 = await createServerTestCell()
    expect(cell1.workspaceDir).toBeTruthy()
    expect(cell1.dbPath).toBeTruthy()
    
    // Perform a basic status request to verify the service graph is functional
    const response1 = await cell1.request("/session/status")
    expect(response1.status).toBe(200)
    await response1.json()

    await cell1.teardown()

    // Second run using a new isolated database identity
    const cell2 = await createServerTestCell()
    expect(cell2.workspaceDir).toBeTruthy()
    expect(cell2.dbPath).toBeTruthy()
    expect(cell2.dbPath).not.toBe(cell1.dbPath)

    const response2 = await cell2.request("/session/status")
    expect(response2.status).toBe(200)
    await response2.json()

    await cell2.teardown()
  }, 30000)

  it("session invariant: POST /session then GET /session/{id} succeeds under same directory header", async () => {
    const cell = await createServerTestCell()
    try {
      const headers = {
        "x-opencode-directory": cell.workspaceDir,
        "content-type": "application/json",
      }

      // 1. Create a session
      const createResponse = await cell.request("/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "invariant test session" }),
      })
      expect(createResponse.status).toBe(200)
      const session = await createResponse.json()
      expect(session).toHaveProperty("id")
      expect(session.title).toBe("invariant test session")

      const sessionID = session.id

      // 2. Immediately read it back using the same directory header
      const getResponse = await cell.request(`/session/${sessionID}`, {
        method: "GET",
        headers,
      })
      expect(getResponse.status).toBe(200)
      const retrieved = await getResponse.json()
      expect(retrieved.id).toBe(sessionID)
      expect(retrieved.title).toBe("invariant test session")
    } finally {
      await cell.teardown()
    }
  }, 30000)
})
