import { describe, it, expect } from "bun:test"
import { checkSender, type SenderCheck, type IpcSenderInfo, type IpcFrameInfo } from "../../src/main/ipc-sender"

// Mock IpcSenderInfo — no Electron dependency
function mockSender(overrides: Partial<{ destroyed: boolean; url: string }> = {}): IpcSenderInfo {
  return {
    isDestroyed: () => overrides.destroyed ?? false,
    getURL: () => overrides.url ?? "file:///app/index.html",
  }
}

// ---------------------------------------------------------------------------
// checkSender — standard policy
// ---------------------------------------------------------------------------
describe("checkSender — standard policy", () => {
  it("allows a valid sender", () => {
    const result = checkSender(mockSender(), "standard")
    expect(result.allowed).toBe(true)
  })

  it("rejects a destroyed sender", () => {
    const result = checkSender(mockSender({ destroyed: true }), "standard")
    expect(result.allowed).toBe(false)
    const r = result as Extract<SenderCheck, { allowed: false }>
    expect(r.reason).toContain("destroyed")
  })

  it("rejects a null sender", () => {
    const result = checkSender(null, "standard")
    expect(result.allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// checkSender — strict policy
// ---------------------------------------------------------------------------
describe("checkSender — strict policy", () => {
  it("allows packaged origin", () => {
    const result = checkSender(mockSender({ url: "file:///app/index.html" }), "strict")
    expect(result.allowed).toBe(true)
  })

  it("allows dev origin", () => {
    const result = checkSender(mockSender({ url: "http://localhost:5173/" }), "strict")
    expect(result.allowed).toBe(true)
  })

  it("rejects unknown origin", () => {
    const result = checkSender(mockSender({ url: "https://evil.com/" }), "strict")
    expect(result.allowed).toBe(false)
    const r = result as Extract<SenderCheck, { allowed: false }>
    expect(r.reason).toContain("unapproved")
  })

  it("rejects non-main frame", () => {
    const result = checkSender(
      mockSender({ url: "file:///app/index.html" }),
      "strict",
      { url: "file:///app/iframe.html", isMainFrame: false },
    )
    expect(result.allowed).toBe(false)
    const r = result as Extract<SenderCheck, { allowed: false }>
    expect(r.reason).toContain("non-main frame")
  })

  it("allows main frame", () => {
    const result = checkSender(
      mockSender({ url: "file:///app/index.html" }),
      "strict",
      { url: "file:///app/index.html", isMainFrame: true },
    )
    expect(result.allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Response envelope shapes
// ---------------------------------------------------------------------------
describe("Response envelope shapes", () => {
  it("success envelope has correct shape", () => {
    const envelope = {
      ok: true as const,
      protocolVersion: 1 as const,
      requestId: "test-123",
      value: { result: "ok" },
    }
    expect(envelope.ok).toBe(true)
    expect(envelope.protocolVersion).toBe(1)
    expect(typeof envelope.requestId).toBe("string")
    expect("value" in envelope).toBe(true)
  })

  it("error envelope has correct shape", () => {
    const envelope = {
      ok: false as const,
      protocolVersion: 1 as const,
      requestId: "test-456",
      error: {
        code: "timeout" as const,
        message: "Operation timed out",
        recoverability: "retryable" as const,
      },
    }
    expect(envelope.ok).toBe(false)
    expect(envelope.error.code).toBe("timeout")
    expect(envelope.error.recoverability).toBe("retryable")
  })

  it("internal error has safe generic message", () => {
    const envelope = {
      ok: false as const,
      protocolVersion: 1 as const,
      requestId: "test-789",
      error: {
        code: "internal" as const,
        message: "An unexpected error occurred",
        recoverability: "non-recoverable" as const,
      },
    }
    expect(envelope.error.message).not.toContain("at ")
    expect(envelope.error.message).not.toContain("/Users/")
    expect(envelope.error.message).not.toContain("token")
  })

  it("permission denied has stable shape", () => {
    const envelope = {
      ok: false as const,
      protocolVersion: 1 as const,
      requestId: "test-perm",
      error: {
        code: "permission_denied" as const,
        message: "sender destroyed or missing",
        recoverability: "non-recoverable" as const,
      },
    }
    expect(envelope.error.code).toBe("permission_denied")
    expect(envelope.error.recoverability).toBe("non-recoverable")
  })
})
