import { describe, expect, test } from "bun:test"
import { ErrorCode, makeError, parseToolError, isSuccess, isError } from "../src/errors.js"

// ── ErrorCode enum ──

test("ErrorCode enum has 10 values", () => {
  const values = Object.values(ErrorCode)
  expect(values).toHaveLength(10)
})

test("ErrorCode values are unique", () => {
  const values = Object.values(ErrorCode)
  expect(new Set(values).size).toBe(values.length)
})

// ── makeError ──

test("makeError produces valid JSON with all standard fields", () => {
  const result = makeError(ErrorCode.NOT_FOUND, "File not found: config.json")
  const parsed = JSON.parse(result)
  expect(parsed.error).toBe("File not found: config.json")
  expect(parsed.status).toBe("error")
  expect(parsed.error_code).toBe("NOT_FOUND")
  expect(parsed.details).toBeUndefined()
})

test("makeError with status override", () => {
  const result = makeError(ErrorCode.CONFLICT, "Already exists", { status: "fail" })
  const parsed = JSON.parse(result)
  expect(parsed.status).toBe("fail")
  expect(parsed.error_code).toBe("CONFLICT")
})

test("makeError with status: blocked", () => {
  const result = makeError(ErrorCode.PERMISSION_DENIED, "Lock held", { status: "blocked" })
  const parsed = JSON.parse(result)
  expect(parsed.status).toBe("blocked")
})

test("makeError with details", () => {
  const result = makeError(ErrorCode.INVALID_ARGUMENTS, "Bad input", {
    details: { field: "file", expected: "string" },
  })
  const parsed = JSON.parse(result)
  expect(parsed.details).toEqual({ field: "file", expected: "string" })
})

test("makeError defaults status to error when not provided", () => {
  const result = makeError(ErrorCode.TIMEOUT, "Timed out")
  const parsed = JSON.parse(result)
  expect(parsed.status).toBe("error")
})

// ── B1: assertValidErrorCode runtime guard ──

test("makeError throws TypeError for invalid code", () => {
  expect(() => makeError("NOT_A_REAL_CODE" as ErrorCode, "msg")).toThrow(TypeError)
  expect(() => makeError("NOT_A_REAL_CODE" as ErrorCode, "msg")).toThrow("Invalid error code")
})

test("makeError does not throw for any valid ErrorCode", () => {
  for (const code of Object.values(ErrorCode)) {
    expect(() => makeError(code, "test")).not.toThrow()
  }
})

// ── B2: circular reference fallback ──

test("makeError falls back to INTERNAL_ERROR for circular references", () => {
  const circ: Record<string, unknown> = { name: "loop" }
  circ.self = circ
  const result = makeError(ErrorCode.INVALID_ARGUMENTS, "Bad input", { details: circ })
  const parsed = JSON.parse(result)
  // Should fall back to INTERNAL_ERROR with original message preserved
  expect(parsed.error_code).toBe("INTERNAL_ERROR")
  expect(parsed.error).toBe("Bad input")
  expect(parsed.status).toBe("error")
})

test("makeError falls back for BigInt (non-serializable)", () => {
  const result = makeError(ErrorCode.INVALID_ARGUMENTS, "BigInt details", {
    details: { big: BigInt(123) },
  })
  const parsed = JSON.parse(result)
  expect(parsed.error_code).toBe("INTERNAL_ERROR")
  expect(parsed.error).toBe("BigInt details")
})

test("makeError still works with no opts when serialization fallback triggers", () => {
  // Even without opts, the function should handle gracefully
  const result = makeError(ErrorCode.INTERNAL_ERROR, "Something broke")
  const parsed = JSON.parse(result)
  expect(parsed.error_code).toBe("INTERNAL_ERROR")
})

// ── parseToolError ──

test("parseToolError returns ParsedError for valid error JSON", () => {
  const input = JSON.stringify({ error: "msg", status: "error", error_code: "NOT_FOUND" })
  const result = parseToolError(input)
  expect(result).not.toBeNull()
  expect(result!.error).toBe("msg")
  expect(result!.error_code).toBe("NOT_FOUND")
})

test("parseToolError returns null for success JSON", () => {
  const input = JSON.stringify({ action: "propose", plan_id: "test" })
  expect(parseToolError(input)).toBeNull()
})

test("parseToolError returns null for non-JSON string", () => {
  expect(parseToolError("just some text")).toBeNull()
})

test("parseToolError returns null for JSON without error_code", () => {
  expect(parseToolError(JSON.stringify({ error: "msg" }))).toBeNull()
})

test("parseToolError returns null for JSON without error key", () => {
  expect(parseToolError(JSON.stringify({ error_code: "NOT_FOUND" }))).toBeNull()
})

test("parseToolError returns null for non-object JSON", () => {
  expect(parseToolError("42")).toBeNull()
  expect(parseToolError('"string"')).toBeNull()
  expect(parseToolError("null")).toBeNull()
})

test("parseToolError returns null for empty string", () => {
  expect(parseToolError("")).toBeNull()
})

// ── isSuccess / isError ──

test("isSuccess returns true for non-error JSON", () => {
  expect(isSuccess(JSON.stringify({ action: "done" }))).toBe(true)
})

test("isSuccess returns true for plain text", () => {
  expect(isSuccess("some output")).toBe(true)
})

test("isSuccess returns false for error JSON", () => {
  expect(isSuccess(makeError(ErrorCode.NOT_FOUND, "gone"))).toBe(false)
})

test("isError returns true for error JSON", () => {
  expect(isError(makeError(ErrorCode.CONFLICT, "dup"))).toBe(true)
})

test("isError returns false for non-error JSON", () => {
  expect(isError(JSON.stringify({ ok: true }))).toBe(false)
})

test("isError returns false for plain text", () => {
  expect(isError("hello")).toBe(false)
})

// ── Round-trip: makeError → parseToolError ──

test("round-trip preserves error, status, code, and details", () => {
  const original = makeError(ErrorCode.TRANSIENT, "Rate limited", {
    status: "fail",
    details: { retry_after: 30 },
  })
  const parsed = parseToolError(original)
  expect(parsed).not.toBeNull()
  expect(parsed!.error).toBe("Rate limited")
  expect(parsed!.status).toBe("fail")
  expect(parsed!.error_code).toBe("TRANSIENT")
  expect(parsed!.details).toEqual({ retry_after: 30 })
})

// ── isSuccess / isError agree ──

test("isSuccess and isError are mutually exclusive", () => {
  const cases = [
    makeError(ErrorCode.NOT_FOUND, "x"),
    JSON.stringify({ ok: true }),
    "plain text",
    "",
  ]
  for (const c of cases) {
    expect(isSuccess(c)).toBe(!isError(c))
  }
})
