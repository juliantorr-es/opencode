import { beforeEach, describe, expect, mock, test } from "bun:test"
import { browserApi, installBrowserApi } from "./browser-api"

beforeEach(() => {
  // Remove window.api before each test so the install is clean
  delete (window as unknown as Record<string, unknown>).api
  localStorage.removeItem("opencode-custom-agents")
  localStorage.removeItem("opencode-mcp-servers")
  localStorage.removeItem("opencode-default-server-url")
})

describe("installBrowserApi", () => {
  test("does not throw", () => {
    expect(installBrowserApi).not.toThrow()
  })

  test("defines window.api after installation", () => {
    installBrowserApi()
    expect((window as unknown as Record<string, unknown>).api).toBeDefined()
  })

  test("does not override an existing api", () => {
    const sentinel = { __TEST__: true }
    ;(window as unknown as Record<string, unknown>).api = sentinel
    installBrowserApi()
    expect((window as unknown as Record<string, unknown>).api).toBe(sentinel)
  })

  test("is idempotent — calling twice does not error", () => {
    installBrowserApi()
    expect(installBrowserApi).not.toThrow()
  })
})

describe("browserApi method signatures", () => {
  test("setTitlebar resolves without error", async () => {
    await expect(browserApi.setTitlebar?.({ mode: "dark" })).resolves.toBeUndefined()
    await expect(browserApi.setTitlebar?.({ mode: "light" })).resolves.toBeUndefined()
  })

  test("exportDebugLogs returns a message string", async () => {
    const result = await browserApi.exportDebugLogs?.()
    expect(result).toBeTypeOf("string")
    expect(result).toContain("browser")
  })

  test("getCustomAgents returns an empty array", async () => {
    const result = await browserApi.getCustomAgents?.()
    expect(result).toEqual([])
  })

  test("setCustomAgents persists and deleteCustomAgent removes by id", async () => {
    const agents = [
      { id: "agent-1", name: "Agent 1", prompt: "Do work" },
      { id: "agent-2", name: "Agent 2", prompt: "Do work" },
    ]
    await expect(browserApi.setCustomAgents?.(agents)).resolves.toBeUndefined()
    await expect(browserApi.getCustomAgents?.()).resolves.toEqual(agents)
    await expect(browserApi.deleteCustomAgent?.("agent-1")).resolves.toBeUndefined()
    await expect(browserApi.getCustomAgents?.()).resolves.toEqual([agents[1]])
  })

  test("getMcpServers returns an empty array", async () => {
    const result = await browserApi.getMcpServers?.()
    expect(result).toEqual([])
  })

  test("setMcpServers persists server entries", async () => {
    const servers = [{ name: "mcp-1", config: { type: "remote", url: "http://localhost", enabled: true } }]
    await expect(browserApi.setMcpServers?.(servers)).resolves.toBeUndefined()
    await expect(browserApi.getMcpServers?.()).resolves.toEqual(servers)
  })

  test("recordFatalRendererError resolves without error", async () => {
    await expect(
      browserApi.recordFatalRendererError?.({
        error: "test error",
        url: "http://localhost",
        platform: "web",
      }),
    ).resolves.toBeUndefined()
  })

  test("checkUpdate returns no update available", async () => {
    const result = await browserApi.checkUpdate?.()
    expect(result).toEqual({ updateAvailable: false, version: undefined })
  })

  test("installUpdate resolves without error", async () => {
    await expect(browserApi.installUpdate?.()).resolves.toBeUndefined()
  })

  test("runUpdater resolves without error", async () => {
    await expect(browserApi.runUpdater?.(false)).resolves.toBeUndefined()
  })

  test("openDirectoryPickerDialog returns null", async () => {
    const result = await browserApi.openDirectoryPickerDialog?.()
    expect(result).toBeNull()
  })
})

describe("data retrieval methods return null", () => {
  test("getDependencyStatus returns null", async () => {
    const result = await browserApi.getDependencyStatus?.()
    expect(result).toBeNull()
  })

  test("getGitStatus returns null", async () => {
    const result = await browserApi.getGitStatus?.()
    expect(result).toBeNull()
  })

  test("getSessionMemory returns null", async () => {
    const result = await browserApi.getSessionMemory?.()
    expect(result).toBeNull()
  })

  test("getTestStatus returns null", async () => {
    const result = await browserApi.getTestStatus?.()
    expect(result).toBeNull()
  })

  test("getPullRequestStatus returns null", async () => {
    const result = await browserApi.getPullRequestStatus?.()
    expect(result).toBeNull()
  })
})

describe("storage methods", () => {
  test("storeGet returns null", async () => {
    const result = await browserApi.storeGet?.("test", "key")
    expect(result).toBeNull()
  })

  test("storeSet resolves without error", async () => {
    await expect(browserApi.storeSet?.("test", "key", "value")).resolves.toBeUndefined()
  })

  test("storeDelete resolves without error", async () => {
    await expect(browserApi.storeDelete?.("test", "key")).resolves.toBeUndefined()
  })

  test("storeClear resolves without error", async () => {
    await expect(browserApi.storeClear?.("test")).resolves.toBeUndefined()
  })

  test("storeKeys returns an empty array", async () => {
    const result = await browserApi.storeKeys?.("test")
    expect(result).toEqual([])
  })
})

describe("server URL methods", () => {
  test("getDefaultServerUrl returns null", async () => {
    const result = await browserApi.getDefaultServerUrl?.()
    expect(result).toBeNull()
  })

  test("setDefaultServerUrl resolves without error", async () => {
    await expect(browserApi.setDefaultServerUrl?.("http://localhost")).resolves.toBeUndefined()
    await expect(browserApi.setDefaultServerUrl?.(null)).resolves.toBeUndefined()
  })
})

describe("GitHub OAuth", () => {
  test("githubOAuthCallback resolves without error", async () => {
    await expect(browserApi.githubOAuthCallback?.("code", "state")).resolves.toBeUndefined()
  })
})

describe("locale methods", () => {
  test("getLocalePreference returns null", async () => {
    const result = await browserApi.getLocalePreference?.()
    expect(result).toBeNull()
  })

  test("setLocalePreference resolves without error", async () => {
    await expect(browserApi.setLocalePreference?.("en")).resolves.toBeUndefined()
  })
})

describe("window methods", () => {
  test("getWindowConfig returns updaterEnabled: false", async () => {
    const result = await browserApi.getWindowConfig?.()
    expect(result).toEqual({ updaterEnabled: false })
  })

  test("getWindowFocused returns a boolean", async () => {
    const result = await browserApi.getWindowFocused?.()
    expect(result).toBeTypeOf("boolean")
  })

  test("setWindowFocus resolves without error", async () => {
    await expect(browserApi.setWindowFocus?.()).resolves.toBeUndefined()
  })

  test("showWindow resolves without error", async () => {
    await expect(browserApi.showWindow?.()).resolves.toBeUndefined()
  })
})

describe("session export/import", () => {
  test("sessionExportData resolves with data string on success", async () => {
    // This triggers a Blob download, which works in HappyDOM
    const result = await browserApi.sessionExportData?.('{"test":true}')
    expect(result).not.toBeNull()
  })

  test("sessionImportFile returns a Promise", () => {
    const result = browserApi.sessionImportFile?.()
    expect(result).toBeInstanceOf(Promise)
  })
})

describe("openLink", () => {
  test("calls window.open with _blank", () => {
    const original = globalThis.open
    const mockOpen = mock<(url?: string | URL | undefined, target?: string | undefined, features?: string | undefined) => Window | null>()
    globalThis.open = mockOpen

    try {
      browserApi.openLink?.("https://example.com")
      expect(mockOpen).toHaveBeenCalledTimes(1)
      expect(mockOpen).toHaveBeenCalledWith("https://example.com", "_blank")
    } finally {
      globalThis.open = original
    }
  })
})

describe("notification", () => {
  test("showNotification does not throw when Notification is unavailable", () => {
    // HappyDOM does not have Notification, so this should be a no-op
    expect(() => browserApi.showNotification?.("Test", "Body")).not.toThrow()
  })
})

describe("event subscription methods", () => {
  test("onDeepLink returns a cleanup function", () => {
    const cleanup = browserApi.onDeepLink?.(() => {})
    expect(cleanup).toBeTypeOf("function")
    expect(cleanup).not.toThrow()
  })

  test("onMenuCommand returns a cleanup function", () => {
    const cleanup = browserApi.onMenuCommand?.(() => {})
    expect(cleanup).toBeTypeOf("function")
    expect(cleanup).not.toThrow()
  })
})

describe("promise methods return proper types", () => {
  const asyncMethods = [
    "setTitlebar",
    "exportDebugLogs",
    "getCustomAgents",
    "setCustomAgents",
    "deleteCustomAgent",
    "getMcpServers",
    "setMcpServers",
    "recordFatalRendererError",
    "storeGet",
    "storeSet",
    "storeDelete",
    "storeClear",
    "storeKeys",
    "checkUpdate",
    "installUpdate",
    "runUpdater",
    "getDefaultServerUrl",
    "setDefaultServerUrl",
    "githubOAuthCallback",
    "getDependencyStatus",
    "getGitStatus",
    "getSessionMemory",
    "getTestStatus",
    "getPullRequestStatus",
    "getWindowConfig",
    "setLocalePreference",
    "getLocalePreference",
    "getWindowFocused",
    "setWindowFocus",
    "showWindow",
    "openDirectoryPickerDialog",
  ] as const

  for (const method of asyncMethods) {
    test(`${method} returns a Promise when called`, () => {
      const fn = browserApi[method as keyof typeof browserApi]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callable = fn as ((...args: any[]) => unknown) | undefined
      if (callable) {
        const result = callable()
        expect(result).toBeInstanceOf(Promise)
      }
    })
  }
})
