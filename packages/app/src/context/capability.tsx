import { createMemo, createResource, type Accessor } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { usePlatform } from "./platform"
import { useServer } from "./server"
import { useLanguage } from "./language"
import { useServerSDK } from "./server-sdk"

export type CapabilityState = { available: boolean; reason?: string }

export type RuntimeCapabilities = {
  platformMode: "desktop" | "web"
  backendAvailability: CapabilityState
  localFilesystem: CapabilityState
  terminalRuntime: CapabilityState
  browserAutomation: CapabilityState
  workspaceMode: CapabilityState
  syncMode: CapabilityState
  permissionMode: CapabilityState
}

export const { use: useCapabilities, provider: CapabilityProvider } = createSimpleContext({
  name: "Capability",
  init: () => {
    const platform = usePlatform()
    const server = useServer()
    const language = useLanguage()

    const platformMode = createMemo(() => platform.platform)

    const backendAvailability = createMemo<CapabilityState>(() => {
      const isLocal = server.isLocal()
      if (!isLocal && platformMode() === "web") {
        return { available: false, reason: language.t("capability.reason.backendUnavailable") || "Backend unavailable" }
      }
      return { available: true }
    })

    const localFilesystem = createMemo<CapabilityState>(() => {
      if (platformMode() !== "desktop") {
        return { available: false, reason: language.t("capability.reason.desktopOnly") || "Requires Desktop Mode" }
      }
      return { available: true }
    })

    const terminalRuntime = createMemo<CapabilityState>(() => {
      if (platformMode() !== "desktop" && !server.isLocal()) {
        return { available: false, reason: language.t("capability.reason.browserSandbox") || "Browser sandbox only" }
      }
      return { available: true }
    })

    const browserAutomation = createMemo<CapabilityState>(() => {
      if (platformMode() !== "desktop") {
        return { available: false, reason: language.t("capability.reason.desktopOnly") || "Requires Desktop Mode" }
      }
      // Placeholder until actual backend check
      return { available: false, reason: language.t("capability.reason.playwrightNotConfigured") || "Playwright not configured" }
    })

    const workspaceMode = createMemo<CapabilityState>(() => {
      if (platformMode() !== "desktop") {
         return { available: false, reason: language.t("capability.reason.desktopOnly") || "Requires Desktop Mode" }
      }
      return { available: true }
    })

    const syncMode = createMemo<CapabilityState>(() => {
      if (!server.isLocal() && platformMode() === "web") {
        return { available: false, reason: language.t("capability.reason.backendUnavailable") || "Backend unavailable" }
      }
      return { available: true }
    })

    const permissionMode = createMemo<CapabilityState>(() => {
      // Permission mode always available, but might be sandboxed
      return { available: true }
    })

    const get: Accessor<RuntimeCapabilities> = () => ({
      platformMode: platformMode(),
      backendAvailability: backendAvailability(),
      localFilesystem: localFilesystem(),
      terminalRuntime: terminalRuntime(),
      browserAutomation: browserAutomation(),
      workspaceMode: workspaceMode(),
      syncMode: syncMode(),
      permissionMode: permissionMode(),
    })

    return get
  },
})

export function useSessionCapabilities(sessionID: Accessor<string> | string) {
  const sdk = useServerSDK()
  const id = typeof sessionID === "function" ? sessionID : () => sessionID

  const [data, { refetch }] = createResource(
    () => id(),
    async (sessionID) => {
      if (!sessionID) return null
      try {
        const res = await sdk.client.session.capabilities({ sessionID })
        return res.data ?? null
      } catch (e) {
        console.error("Failed to fetch session capabilities:", e)
        return null
      }
    }
  )

  return {
    data,
    refetch,
  }
}

export function useSessionAuthorityReceipts(sessionID: Accessor<string> | string) {
  const sdk = useServerSDK()
  const id = typeof sessionID === "function" ? sessionID : () => sessionID

  const [data, { refetch }] = createResource(
    () => id(),
    async (sessionID) => {
      if (!sessionID) return []
      try {
        const res = await sdk.client.session.authorityReceipts({ sessionID })
        return res.data ?? []
      } catch (e) {
        console.error("Failed to fetch session authority receipts:", e)
        return []
      }
    }
  )

  return {
    data,
    refetch,
  }
}

