import { registerIpcHandler } from "./ipc-registration"
import { IPC } from "./ipc-channels"
import { withIpcResult } from "./ipc-contract"

export interface DesktopCapabilities {
  github: boolean
  plugins: boolean
  mcp: boolean
  shellOpen: boolean
  clipboardImage: boolean
  notifications: boolean
}

export function getCapabilities(): DesktopCapabilities {
  return {
    github: true,
    plugins: true,
    mcp: true,
    shellOpen: true,
    clipboardImage: true,
    notifications: true,
  }
}

export function registerCapabilitiesIpcHandlers() {
  registerIpcHandler(IPC.handle.GET_CAPABILITIES, async () => {
    return withIpcResult("capabilities.get", async () => getCapabilities())
  })
}
