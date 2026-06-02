import { ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { IPC } from "./ipc-channels"
import { withIpcResult } from "./ipc-contract"
import { serializedWrite } from "./ipc-helpers"
import {
  validateAndFilterAgents,
  validateAndFilterMcpServers,
  validateAndFilterPluginConfigs,
} from "./ipc-validation"
import { getStore } from "./store"

export function registerConfigIpcHandlers() {
  ipcMain.handle(IPC.handle.GET_DESKTOP_CUSTOM_AGENTS, () => {
    return withIpcResult("config.getDesktopCustomAgents", async () => {
      try {
        const store = getStore("desktop-custom-agents")
        return validateAndFilterAgents(store.get("agents"))
      } catch (e) {
        console.error("get-desktop-custom-agents failed:", e)
        throw e
      }
    })
  })

  ipcMain.handle(IPC.handle.SET_DESKTOP_CUSTOM_AGENTS, async (_event: IpcMainInvokeEvent, agents: unknown[]) => {
    return withIpcResult("config.setDesktopCustomAgents", async () => {
      try {
        const store = getStore("desktop-custom-agents")
        await serializedWrite("desktop-custom-agents", () => {
          store.set("agents", validateAndFilterAgents(agents))
        })
      } catch (e) {
        console.error("set-desktop-custom-agents failed:", e)
        throw e
      }
    })
  })

  ipcMain.handle(IPC.handle.DELETE_DESKTOP_CUSTOM_AGENT, async (_event: IpcMainInvokeEvent, id: string) => {
    return withIpcResult("config.deleteDesktopCustomAgent", async () => {
      try {
        const store = getStore("desktop-custom-agents")
        await serializedWrite("desktop-custom-agents", () => {
          const agents = validateAndFilterAgents(store.get("agents"))
          store.set(
            "agents",
            agents.filter((a: { id?: string }) => a.id !== id),
          )
        })
      } catch (e) {
        console.error("delete-desktop-custom-agent failed:", e)
        throw e
      }
    })
  })

  ipcMain.handle(IPC.handle.GET_DESKTOP_MCP_SERVERS, () => {
    return withIpcResult("config.getDesktopMcpServers", async () => {
      try {
        const store = getStore("desktop-mcp-servers")
        const v = validateAndFilterMcpServers(store.get("servers"))
        return v.servers
      } catch (e) {
        console.error("get-desktop-mcp-servers failed:", e)
        throw e
      }
    })
  })

  ipcMain.handle(IPC.handle.SET_DESKTOP_MCP_SERVERS, async (_event: IpcMainInvokeEvent, servers: unknown[]) => {
    return withIpcResult("config.setDesktopMcpServers", async () => {
      try {
        const store = getStore("desktop-mcp-servers")
        await serializedWrite("desktop-mcp-servers", () => {
          const v = validateAndFilterMcpServers(servers)
          store.set("servers", v.servers)
          return v
        })
      } catch (e) {
        console.error("set-desktop-mcp-servers failed:", e)
        throw e
      }
    })
  })

  ipcMain.handle(IPC.handle.GET_DESKTOP_PLUGIN_CONFIG, () => {
    return withIpcResult("config.getDesktopPluginConfig", async () => {
      try {
        const store = getStore("desktop-plugin-config")
        const v = validateAndFilterPluginConfigs(store.get("configs"))
        return v
      } catch (e) {
        console.error("get-desktop-plugin-config failed:", e)
        throw e
      }
    })
  })

  ipcMain.handle(IPC.handle.SET_DESKTOP_PLUGIN_CONFIG, async (_event: IpcMainInvokeEvent, configs: unknown[]) => {
    return withIpcResult("config.setDesktopPluginConfig", async () => {
      try {
        const store = getStore("desktop-plugin-config")
        const result = await serializedWrite("desktop-plugin-config", () => {
          const v = validateAndFilterPluginConfigs(configs)
          store.set("configs", v.configs)
          return v
        })
        return result
      } catch (e) {
        console.error("set-desktop-plugin-config failed:", e)
        throw e
      }
    })
  })
}
