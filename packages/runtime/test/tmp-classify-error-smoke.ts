import { describe, it, expect } from "bun:test"
import { Cause } from "effect"
import { classifyError, INSTANCE_FAILURE_CODES } from "../src/diagnostic/instance-failure-codes"

describe("classifyError — known error patterns", () => {
  it("classifies connection refused as DB_CONNECTION", () => {
    const result = classifyError(new Error("connection refused"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_CONNECTION)
  })

  it("classifies ECONNREFUSED as DB_CONNECTION", () => {
    const result = classifyError(new Error("ECONNREFUSED"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_CONNECTION)
  })

  it("classifies 'could not connect' as DB_CONNECTION", () => {
    const result = classifyError(new Error("could not connect to server"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_CONNECTION)
  })

  it("classifies 'connect ECONNREFUSED' as DB_CONNECTION", () => {
    const result = classifyError(new Error("connect ECONNREFUSED ::1:5432"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_CONNECTION)
  })

  it("classifies 'database X not found' as DB_CONNECTION", () => {
    const result = classifyError(new Error("database mydb not found"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_CONNECTION)
  })

  it("classifies 'database X does not exist' as DB_CONNECTION", () => {
    const result = classifyError(new Error("database mydb does not exist"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_CONNECTION)
  })

  it("classifies 'no such database' as DB_CONNECTION", () => {
    const result = classifyError(new Error("no such database"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_CONNECTION)
  })

  it("classifies ENOENT as FILE_NOT_FOUND", () => {
    const result = classifyError(new Error("ENOENT: no such file or directory"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FILE_NOT_FOUND)
  })

  it("classifies 'no such file' as FILE_NOT_FOUND", () => {
    const result = classifyError(new Error("no such file or directory"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FILE_NOT_FOUND)
  })

  it("classifies 'file not found' as FILE_NOT_FOUND", () => {
    const result = classifyError(new Error("file not found: /tmp/foo.ts"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FILE_NOT_FOUND)
  })

  it("classifies 'not found' as FILE_NOT_FOUND", () => {
    const result = classifyError(new Error("not found"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FILE_NOT_FOUND)
  })

  it("classifies 'JSON' / parse errors as CONFIG_PARSE", () => {
    const result = classifyError(new Error("Unexpected token in JSON at position 1"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.CONFIG_PARSE)
  })

  it("classifies 'Unexpected token' as CONFIG_PARSE", () => {
    const result = classifyError(new Error("Unexpected token"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.CONFIG_PARSE)
  })

  it("classifies 'invalid config' as CONFIG_PARSE", () => {
    const result = classifyError(new Error("invalid config"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.CONFIG_PARSE)
  })

  it("classifies 'migration' as DB_MIGRATION", () => {
    const result = classifyError(new Error("migration failed"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_MIGRATION)
  })

  it("classifies 'relation already exists' as DB_MIGRATION", () => {
    const result = classifyError(new Error("relation users already exists"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_MIGRATION)
  })

  it("classifies 'duplicate column' as DB_MIGRATION", () => {
    const result = classifyError(new Error("duplicate column: email"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_MIGRATION)
  })

  it("classifies 'permission denied' as FILE_PERMISSION", () => {
    const result = classifyError(new Error("permission denied"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FILE_PERMISSION)
  })

  it("classifies EACCES as FILE_PERMISSION", () => {
    const result = classifyError(new Error("EACCES"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FILE_PERMISSION)
  })

  it("classifies 'not permitted' as FILE_PERMISSION", () => {
    const result = classifyError(new Error("operation not permitted"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FILE_PERMISSION)
  })

  it("classifies 'plugin' as PLUGIN", () => {
    const result = classifyError(new Error("plugin load error"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.PLUGIN)
  })

  it("classifies 'scope closed' as SCOPE_CLOSED", () => {
    const result = classifyError(new Error("scope closed"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.SCOPE_CLOSED)
  })

  it("classifies 'ScopeClosed' as SCOPE_CLOSED", () => {
    const result = classifyError(new Error("ScopeClosed"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.SCOPE_CLOSED)
  })

  it("classifies 'fiber interrupted' as FIBER_INTERRUPTED", () => {
    const result = classifyError(new Error("fiber interrupted"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FIBER_INTERRUPTED)
  })

  it("classifies 'FiberInterrupted' as FIBER_INTERRUPTED", () => {
    const result = classifyError(new Error("FiberInterrupted"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FIBER_INTERRUPTED)
  })

  it("classifies network errors (fetch) as NETWORK", () => {
    const result = classifyError(new Error("fetch failed"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.NETWORK)
  })

  it("classifies HTTP errors as NETWORK", () => {
    const result = classifyError(new Error("HTTP 500"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.NETWORK)
  })

  it("classifies ECONNRESET as NETWORK", () => {
    const result = classifyError(new Error("ECONNRESET"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.NETWORK)
  })

  it("classifies ETIMEDOUT as NETWORK", () => {
    const result = classifyError(new Error("ETIMEDOUT"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.NETWORK)
  })

  it("classifies ENOTFOUND as NETWORK", () => {
    const result = classifyError(new Error("ENOTFOUND"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.NETWORK)
  })
})

describe("classifyError — pattern ordering priority", () => {
  it("ECONNREFUSED hits DB_CONNECTION before NETWORK", () => {
    const result = classifyError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_CONNECTION)
    expect(result.code).not.toBe(INSTANCE_FAILURE_CODES.NETWORK)
  })

  it("'database X not found' hits DB_CONNECTION before FILE_NOT_FOUND", () => {
    const result = classifyError(new Error("database myapp not found"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_CONNECTION)
    expect(result.code).not.toBe(INSTANCE_FAILURE_CODES.FILE_NOT_FOUND)
  })

  it("'not found' without database prefix hits FILE_NOT_FOUND", () => {
    const result = classifyError(new Error("not found"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FILE_NOT_FOUND)
    expect(result.code).not.toBe(INSTANCE_FAILURE_CODES.DB_CONNECTION)
  })
})

describe("classifyError — red-team: exotic inputs", () => {
  it("handles null input", () => {
    const result = classifyError(null)
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.UNKNOWN)
    expect(result.message).toBe("null")
  })

  it("handles undefined input", () => {
    const result = classifyError(undefined)
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.UNKNOWN)
    expect(result.message).toBe("undefined")
  })

  it("handles number input: 42", () => {
    const result = classifyError(42)
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.UNKNOWN)
    expect(result.message).toBe("42")
  })

  it("handles plain object: {}", () => {
    const result = classifyError({})
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.UNKNOWN)
    expect(result.message).toBe("[object Object]")
  })

  it("handles plain string", () => {
    const result = classifyError("something went wrong")
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.UNKNOWN)
    expect(result.message).toBe("something went wrong")
  })

  it("handles array input", () => {
    const result = classifyError([1, 2, 3])
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.UNKNOWN)
    expect(result.message).toBe("1,2,3")
  })

  it("handles boolean true", () => {
    const result = classifyError(true)
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.UNKNOWN)
    expect(result.message).toBe("true")
  })

  it("handles boolean false", () => {
    const result = classifyError(false)
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.UNKNOWN)
    expect(result.message).toBe("false")
  })
})

describe("classifyError — Effect Cause.fail and Cause.die", () => {
  it("Cause.fail with connection refused → DB_CONNECTION", () => {
    const cause = Cause.fail(new Error("connection refused"))
    const result = classifyError(cause)
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_CONNECTION)
  })

  it("Cause.fail with ENOENT → FILE_NOT_FOUND", () => {
    const cause = Cause.fail(new Error("ENOENT: no such file or directory"))
    const result = classifyError(cause)
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FILE_NOT_FOUND)
  })

  it("Cause.die with permission denied → FILE_PERMISSION", () => {
    const cause = Cause.die("EACCES: permission denied")
    const result = classifyError(cause)
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FILE_PERMISSION)
  })

  it("Cause.die with FiberInterrupted → FIBER_INTERRUPTED", () => {
    const cause = Cause.die("FiberInterrupted")
    const result = classifyError(cause)
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FIBER_INTERRUPTED)
  })

  it("Cause.fail with unknown message → UNKNOWN", () => {
    const cause = Cause.fail(new Error("completely random string xyz"))
    const result = classifyError(cause)
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.UNKNOWN)
  })

  it("Cause.die with number defect → UNKNOWN", () => {
    const cause = Cause.die(42)
    const result = classifyError(cause)
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.UNKNOWN)
  })

  it("Cause.isCause detection works", () => {
    const cause = Cause.fail(new Error("connection refused"))
    expect(Cause.isCause(cause)).toBe(true)

    const err = new Error("connection refused")
    expect(Cause.isCause(err)).toBe(false)
  })
})

describe("classifyError — phase and service passthrough", () => {
  it("passes phase through", () => {
    const result = classifyError(new Error("connection refused"), "bootstrap")
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_CONNECTION)
    expect(result.phase).toBe("bootstrap")
  })

  it("passes service through", () => {
    const result = classifyError(new Error("ENOENT"), undefined, "storage")
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FILE_NOT_FOUND)
    expect(result.service).toBe("storage")
  })

  it("passes both phase and service through", () => {
    const result = classifyError(new Error("permission denied"), "config", "fs")
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FILE_PERMISSION)
    expect(result.phase).toBe("config")
    expect(result.service).toBe("fs")
  })
})

describe("classifyError — SQL and DB edge cases", () => {
  it("classifies 'syntax error' as DB_QUERY", () => {
    const result = classifyError(new Error("SQLITE_ERROR: syntax error"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_QUERY)
  })

  it("classifies 'query failed' as DB_QUERY", () => {
    const result = classifyError(new Error("query failed"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_QUERY)
  })

  it("classifies 'transaction failed' as DB_QUERY", () => {
    const result = classifyError(new Error("transaction failed"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_QUERY)
  })

  it("classifies 'Expected X JSON' as CONFIG_PARSE", () => {
    const result = classifyError(new Error("Expected double-quoted property name in JSON"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.CONFIG_PARSE)
  })

  it("migration patterns come before SQL syntax patterns", () => {
    // "migration: syntax error" — migration pattern (index 2) fires before syntax error (index 3)
    const result = classifyError(new Error("migration: syntax error"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.DB_MIGRATION)
    expect(result.code).not.toBe(INSTANCE_FAILURE_CODES.DB_QUERY)
  })
})

describe("classifyError — 'read' and 'write' word-boundary patterns", () => {
  it("classifies 'read' as FILE_READ", () => {
    const result = classifyError(new Error("failed to read"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FILE_READ)
  })

  it("classifies 'write' as FILE_WRITE", () => {
    const result = classifyError(new Error("failed to write"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.FILE_WRITE)
  })

  it("'read' inside 'thread' does not match FILE_READ", () => {
    // \bread\b should not match "thread"
    const result = classifyError(new Error("thread error"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.UNKNOWN)
  })

  it("'write' inside 'rewrite' does not match FILE_WRITE", () => {
    // \bwrite\b should not match "rewrite"
    const result = classifyError(new Error("rewrite failed"))
    expect(result.code).toBe(INSTANCE_FAILURE_CODES.UNKNOWN)
  })
})
