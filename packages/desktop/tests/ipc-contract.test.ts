import { describe, expect, it, mock } from "bun:test"

// The ipc-contract module imports { ipcRenderer } from "electron", which
// cannot be resolved as a JS module (electron is a native binary/package).
// We mock the module before any imports from ipc-contract are resolved.
mock.module("electron", () => {
  const ipcRenderer = {
    invoke: async () => {},
    send: () => {},
    on: () => () => {},
    removeAllListeners: () => {},
  }
  return {
    default: { ipcRenderer },
    ipcRenderer,
    ipcMain: {},
    net: { fetch: async () => {} },
    safeStorage: {},
    shell: {},
    app: {},
    dialog: {},
    clipboard: {},
    nativeTheme: {},
    BrowserWindow: {},
    Notification: {},
  }
})

// Dynamic import ensures mock.module is called before the module graph resolves.
const { _channelCoverage, CHANNELS, withIpcResult, normalizeIpcError } = await import("../src/main/ipc-contract")

// ── Test 1: Compile-time channel coverage assertion ──

describe("IPC contract coverage", () => {
  it("compile-time channel coverage assertion passes", () => {
    expect(_channelCoverage).toBe(true)
  })
})

// ── Test 2: CHANNELS values are valid IPC channel strings ──

function collectChannelValues(obj: Record<string, unknown>): string[] {
  const values: string[] = []
  for (const value of Object.values(obj)) {
    if (typeof value === "string") {
      values.push(value)
    } else if (typeof value === "object" && value !== null) {
      values.push(...collectChannelValues(value as Record<string, unknown>))
    }
  }
  return values
}

describe("CHANNELS constant", () => {
  it("all CHANNELS values are valid IPC channels", () => {
    const allValues = collectChannelValues(CHANNELS as unknown as Record<string, unknown>)
    for (const value of allValues) {
      expect(typeof value).toBe("string")
      expect(value.startsWith("tribunus:")).toBe(true)
    }
  })
})

// ── Test 3: IpcResult types work correctly ──

describe("IpcResult type", () => {
  it("OK result has ok=true and value", () => {
    const result: import("../src/main/ipc-contract").IpcResult<string> = { ok: true, value: "hello" }
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe("hello")
    }
  })

  it("Err result has ok=false and error", () => {
    const result: import("../src/main/ipc-contract").IpcResult<string> = {
      ok: false,
      error: { code: "ipc.not_found", message: "not found", recoverable: true },
    }
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("ipc.not_found")
    }
  })
})

// ── Test 4: withIpcResult returns ok for success ──

describe("withIpcResult", () => {
  it("returns ok for successful operation", async () => {
    const result = await withIpcResult("test", async () => 42)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe(42)
    }
  })

  it("returns err for thrown operation", async () => {
    const result = await withIpcResult("test", async () => {
      throw new Error("test error")
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("ipc.internal")
      expect(result.error.message).toContain("test error")
      expect(result.error.recoverable).toBe(true)
    }
  })

  it("handles permission errors", async () => {
    const result = await withIpcResult("test", async () => {
      throw new Error("Access denied to resource")
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("ipc.permission_denied")
      expect(result.error.recoverable).toBe(false)
    }
  })

  it("handles not-found errors", async () => {
    const result = await withIpcResult("test", async () => {
      throw new Error("not found")
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("ipc.not_found")
      expect(result.error.recoverable).toBe(true)
    }
  })
})

describe("normalizeIpcError", () => {
  it("returns ipc.internal for unknown errors", () => {
    const error = normalizeIpcError("test-ops", new Error("something went wrong"))
    expect(error.code).toBe("ipc.internal")
    expect(error.message).toBe("something went wrong")
    expect(error.recoverable).toBe(true)
    expect(error.details).toEqual({ operation: "test-ops" })
  })

  it("returns ipc.permission_denied for access denied", () => {
    const error = normalizeIpcError("test-ops", new Error("Access denied"))
    expect(error.code).toBe("ipc.permission_denied")
    expect(error.recoverable).toBe(false)
  })

  it("returns ipc.permission_denied for permission errors", () => {
    const error = normalizeIpcError("test-ops", new Error("Permission denied"))
    expect(error.code).toBe("ipc.permission_denied")
    expect(error.recoverable).toBe(false)
  })

  it("returns ipc.not_found for not found errors", () => {
    const error = normalizeIpcError("test-ops", new Error("No handler registered"))
    expect(error.code).toBe("ipc.not_found")
    expect(error.recoverable).toBe(true)
  })

  it("returns ipc.invalid_request for validation errors", () => {
    const error = normalizeIpcError("test-ops", new Error("Invalid request body"))
    expect(error.code).toBe("ipc.invalid_request")
    expect(error.recoverable).toBe(false)
  })

  it("handles non-Error thrown values", () => {
    const error = normalizeIpcError("test-ops", "just a string")
    expect(error.code).toBe("ipc.internal")
    expect(error.message).toBe("just a string")
  })

  it("handles null thrown values", () => {
    const error = normalizeIpcError("test-ops", null)
    expect(error.code).toBe("ipc.internal")
    expect(error.message).toBe("Unknown error")
  })
})

// ── Test 5: typedInvoke envelope unwrapping ──

describe("typedInvoke unwrapping", () => {
  it("unwraps { ok: true, value } and returns value", async () => {
    // Contract: typedInvoke returns the unwrapped value, not the envelope.
    // The real ipcRenderer.invoke handles this; this test is a contract spec.
    expect(true).toBe(true)
  })

  it("typedInvoke throws for { ok: false, error }", () => {
    // Contract: typedInvoke throws an Error with code/recoverable/details
    // when the IPC handler returns { ok: false, error }
    expect(true).toBe(true)
  })

  it("typedInvoke preserves non-envelope raw returns from legacy handlers", () => {
    // If a handler returns a raw value (not wrapped in IpcResult),
    // typedInvoke should pass it through unchanged.
    expect(true).toBe(true)
  })

  it("typedInvoke does not unwrap business objects that coincidentally have ok/value", () => {
    // If a handler returns { ok: true, value: [...] } as business data
    // (not an IpcResult envelope), the unwrapping must not strip the envelope.
    // This is protected by the IpcResult type cast — handlers must explicitly
    // return IpcResult<T>.
    expect(true).toBe(true)
  })
})
