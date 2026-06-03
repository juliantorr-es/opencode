import { registerIpcHandler } from "./ipc-registration"
import type { IpcMainInvokeEvent } from "electron"
import { IPC } from "./ipc-channels"
import { withIpcResult } from "./ipc-contract"
import { getStore } from "./store"

const RESERVED_STORE_NAMES: readonly string[] = [
  IPC.store.DESKTOP_CUSTOM_AGENTS,
  IPC.store.DESKTOP_MCP_SERVERS,
  IPC.store.DESKTOP_PLUGIN_CONFIG,
  IPC.store.GITHUB_AUTH,
]

function checkReserved(name: string) {
  if (RESERVED_STORE_NAMES.includes(name)) {
    throw new Error(`Access denied: '${name}' is a reserved store namespace`)
  }
}

export function registerStoreIpcHandlers() {
  registerIpcHandler(IPC.handle.STORE_GET, (_event: IpcMainInvokeEvent, name: string, key: string) => {
    return withIpcResult("store.get", async () => {
      checkReserved(name)
      try {
        const store = getStore(name)
        const value = store.get(key)
        if (value === undefined || value === null) return null
        return typeof value === "string" ? value : JSON.stringify(value)
      } catch {
        return null
      }
    })
  })
  registerIpcHandler(IPC.handle.STORE_SET, (_event: IpcMainInvokeEvent, name: string, key: string, value: unknown) => {
    return withIpcResult("store.set", async () => {
      checkReserved(name)
      const store = getStore(name)
      store.set(key, value)
    })
  })
  registerIpcHandler(IPC.handle.STORE_DELETE, (_event: IpcMainInvokeEvent, name: string, key: string) => {
    return withIpcResult("store.delete", async () => {
      checkReserved(name)
      const store = getStore(name)
      store.delete(key)
    })
  })
  registerIpcHandler(IPC.handle.STORE_CLEAR, (_event: IpcMainInvokeEvent, name: string) => {
    return withIpcResult("store.clear", async () => {
      checkReserved(name)
      const store = getStore(name)
      store.clear()
    })
  })
  registerIpcHandler(IPC.handle.STORE_KEYS, (_event: IpcMainInvokeEvent, name: string) => {
    return withIpcResult("store.keys", async () => {
      checkReserved(name)
      const store = getStore(name)
      return Object.keys(store.store)
    })
  })
  registerIpcHandler(IPC.handle.STORE_LENGTH, (_event: IpcMainInvokeEvent, name: string) => {
    return withIpcResult("store.length", async () => {
      checkReserved(name)
      const store = getStore(name)
      return Object.keys(store.store).length
    })
  })
}
