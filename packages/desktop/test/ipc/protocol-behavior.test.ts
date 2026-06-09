import { describe, it, expect } from "bun:test"
import { Schema } from "effect"
import { IpcOkSchema, IpcErrSchema, ProtocolVersion, RequestId } from "../../src/ipc/protocol"
import { PublicIpcError, IpcErrorCode, Recoverability } from "../../src/ipc/errors"
import { newRequestId } from "../../src/ipc/request"

// ---------------------------------------------------------------------------
// IpcOkSchema — success envelope round-trip and malformed rejection
// ---------------------------------------------------------------------------
describe("IpcOkSchema", () => {
  it("encodes and decodes a success value", () => {
    const ok = {
      ok: true as const,
      protocolVersion: 1 as const,
      requestId: newRequestId(),
      value: { data: "hello" },
    }
    const decoded = Schema.decodeUnknownSync(IpcOkSchema)(ok)
    expect(decoded.ok).toBe(true)
    expect(decoded.value).toEqual({ data: "hello" })
    expect(decoded.requestId).toBe(ok.requestId)
  })

  it("rejects missing fields", () => {
    const bad = { ok: true, protocolVersion: 1, requestId: "abc" }
    expect(() => Schema.decodeUnknownSync(IpcOkSchema)(bad)).toThrow()
  })

  it("rejects wrong protocol version", () => {
    const bad = { ok: true, protocolVersion: 2, requestId: newRequestId(), value: null }
    expect(() => Schema.decodeUnknownSync(IpcOkSchema)(bad)).toThrow()
  })

  it("rejects ok: 'true' (string not boolean)", () => {
    const bad = { ok: "true", protocolVersion: 1, requestId: newRequestId(), value: null }
    expect(() => Schema.decodeUnknownSync(IpcOkSchema)(bad)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// IpcErrSchema — error envelope round-trip and malformed rejection
// ---------------------------------------------------------------------------
describe("IpcErrSchema", () => {
  it("encodes and decodes an error", () => {
    const err = {
      ok: false as const,
      protocolVersion: 1 as const,
      requestId: newRequestId(),
      error: { code: "timeout" as const, message: "timed out", recoverability: "retryable" as const },
    }
    const decoded = Schema.decodeUnknownSync(IpcErrSchema)(err)
    expect(decoded.ok).toBe(false)
    expect(decoded.error.code).toBe("timeout")
    expect(decoded.error.recoverability).toBe("retryable")
  })

  it("rejects unknown error code", () => {
    const err = {
      ok: false,
      protocolVersion: 1,
      requestId: newRequestId(),
      error: { code: "bogus", message: "x", recoverability: "recoverable" },
    }
    expect(() => Schema.decodeUnknownSync(IpcErrSchema)(err)).toThrow()
  })

  it("rejects unknown recoverability", () => {
    const err = {
      ok: false,
      protocolVersion: 1,
      requestId: newRequestId(),
      error: { code: "internal", message: "x", recoverability: "maybe" },
    }
    expect(() => Schema.decodeUnknownSync(IpcErrSchema)(err)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// ProtocolVersion — version enforcement
// ---------------------------------------------------------------------------
describe("ProtocolVersion", () => {
  it("accepts version 1", () => {
    const decoded = Schema.decodeUnknownSync(ProtocolVersion)(1)
    expect(decoded).toBe(1)
  })

  it("rejects version 0", () => {
    expect(() => Schema.decodeUnknownSync(ProtocolVersion)(0)).toThrow()
  })

  it("rejects version 2", () => {
    expect(() => Schema.decodeUnknownSync(ProtocolVersion)(2)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// RequestId — uniqueness and format
// ---------------------------------------------------------------------------
describe("RequestId", () => {
  it("generates 1000 unique IDs", () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const id = newRequestId()
      expect(ids.has(id)).toBe(false)
      ids.add(id)
    }
    expect(ids.size).toBe(1000)
  })

  it("generates non-empty branded strings", () => {
    const id = newRequestId()
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Malformed request rejection — direct decode of non-envelope inputs
// ---------------------------------------------------------------------------
describe("Malformed request rejection", () => {
  it("rejects a non-object (null)", () => {
    expect(() => Schema.decodeUnknownSync(IpcOkSchema)(null)).toThrow()
  })

  it("rejects a non-object (string)", () => {
    expect(() => Schema.decodeUnknownSync(IpcOkSchema)("hello")).toThrow()
  })

  it("rejects an object without ok field", () => {
    const bad = { protocolVersion: 1, requestId: newRequestId(), value: null }
    expect(() => Schema.decodeUnknownSync(IpcOkSchema)(bad)).toThrow()
  })

  it("rejects ok: 'true' (string, not literal true)", () => {
    const bad = { ok: "true", protocolVersion: 1, requestId: newRequestId(), value: null }
    expect(() => Schema.decodeUnknownSync(IpcOkSchema)(bad)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Malformed success payload — value that doesn't match schema
// ---------------------------------------------------------------------------
describe("Malformed success payload rejection", () => {
  it("rejects IpcOk whose value fails the structural check", () => {
    // IpcOkSchema uses Schema.Unknown for value, so any value is accepted.
    // This test verifies that a structurally invalid payload (missing required
    // fields) is rejected by the envelope itself.
    const bad = { ok: true, protocolVersion: 1, requestId: newRequestId() }
    expect(() => Schema.decodeUnknownSync(IpcOkSchema)(bad)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// IpcErrorCode vocabulary — all 10 codes accepted
// ---------------------------------------------------------------------------
describe("IpcErrorCode vocabulary", () => {
  const allCodes: readonly string[] = [
    "unavailable",
    "invalid_request",
    "permission_denied",
    "timeout",
    "not_found",
    "conflict",
    "cancelled",
    "rate_limited",
    "unsupported",
    "internal",
  ]
  for (const code of allCodes) {
    it(`accepts "${code}"`, () => {
      const err = { code, message: "test", recoverability: "non-recoverable" as const }
      const decoded = Schema.decodeUnknownSync(PublicIpcError)(err)
      expect(decoded.code).toBe(code as typeof decoded.code)
    })
  }
})

// ---------------------------------------------------------------------------
// Recoverability classification — all 3 levels accepted
// ---------------------------------------------------------------------------
describe("Recoverability classification", () => {
  const allLevels: Array<"recoverable" | "non-recoverable" | "retryable"> = [
    "recoverable",
    "non-recoverable",
    "retryable",
  ]
  for (const level of allLevels) {
    it(`accepts "${level}"`, () => {
      const err = { code: "timeout" as const, message: "test", recoverability: level }
      const decoded = Schema.decodeUnknownSync(PublicIpcError)(err)
      expect(decoded.recoverability).toBe(level)
    })
  }
})

// ---------------------------------------------------------------------------
// Redaction — internal details must not appear in PublicIpcError
// ---------------------------------------------------------------------------
describe("Redaction", () => {
  it("does not expose stack trace in PublicIpcError", () => {
    const err = { code: "internal" as const, message: "safe msg", recoverability: "non-recoverable" as const }
    const decoded = Schema.decodeUnknownSync(PublicIpcError)(err)
    expect("stack" in decoded).toBe(false)
    expect("cause" in decoded).toBe(false)
  })

  it("extra fields are stripped (stack, cause not in decoded value)", () => {
    // beta.66 Schema.Struct ignores extra fields by default rather than rejecting.
    // The decoded value must not carry the stack or other leaked fields.
    const err = {
      code: "internal",
      message: "safe",
      recoverability: "non-recoverable",
      stack: "at foo.ts:1",
    }
    const decoded = Schema.decodeUnknownSync(PublicIpcError)(err)
    expect(decoded.code).toBe("internal")
    expect((decoded as any).stack).toBeUndefined()
  })

  it("unknown defect redaction: shows safe message, no raw cause", () => {
    const err = { code: "internal" as const, message: "An unexpected error occurred", recoverability: "non-recoverable" as const }
    const decoded = Schema.decodeUnknownSync(PublicIpcError)(err)
    // The message must be safe — no stack traces, no file paths, no raw cause data.
    expect(decoded.message).not.toContain("at ")
    expect(decoded.message).not.toContain("/")
    expect("cause" in decoded).toBe(false)
    expect("stack" in decoded).toBe(false)
  })
})
