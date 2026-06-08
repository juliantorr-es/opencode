import { describe, expect, test } from "bun:test"
import type { PluginTransport, DesktopPluginApi } from "@tribunus/plugin/desktop"

// ---------------------------------------------------------------------------
// DC-003 Gap 1: PluginTransport type exported from @tribunus/plugin/desktop
//
// PluginTransport is an interface (compile-time type), so we verify the
// structural contract at runtime — any object conforming to the interface
// must expose the 5 required methods with the correct signatures.
// ---------------------------------------------------------------------------

// Compile-time type assertion: PluginTransport is the canonical production type.
// eslint-disable-next-line @typescript-eslint/no-unused-vars — type-only check
const _verify: PluginTransport = null as unknown as PluginTransport

function createTestTransport(): PluginTransport {
  return {
    send() {},
    async invoke() {
      return undefined
    },
    on() {
      return () => {}
    },
    off() {},
    destroy() {},
  }
}

describe("PluginTransport contract", () => {
  test("transport object has all 5 required methods", () => {
    const t = createTestTransport()
    expect(typeof t.send).toBe("function")
    expect(typeof t.invoke).toBe("function")
    expect(typeof t.on).toBe("function")
    expect(typeof t.off).toBe("function")
    expect(typeof t.destroy).toBe("function")
  })

  test("send accepts channel string and optional data", () => {
    const t = createTestTransport()
    expect(() => t.send("test-channel")).not.toThrow()
    expect(() => t.send("test-channel", { key: "value" })).not.toThrow()
  })

  test("invoke returns a Promise", () => {
    const t = createTestTransport()
    const result = t.invoke("test-channel")
    expect(result).toBeInstanceOf(Promise)
  })

  test("invoke resolves to a value", async () => {
    const t = createTestTransport()
    const result = await t.invoke("test-channel")
    expect(result).toBeUndefined()
  })

  test("on returns an unsubscribe function", () => {
    const t = createTestTransport()
    const handler = (_data: unknown) => {}
    const unsub = t.on("test-channel", handler)
    expect(typeof unsub).toBe("function")
    expect(() => unsub()).not.toThrow()
  })

  test("off accepts channel and handler without throwing", () => {
    const t = createTestTransport()
    const handler = (_data: unknown) => {}
    expect(() => t.off("test-channel", handler)).not.toThrow()
  })

  test("destroy does not throw", () => {
    const t = createTestTransport()
    expect(() => t.destroy()).not.toThrow()
  })

  test("DesktopPluginApi accepts optional transport field", () => {
    const transport = createTestTransport()
    const api: DesktopPluginApi = {
      slots: {
        register: () => () => {},
      },
      store: {
        get: () => undefined,
        set: () => {},
      },
      lifecycle: {
        onDispose: () => {},
      },
      transport,
    }
    expect(api.transport).toBeDefined()
    expect(api.transport).toBe(transport)
  })
})
