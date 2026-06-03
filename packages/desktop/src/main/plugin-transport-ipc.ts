/**
 * Plugin transport IPC handlers — main process side.
 *
 * Registers ipcMain handlers for plugin transport channels following
 * the same pattern as ipc-store.ts, ipc-init.ts, etc.
 *
 * Channels:
 *   PLUGIN_SEND   — fire-and-forget from renderer (ipcMain.on)
 *   PLUGIN_INVOKE — request/response RPC from renderer (ipcMain.handle)
 *   PLUGIN_PUSH   — push from main to renderer (webContents.send)
 */

import { type BrowserWindow, ipcMain } from "electron"
import { registerIpcHandler } from "./ipc-registration"
import { IPC } from "./ipc-channels"
import { withIpcResult } from "./ipc-contract"
/**
 * Register all plugin transport IPC handlers.
 * Must be called from registerIpcHandlers() in ipc.ts.
 */
export function registerPluginTransportIpcHandlers(): void {
  // Renderer → Main: fire-and-forget plugin message
  ipcMain.on(IPC.send.PLUGIN_SEND, (event, channel: string, data: unknown) => {
    if (!event.sender) return
    handlePluginMessage(channel, data)
  })

  // Renderer → Main: request/response plugin RPC
  registerIpcHandler(IPC.handle.PLUGIN_INVOKE, (_event, channel: string, data: unknown) => {
    return withIpcResult("plugin.invoke", async () => {
      return handlePluginInvoke(channel, data)
    })
  })
}

// ---------------------------------------------------------------------------
// Plugin message routing and forwarding
// ---------------------------------------------------------------------------

/** Registered handlers for fire-and-forget plugin messages */
const messageHandlers = new Map<string, Set<(channel: string, data: unknown) => void>>()

/** Registered handlers for plugin RPC (returns response data) */
const invokeHandlers = new Map<string, Set<(channel: string, data: unknown) => Promise<unknown>>>()

/**
 * Register a handler for fire-and-forget plugin messages.
 * Returns an unsubscribe function.
 */
export function onPluginMessage(
  channel: string,
  handler: (channel: string, data: unknown) => void,
): () => void {
  let set = messageHandlers.get(channel)
  if (!set) {
    set = new Set()
    messageHandlers.set(channel, set)
  }
  set.add(handler)
  return () => {
    set!.delete(handler)
    if (set!.size === 0) messageHandlers.delete(channel)
  }
}

/**
 * Register a handler for plugin RPC invocations.
 * Returns an unsubscribe function.
 */
export function onPluginInvoke(
  channel: string,
  handler: (channel: string, data: unknown) => Promise<unknown>,
): () => void {
  let set = invokeHandlers.get(channel)
  if (!set) {
    set = new Set()
    invokeHandlers.set(channel, set)
  }
  set.add(handler)
  return () => {
    set!.delete(handler)
    if (set!.size === 0) invokeHandlers.delete(channel)
  }
}

/**
 * Forward a plugin push message to all renderer windows.
 */
export function sendPluginPush(
  windows: BrowserWindow[],
  channel: string,
  data: unknown,
): void {
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.push.PLUGIN_PUSH, { channel, data })
    }
  }
}

/** Route a fire-and-forget message to registered handlers */
function handlePluginMessage(channel: string, data: unknown): void {
  const handlers = messageHandlers.get(channel)
  if (!handlers) return
  for (const handler of handlers) {
    try {
      handler(channel, data)
    } catch {
      // swallow per-handler errors
    }
  }
}

/** Route an RPC invocation to the first matching handler */
async function handlePluginInvoke(channel: string, data: unknown): Promise<unknown> {
  const handlers = invokeHandlers.get(channel)
  if (!handlers || handlers.size === 0) {
    throw new Error(`No handler registered for plugin RPC channel "${channel}"`)
  }
  // Call the first registered handler
  const handler = handlers.values().next().value
  if (handler) {
    return handler(channel, data)
  }
  throw new Error(`Handler for plugin RPC channel "${channel}" is undefined`)
}
