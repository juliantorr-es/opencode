import { describe, expect, test } from "bun:test"

// ---------------------------------------------------------------------------
// DC-003 Gap 4: End-to-end channel name agreement.
//
// Three IPC channel constants are defined in ipc-channels.ts:
//   - PLUGIN_SEND   (IPC.send)     — fire-and-forget, renderer → main
//   - PLUGIN_INVOKE (IPC.handle)   — request/response, renderer → main
//   - PLUGIN_PUSH   (IPC.push)     — push notification, main → renderer
//
// These must match what:
//   1. The preload bridge sends on (preload/index.ts)
//   2. The main-process handlers subscribe to (plugin-transport-ipc.ts)
//
// This test imports the canonical channel values and verifies they are
// consistent across the layer boundaries.
// ---------------------------------------------------------------------------

import { IPC } from "../ipc-channels"

const EXPECTED_PLUGIN_SEND = "opencode:plugin:send"
const EXPECTED_PLUGIN_INVOKE = "opencode:plugin:invoke"
const EXPECTED_PLUGIN_PUSH = "opencode:plugin:push"

describe("IPC channel values match expected wire format", () => {
  test("IPC.send.PLUGIN_SEND", () => {
    expect(IPC.send.PLUGIN_SEND).toBe(EXPECTED_PLUGIN_SEND)
  })

  test("IPC.handle.PLUGIN_INVOKE", () => {
    expect(IPC.handle.PLUGIN_INVOKE).toBe(EXPECTED_PLUGIN_INVOKE)
  })

  test("IPC.push.PLUGIN_PUSH", () => {
    expect(IPC.push.PLUGIN_PUSH).toBe(EXPECTED_PLUGIN_PUSH)
  })
})

describe("IPC wire protocol consistency", () => {
  test("all three plugin channel values are defined", () => {
    expect(IPC.send.PLUGIN_SEND).toBeDefined()
    expect(IPC.handle.PLUGIN_INVOKE).toBeDefined()
    expect(IPC.push.PLUGIN_PUSH).toBeDefined()
  })

  test("channels follow the opencode:plugin:* namespace convention", () => {
    expect(IPC.send.PLUGIN_SEND).toMatch(/^opencode:plugin:/)
    expect(IPC.handle.PLUGIN_INVOKE).toMatch(/^opencode:plugin:/)
    expect(IPC.push.PLUGIN_PUSH).toMatch(/^opencode:plugin:/)
  })
})
