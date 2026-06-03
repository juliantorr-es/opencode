import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { IPC_METHOD_REGISTRY } from "./ipc-contract"

export const registeredIpcHandlers = new Set<string>()
export const registeredLegacyIpcHandlers = new Set<string>()

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  if (!event.sender || event.sender.isDestroyed()) {
    throw new Error("Invalid IPC sender")
  }
}

export function registerIpcHandler(
  channel: string,
  handler: Parameters<typeof ipcMain.handle>[1],
  options?: { legacyAlias?: string },
): void {
  if (registeredIpcHandlers.has(channel)) {
    throw new Error(`Duplicate IPC handler registration: ${channel}`)
  }
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event)
    return await (handler as (...args: unknown[]) => unknown)(event, ...args)
  })
  registeredIpcHandlers.add(channel)
  if (options?.legacyAlias) {
    ipcMain.handle(options.legacyAlias, async (event, ...args) => {
      assertTrustedIpcSender(event)
      return await (handler as (...args: unknown[]) => unknown)(event, ...args)
    })
    registeredLegacyIpcHandlers.add(options.legacyAlias)
  }
}

export function validateRegisteredIpcHandlers(): string[] {
  const expected = new Set(IPC_METHOD_REGISTRY.map((entry) => entry.channel))
  const issues: string[] = []
  for (const channel of expected) {
    if (!registeredIpcHandlers.has(channel)) {
      issues.push(`IPC_METHOD_REGISTRY entry "${channel}" has no ipcMain.handle registration`)
    }
  }
  for (const channel of registeredIpcHandlers) {
    if (!expected.has(channel)) {
      issues.push(`Registered handler "${channel}" has no IPC_METHOD_REGISTRY entry`)
    }
  }
  return issues
}
