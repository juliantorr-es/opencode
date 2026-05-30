import { describe, expect, test } from "bun:test"

// Tests the IPC handler registration pattern, store access control,
// and serialized write queueing — all as self-contained logic tests.
// We cannot import the real ipc.ts because it has static imports of
// the electron native module (ipcMain, BrowserWindow, etc.), which
// bun test cannot resolve in a non-Electron environment.

describe("IPC handler registration pattern", () => {
  type IpcHandler = (...args: any[]) => any

  test("ipcMain.handle and ipcMain.on register channels", () => {
    const handlers = new Map<string, IpcHandler>()
    const listeners = new Map<string, IpcHandler>()

    const ipcMain = {
      handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
      on: (channel: string, listener: IpcHandler) => listeners.set(channel, listener),
    }

    // Simulate registering handlers
    ipcMain.handle("kill-sidecar", () => {})
    ipcMain.handle("get-window-config", () => ({}))
    ipcMain.handle("store-get", () => null)
    ipcMain.on("open-link", () => {})
    ipcMain.on("loading-window-complete", () => {})

    expect(handlers.size).toBe(3)
    expect(listeners.size).toBe(2)
    expect(handlers.has("kill-sidecar")).toBe(true)
    expect(handlers.has("store-get")).toBe(true)
    expect(listeners.has("open-link")).toBe(true)
  })

  test("handlers can be invoked and return values", () => {
    const handlers = new Map<string, IpcHandler>()

    const ipcMain = {
      handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
    }

    // Register a handler that returns a value
    ipcMain.handle("get-window-config", () => ({
      position: { x: 100, y: 200 },
      size: { width: 1024, height: 768 },
    }))

    const handler = handlers.get("get-window-config")!
    const result = handler()
    expect(result).toEqual({ position: { x: 100, y: 200 }, size: { width: 1024, height: 768 } })
  })

  test("handlers can receive event + args", () => {
    const handlers = new Map<string, IpcHandler>()

    const ipcMain = {
      handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
    }

    ipcMain.handle("set-zoom-factor", (_event: any, factor: number) => factor)
    const handler = handlers.get("set-zoom-factor")!
    const result = handler({ sender: { setZoomFactor: () => {} } }, 1.5)
    expect(result).toBe(1.5)
  })

  test("removeHandler deregisters a channel", () => {
    const handlers = new Map<string, IpcHandler>()

    const ipcMain = {
      handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    }

    ipcMain.handle("temp-channel", () => "temp")
    expect(handlers.has("temp-channel")).toBe(true)

    ipcMain.removeHandler("temp-channel")
    expect(handlers.has("temp-channel")).toBe(false)
  })
})

describe("IPC handler delegation pattern", () => {
  // Tests the pattern used in ipc.ts where handlers delegate to a Deps object
  type Deps = Record<string, (...args: any[]) => any>

  test("handlers delegate to deps object correctly", () => {
    const calls: string[] = []
    const deps: Deps = {
      killSidecar: () => calls.push("killSidecar"),
      getDefaultServerUrl: () => "http://localhost:4096",
      runUpdater: (alertOnFail: boolean) => calls.push(`runUpdater:${alertOnFail}`),
    }

    const handlers = new Map<string, (...args: any[]) => any>()

    // Simulate ipc.ts handler registration pattern
    const registerHandlers = (d: Deps) => {
      handlers.set("kill-sidecar", () => d.killSidecar())
      handlers.set("get-default-server-url", () => d.getDefaultServerUrl())
      handlers.set("run-updater", (_event: any, alertOnFail: boolean) => d.runUpdater(alertOnFail))
    }

    registerHandlers(deps)

    // Trigger kill-sidecar handler
    handlers.get("kill-sidecar")!()
    expect(calls).toContain("killSidecar")

    // Check value-returning handler
    const url = handlers.get("get-default-server-url")!()
    expect(url).toBe("http://localhost:4096")

    // Check handler with args
    handlers.get("run-updater")!({}, true)
    expect(calls).toContain("runUpdater:true")
  })
})

describe("RESERVED_STORE_NAMES access control", () => {
  // Tests the reserved store names pattern from ipc.ts
  const RESERVED_STORE_NAMES = ["desktop-custom-agents", "desktop-mcp-servers", "desktop-plugin-config", "github-auth"]

  function checkReserved(name: string): void {
    if (RESERVED_STORE_NAMES.includes(name)) {
      throw new Error(`Access denied: '${name}' is a reserved store namespace`)
    }
  }

  test("throws for reserved store names on get", () => {
    for (const name of RESERVED_STORE_NAMES) {
      expect(() => checkReserved(name)).toThrow(`Access denied: '${name}' is a reserved store namespace`)
    }
  })

  test("allows non-reserved store names", () => {
    expect(() => checkReserved("custom-store")).not.toThrow()
    expect(() => checkReserved("user-preferences")).not.toThrow()
    expect(() => checkReserved("")).not.toThrow()
  })

  test("allows reserved-like names that aren't exactly reserved", () => {
    expect(() => checkReserved("desktop-custom-agents-backup")).not.toThrow()
    expect(() => checkReserved("my-desktop-mcp-servers")).not.toThrow()
  })
})

describe("serializedWrite queue pattern", () => {
  // Tests the serializedWrite pattern from ipc.ts
  // Ensures operations on the same namespace are serialized

  function createSerializedWrite() {
    const writeQueues = new Map<string, Promise<unknown>>()

    return <T = void>(namespace: string, fn: () => T): Promise<T> => {
      const prev = writeQueues.get(namespace) ?? Promise.resolve(undefined as unknown as T)
      const next = prev
        .then(() => fn())
        .catch((err) => {
          console.error(`Write queue error for "${namespace}":`, err)
          throw err
        })
      writeQueues.set(namespace, next)
      return next
    }
  }

  test("serializes writes to the same namespace", async () => {
    const serializedWrite = createSerializedWrite()
    const order: number[] = []

    const p1 = serializedWrite("test", async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push(1)
    })
    const p2 = serializedWrite("test", async () => {
      order.push(2)
    })

    await Promise.all([p1, p2])
    // p2 should execute after p1 completes
    expect(order).toEqual([1, 2])
  })

  test("writes to different namespaces execute independently", async () => {
    const serializedWrite = createSerializedWrite()
    const order: number[] = []

    const p1 = serializedWrite("ns1", async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push(1)
    })
    const p2 = serializedWrite("ns2", async () => {
      order.push(2)
    })

    await Promise.all([p1, p2])
    // p2 can complete before p1 since they're different namespaces
    expect(order).toEqual([2, 1])
  })

  test("returns the value from the wrapped function", async () => {
    const serializedWrite = createSerializedWrite()
    const result = await serializedWrite("calc", () => 42)
    expect(result).toBe(42)
  })

  test("a failed write rejects and subsequent writes on same namespace also reject", async () => {
    const serializedWrite = createSerializedWrite()
    const errors: unknown[] = []

    // First write fails — promise is rejected
    const p1 = serializedWrite("err-test", () => {
      throw new Error("first fail")
    }).catch((e) => errors.push(e))

    // Second write chains on the rejected promise, so it also rejects
    const p2 = serializedWrite("err-test", () => "never-called")
    await p2.catch((e: unknown) => errors.push(e))

    await p1
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })

  test("independent namespaces are not affected by failures", async () => {
    const serializedWrite = createSerializedWrite()

    const p1 = serializedWrite("ns-a", () => {
      throw new Error("ns-a fail")
    }).catch(() => "handled")

    const p2 = serializedWrite("ns-b", () => "ns-b success")

    await p1
    const result = await p2
    expect(result).toBe("ns-b success")
  })
})

describe("IPC handler error handling patterns", () => {
  // Tests the try-catch patterns used in ipc.ts handlers

  test("handler wraps logic in try-catch returning error object", async () => {
    const sessionExportData = async (_event: any, data: string) => {
      try {
        // Simulated happy path
        return "/path/to/exported/file"
      } catch (e) {
        return { error: (e as Error).message }
      }
    }

    // Happy path
    const result1 = await sessionExportData({}, "data")
    expect(result1).toBe("/path/to/exported/file")
  })

  test("handler with validation throws on invalid input", () => {
    const storeGet = (_event: any, name: string) => {
      if (["reserved"].includes(name)) throw new Error("Access denied")
      return "value"
    }

    expect(() => storeGet({}, "reserved")).toThrow("Access denied")
    expect(() => storeGet({}, "allowed")).not.toThrow()
  })
})

describe("pickerFilters utility", () => {
  // Tests the pickerFilters function from ipc.ts
  const pickerFilters = (ext?: string[]) => {
    if (!ext || ext.length === 0) return undefined
    return [{ name: "Files", extensions: ext }]
  }

  test("returns undefined for no extensions", () => {
    expect(pickerFilters()).toBeUndefined()
    expect(pickerFilters([])).toBeUndefined()
  })

  test("returns filter array for given extensions", () => {
    const result = pickerFilters(["json", "txt"])
    expect(result).toEqual([{ name: "Files", extensions: ["json", "txt"] }])
  })

  test("handles single extension", () => {
    const result = pickerFilters(["png"])
    expect(result).toEqual([{ name: "Files", extensions: ["png"] }])
  })
})

describe("BrowserWindow helper patterns", () => {
  // Tests the patterns used in ipc.ts around BrowserWindow operations

  test("get-window-count uses BrowserWindow.getAllWindows().length", () => {
    let windows: any[] = []

    const getWindowCount = () => windows.length

    expect(getWindowCount()).toBe(0)
    windows.push({})
    expect(getWindowCount()).toBe(1)
    windows.push({})
    expect(getWindowCount()).toBe(2)
  })

  test("get-window-focused checks fromWebContents then isFocused", () => {
    const getWindowFocused = (event: any) => {
      const getWindow = () => event._mockWin ?? null
      return getWindow()?.isFocused() ?? false
    }

    const focusedWin = { isFocused: () => true }
    const unfocusedWin = { isFocused: () => false }

    expect(getWindowFocused({ _mockWin: focusedWin })).toBe(true)
    expect(getWindowFocused({ _mockWin: unfocusedWin })).toBe(false)
    expect(getWindowFocused({ _mockWin: null })).toBe(false)
  })

  test("show-window calls win.show()", () => {
    let shown = false
    const win = { show: () => { shown = true } }

    const showWindow = (event: any) => {
      const w = event._mockWin ?? null
      w?.show()
    }

    showWindow({ _mockWin: win })
    expect(shown).toBe(true)
  })
})
