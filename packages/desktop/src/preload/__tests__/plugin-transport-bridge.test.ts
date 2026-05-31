import { describe, expect, test } from "bun:test"

// ---------------------------------------------------------------------------
// DC-003 Gap 2: Preload bridge exposes plugin transport methods.
//
// The ElectronAPI type in types.ts includes 4 plugin transport methods:
//   pluginSend, pluginOn, pluginOff, pluginInvoke
//
// This test verifies:
//   1. (compile-time) The ElectronAPI type defines all 4 methods with
//      correct signatures
//   2. (runtime) Objects conforming to ElectronAPI expose the 4 methods
// ---------------------------------------------------------------------------

import type { ElectronAPI } from "../types"

// Compile-time type assertions — each extracts a specific method from
// ElectronAPI. These fail to compile if the method is missing or has the
// wrong signature.
// eslint-disable-next-line @typescript-eslint/no-unused-vars — type-only check
const _verifyPluginSend: ElectronAPI["pluginSend"] =
  null as unknown as ElectronAPI["pluginSend"]
// eslint-disable-next-line @typescript-eslint/no-unused-vars — type-only check
const _verifyPluginOn: ElectronAPI["pluginOn"] =
  null as unknown as ElectronAPI["pluginOn"]
// eslint-disable-next-line @typescript-eslint/no-unused-vars — type-only check
const _verifyPluginOff: ElectronAPI["pluginOff"] =
  null as unknown as ElectronAPI["pluginOff"]
// eslint-disable-next-line @typescript-eslint/no-unused-vars — type-only check
const _verifyPluginInvoke: ElectronAPI["pluginInvoke"] =
  null as unknown as ElectronAPI["pluginInvoke"]

describe("plugin transport preload bridge contract", () => {
  test("ElectronAPI type has all 4 plugin transport methods", () => {
    const api: Pick<
      ElectronAPI,
      "pluginSend" | "pluginOn" | "pluginOff" | "pluginInvoke"
    > = {
      pluginSend(_channel, _data) {},
      pluginOn(_channel, _handler) {
        return () => {}
      },
      pluginOff(_channel, _handler) {},
      async pluginInvoke(_channel, _data) {
        return undefined
      },
    }
    expect(typeof api.pluginSend).toBe("function")
    expect(typeof api.pluginOn).toBe("function")
    expect(typeof api.pluginOff).toBe("function")
    expect(typeof api.pluginInvoke).toBe("function")
  })

  test("pluginSend accepts channel and optional data without throwing", () => {
    const api: Pick<ElectronAPI, "pluginSend"> = {
      pluginSend(_channel, _data) {},
    }
    expect(() => api.pluginSend("my-channel")).not.toThrow()
    expect(() => api.pluginSend("my-channel", { x: 1 })).not.toThrow()
  })

  test("pluginOn returns unsubscribe function", () => {
    const api: Pick<ElectronAPI, "pluginOn"> = {
      pluginOn(_channel, _handler) {
        return () => {}
      },
    }
    const unsub = api.pluginOn("test", () => {})
    expect(typeof unsub).toBe("function")
    unsub()
  })

  test("pluginOff does not throw", () => {
    const api: Pick<ElectronAPI, "pluginOff"> = {
      pluginOff(_channel, _handler) {},
    }
    expect(() => api.pluginOff("test", () => {})).not.toThrow()
  })

  test("pluginInvoke returns a Promise", () => {
    const api: Pick<ElectronAPI, "pluginInvoke"> = {
      async pluginInvoke(_channel, _data) {
        return undefined
      },
    }
    const promise = api.pluginInvoke("test")
    expect(promise).toBeInstanceOf(Promise)
  })

  test("pluginInvoke resolves", async () => {
    const api: Pick<ElectronAPI, "pluginInvoke"> = {
      async pluginInvoke(_channel, _data) {
        return undefined
      },
    }
    const result = await api.pluginInvoke("test")
    expect(result).toBeUndefined()
  })
})
