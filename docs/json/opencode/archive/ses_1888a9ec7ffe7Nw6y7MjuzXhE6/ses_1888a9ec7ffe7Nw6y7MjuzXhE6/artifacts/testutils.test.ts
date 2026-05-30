import { describe, expect, test } from "bun:test"
import {
  createMockIpcMainInvokeEvent,
  createMockIpcMainEvent,
  createMockWebContents,
  createMockBrowserWindow,
} from "../src/test-utils/electron-mock"

describe("createMockWebContents", () => {
  test("creates a web contents with default values", () => {
    const wc = createMockWebContents()
    expect(wc.id).toBe(1)
    expect(wc.getZoomFactor()).toBe(1)
    expect(wc.getURL()).toBe("https://app.opencode.ai")
  })

  test("allows overriding properties", () => {
    const wc = createMockWebContents({
      getZoomFactor: () => 2.5,
    })
    expect(wc.getZoomFactor()).toBe(2.5)
  })

  test("send can be called without errors", () => {
    const wc = createMockWebContents()
    expect(() => wc.send("channel", "data")).not.toThrow()
  })
})

describe("createMockBrowserWindow", () => {
  test("creates a window with default values", () => {
    const win = createMockBrowserWindow()
    expect(win.id).toBe(1)
    expect(win.isDestroyed()).toBe(false)
    expect(win.isFocused()).toBe(true)
  })

  test("allows overriding methods", () => {
    const win = createMockBrowserWindow({
      isFocused: () => false,
      isDestroyed: () => true,
    })
    expect(win.isFocused()).toBe(false)
    expect(win.isDestroyed()).toBe(true)
  })

  test("focus can be called without errors", () => {
    const win = createMockBrowserWindow()
    expect(() => win.focus()).not.toThrow()
  })

  test("show can be called without errors", () => {
    const win = createMockBrowserWindow()
    expect(() => win.show()).not.toThrow()
  })

  test("setBackgroundColor can be called without errors", () => {
    const win = createMockBrowserWindow()
    expect(() => win.setBackgroundColor("#fff")).not.toThrow()
  })
})

describe("createMockIpcMainInvokeEvent", () => {
  test("creates an invoke event with default properties", () => {
    const event = createMockIpcMainInvokeEvent()
    expect(event.frameId).toBe(1)
    expect(event.processId).toBe(1)
    expect(typeof event.sender.send).toBe("function")
  })

  test("the reply function can be called", () => {
    const event = createMockIpcMainInvokeEvent()
    expect(() => event.reply("channel")).not.toThrow()
  })

  test("allows overriding sender", () => {
    const sender = createMockWebContents({ getZoomFactor: () => 3.0 })
    const event = createMockIpcMainInvokeEvent(sender)
    expect(event.sender.getZoomFactor()).toBe(3.0)
  })
})

describe("createMockIpcMainEvent", () => {
  test("creates an event with default properties", () => {
    const event = createMockIpcMainEvent()
    expect(event.frameId).toBe(1)
    expect(typeof event.sender.send).toBe("function")
  })

  test("reply can be called without errors", () => {
    const event = createMockIpcMainEvent()
    expect(() => event.reply("reply-channel", "data")).not.toThrow()
  })
})
