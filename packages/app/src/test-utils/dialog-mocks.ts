/**
 * Shared mock factories for @opencode-ai/ui components used in dialog tests.
 * Import and apply in beforeAll() before importing the dialog under test.
 *
 * These mocks avoid JSX compilation issues (bun test doesn't support SolidJS JSX)
 * and keep tests focused on dialog behavior rather than UI library rendering.
 */

import { mock } from "bun:test"
import * as solid from "solid-js/dist/solid.js"
import h from "solid-js/h/dist/h.js"

// ── Shared mock values ───────────────────────────────────────────────────

export interface MockProviders {
  useLanguage: () => { t: (key: string) => string; locale: () => string }
  usePlatform: () => Record<string, unknown>
  useSettings: () => { settings: Record<string, unknown>; update: () => void; general: { setReleaseNotes: () => void; setOnboarded: () => void } }
  useLocal: () => Record<string, unknown>
  useSync: () => Record<string, unknown>
  useSDK: () => Record<string, unknown>
  useProviders: () => Record<string, unknown>
  popularProviders: string[]
  useServerSDK: () => Record<string, unknown>
  useServerSync: () => Record<string, unknown>
  useDialog: () => { active: unknown; show: () => void; close: () => void }
  useCommand: () => Record<string, unknown>
  useServer: () => Record<string, unknown>
  usePrompt: () => Record<string, unknown>
  useLayout: () => Record<string, unknown>
  useFile: () => Record<string, unknown>
}

let _mockDefaults: MockProviders | null = null

export function getMockDefaults(): MockProviders {
  if (!_mockDefaults) {
    _mockDefaults = {
      useLanguage: () => ({ t: (key: string) => key, locale: () => "en" }),
      usePlatform: () => ({
        platform: "web",
        version: "1.0.0",
        fetch: async () => new Response(),
        openDirectoryPicker: async () => null,
        openFilePicker: async () => null,
        saveFilePicker: async () => null,
      }),
      useSettings: () => ({
        settings: {} as Record<string, unknown>,
        update: () => {},
        general: {
          setReleaseNotes: () => {},
          setOnboarded: () => {},
        },
        releaseNotes: () => null,
        setReleaseNotes: () => {},
      }),
      useLocal: () => ({
        local: () => ({}),
        setLocal: () => {},
        model: {
          list: () => [],
          providerList: () => [],
          providerModelList: () => [],
          current: () => undefined,
          setCurrent: () => {},
        },
      }),
      useSync: () => ({
        data: () => ({}),
        session: () => ({ messages: () => [], optimistic: () => [] }),
      }),
      useSDK: () => ({
        client: null,
        directory: () => "/",
        url: () => "",
        createClient: async () => null,
      }),
      useProviders: () => ({
        providers: () => [],
        connectedProviders: () => [],
        connect: async () => {},
        disconnect: async () => {},
        saveCustom: async () => {},
        refresh: async () => {},
        all: () => new Map(),
        default: () => undefined,
        popular: () => [],
        connected: () => [],
        paid: () => [],
      }),
      popularProviders: [],
      useServerSDK: () => ({
        client: null,
      }),
      useServerSync: () => ({
        child: () => ({}),
      }),
      useDialog: () => ({
        active: undefined,
        show: () => {},
        close: () => {},
      }),
      useCommand: () => ({
        commands: () => [],
        recentCommands: () => [],
        favoriteCommands: () => [],
        filtered: () => [],
        selected: () => null,
        execute: async () => {},
        filter: () => {},
        handleKeyDown: () => {},
        recents: [],
        options: [],
        favorites: [],
        trackUse: () => {},
        trigger: () => {},
        toggleFavorite: () => {},
      }),
      useServer: () => ({
        server: null,
        setServer: () => {},
        servers: () => [],
        addServer: async () => {},
        removeServer: async () => {},
      }),
      usePrompt: () => ({
        current: () => "",
        set: () => {},
        reset: () => {},
        context: () => ({}),
        messages: () => [],
      }),
      useLayout: () => ({
        tabs: () => [],
        setTabs: () => {},
        handoff: {},
      }),
      useFile: () => ({
        tree: () => ({}),
        children: () => [],
        expanded: () => new Set(),
        expand: () => {},
        collapse: () => {},
      }),
    }
  }
  return _mockDefaults
}

/**
 * Mock all @opencode-ai/ui components that dialog components import.
 * Must be called inside beforeAll().
 */
export function mockUiPrimitives(): void {
  // @opencode-ai/ui/dialog — renders [data-component="dialog"] wrapper
  mock.module("@opencode-ai/ui/dialog", () => {
    function Dialog(props: any) {
      const children: Array<any> = []
      if (props.title) children.push(h("div", { "data-slot": "dialog-header" }, h("h2", { "data-slot": "dialog-title" }, props.title)))
      if (props.description) children.push(h("div", { "data-slot": "dialog-description" }, props.description))
      children.push(h("div", { "data-slot": "dialog-body" }, props.children))
      return h("div", { "data-component": "dialog", "data-size": props.size || "normal", "data-fit": props.fit ? "" : undefined },
        h("div", { "data-slot": "dialog-container" },
          h("div", { "data-slot": "dialog-content" }, ...children.filter(Boolean)),
        ),
      )
    }
    return { Dialog }
  })

  // @opencode-ai/ui/button
  mock.module("@opencode-ai/ui/button", () => {
    function Button(props: any) {
      return h("button", {
        "data-component": "button",
        disabled: props.disabled,
        class: props.class || "",
        ref: (el: HTMLButtonElement) => {
          el.onclick = typeof props.onClick === "function" ? props.onClick : null
        },
      }, props.children)
    }
    return { Button }
  })

  // @opencode-ai/ui/icon-button
  mock.module("@opencode-ai/ui/icon-button", () => {
    function IconButton(props: any) {
      return h("button", {
        "data-component": "icon-button",
        "aria-label": props["aria-label"],
        ref: (el: HTMLButtonElement) => {
          el.onclick = typeof props.onClick === "function" ? props.onClick : null
        },
      }, props.children)
    }
    return { IconButton }
  })

  // Passive UI components (rendered but not tested)
  mock.module("@opencode-ai/ui/icon", () => ({ Icon: () => "" }))
  mock.module("@opencode-ai/ui/logo", () => ({ Splash: () => "" }))
  mock.module("@opencode-ai/ui/spinner", () => ({ Spinner: () => "" }))
  mock.module("@opencode-ai/ui/tooltip", () => ({ Tooltip: (p: any) => p.children || "" }))
  mock.module("@opencode-ai/ui/tag", () => ({ Tag: (p: any) => p.children || "" }))
  mock.module("@opencode-ai/ui/toast", () => ({ showToast: () => {} }))
  mock.module("@opencode-ai/ui/file-icon", () => ({ FileIcon: () => "" }))
  mock.module("@opencode-ai/ui/provider-icon", () => ({ ProviderIcon: () => "" }))
  mock.module("@opencode-ai/ui/avatar", () => ({ Avatar: () => "" }))
  mock.module("@opencode-ai/ui/keybind", () => ({ Keybind: () => "" }))

  // @opencode-ai/ui/list — handles items/each render-prop pattern
  mock.module("@opencode-ai/ui/list", () => {
    function List(props: any) {
      const rawItems = props.items
        ? typeof props.items === "function"
          ? props.items()
          : props.items
        : props.each
          ? typeof props.each === "function"
            ? props.each()
            : props.each
          : []
      if (rawItems && typeof rawItems[Symbol.iterator] === "function") {
        const itemsArr = Array.from(rawItems)
        if (itemsArr.length > 0 && typeof props.children === "function") {
          const rendered = itemsArr.map((item: any, index: number) => props.children(item, index))
          return h("div", { "data-component": "list" }, ...rendered)
        }
      }
      return h("div", { "data-component": "list", "data-empty": "true" })
    }
    return { List }
  })

  mock.module("@opencode-ai/ui/select", () => {
    function Select(props: any) { return h("div", { "data-component": "select" }, props.children) }
    return { Select }
  })
  mock.module("@opencode-ai/ui/text-field", () => {
    function TextField(props: any) {
      const children: Array<any> = []
      if (props.label) children.push(h("span", { "data-slot": "text-field-label" }, props.label))
      if (props.value) children.push(h("span", { "data-slot": "text-field-value" }, String(props.value)))
      if (props.children) children.push(...(Array.isArray(props.children) ? props.children : [props.children]))
      return h("div", { "data-component": "text-field" }, ...children)
    }
    return { TextField }
  })
  mock.module("@opencode-ai/ui/switch", () => ({ Switch: (p: any) => p.children || "" }))
  mock.module("@opencode-ai/ui/tabs", () => {
    function Tabs(p: any) { return p.children || "" }
    Tabs.List = (p: any) => p.children || ""
    Tabs.Content = (p: any) => p.children || ""
    Tabs.Trigger = (p: any) => p.children || ""
    Tabs.SectionTitle = (p: any) => p.children || ""
    return { Tabs }
  })
  mock.module("@opencode-ai/ui/dropdown-menu", () => ({ DropdownMenu: (p: any) => p.children || "" }))
  mock.module("@opencode-ai/ui/hooks", () => ({
    useFilteredList: () => ({
      filtered: () => [],
      filter: () => "",
      query: () => "",
      setQuery: () => {},
      active: () => null,
      grouped: () => [],
      setActive: () => {},
      onInput: () => {},
      onKeyDown: () => {},
    }),
  }))
  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: () => {
      const ctx = {} as Record<string, unknown>
      return {
        use: () => ({}),
        provider: (p: any) => p.children || "",
        Provider: (p: any) => p.children || "",
      }
    },
  }))
  mock.module("@opencode-ai/ui/theme/context", () => ({
    useTheme: () => ({ colorScheme: "light", setColorScheme: () => {}, theme: "system" }),
    ThemeProvider: (p: any) => p.children || "",
  }))
  mock.module("@/context/permission", () => ({
    usePermission: () => ({ enableAutoAccept: false }),
  }))
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => {},
    useParams: () => ({}),
  }))
  mock.module("@tanstack/solid-query", () => ({
    useQueryClient: () => ({}),
    useMutation: () => ({
      mutateAsync: async () => {},
      mutate: () => {},
      isPending: false,
    }),
    useQuery: () => ({
      data: undefined,
      isLoading: false,
    }),
    useQueries: () => [],
    queryOptions: () => ({}),
  }))
}

/**
 * Mock @opencode-ai/ui/context/dialog so useDialog() returns safe no-ops.
 * Dialog components call useDialog() for close/show. When mocked,
 * close/show are available as no-ops and the component renders inline.
 */
export function mockDialogContext(): void {
  mock.module("@opencode-ai/ui/context/dialog", () => ({
    DialogProvider: (props: any) => {
      return h("div", { "data-component": "dialog-provider" }, props.children)
    },
    useDialog: () => ({
      get active() { return undefined },
      show: () => {},
      close: () => {},
    }),
  }))
}

/**
 * Convenience: call all mocks needed for dialog tests in one go.
 * Place inside beforeAll() before importing the dialog under test.
 */
export function mockAllDialogDeps(): void {
  mockUiPrimitives()
  mockDialogContext()
}

// ── Context module mocks ─────────────────────────────────────────────────

/** Mock @/context/language */
export function mockLanguage(): void {
  const m = getMockDefaults()
  mock.module("@/context/language", () => ({
    useLanguage: m.useLanguage,
  }))
}

/** Mock @/context/platform */
export function mockPlatform(): void {
  const m = getMockDefaults()
  mock.module("@/context/platform", () => ({
    usePlatform: m.usePlatform,
  }))
}

/** Mock @/context/settings */
export function mockSettings(): void {
  const m = getMockDefaults()
  mock.module("@/context/settings", () => ({
    useSettings: m.useSettings,
    sansInput: (f: string) => f,
    monoInput: (f: string) => f,
    monoFontFamily: (f: string) => f,
    sansFontFamily: (f: string) => f,
    monoDefault: "System Mono",
    sansDefault: "System Sans",
    terminalDefault: "JetBrainsMono Nerd Font Mono",
    terminalInput: (f: string) => f,
    terminalFontFamily: (f: string) => f,
  }))
}

/** Mock @/context/local */
export function mockLocal(): void {
  const m = getMockDefaults()
  mock.module("@/context/local", () => ({
    useLocal: m.useLocal,
  }))
}

/** Mock @/context/sync */
export function mockSync(): void {
  const m = getMockDefaults()
  mock.module("@/context/sync", () => ({
    useSync: m.useSync,
  }))
}

/** Mock @/context/sdk */
export function mockSDK(): void {
  const m = getMockDefaults()
  mock.module("@/context/sdk", () => ({
    useSDK: m.useSDK,
  }))
}

/** Mock @/hooks/use-providers */
export function mockProviders(): void {
  const m = getMockDefaults()
  mock.module("@/hooks/use-providers", () => ({
    useProviders: m.useProviders,
    popularProviders: m.popularProviders,
  }))
}

/** Mock @/context/server-sdk and @/context/server-sync */
export function mockServerContext(): void {
  const m = getMockDefaults()
  mock.module("@/context/server-sdk", () => ({
    useServerSDK: m.useServerSDK,
  }))
  mock.module("@/context/server-sync", () => ({
    useServerSync: m.useServerSync,
    useQueryOptions: () => ({}),
    pathKey: (p: string) => p,
  }))
}

/** Mock @/context/command */
export function mockCommand(): void {
  const m = getMockDefaults()
  mock.module("@/context/command", () => ({
    useCommand: m.useCommand,
    dispatchAiCommand: async () => {},
    formatKeybind: (k: string) => k,
    parseKeybind: (k: string) => ({ key: k, mod: false }),
  }))
}

/** Mock @/context/prompt */
export function mockPrompt(): void {
  const m = getMockDefaults()
  mock.module("@/context/prompt", () => ({
    usePrompt: m.usePrompt,
  }))
}

/** Mock @/context/layout */
export function mockLayout(): void {
  const m = getMockDefaults()
  mock.module("@/context/layout", () => ({
    useLayout: m.useLayout,
  }))
}

/** Mock @/context/server */
export function mockServer(): void {
  const m = getMockDefaults()
  mock.module("@/context/server", () => ({
    useServer: m.useServer,
    ServerConnection: class {},
  }))
}

/** Mock @/context/file */
export function mockFileContext(): void {
  const m = getMockDefaults()
  mock.module("@/context/file", () => ({
    useFile: m.useFile,
  }))
}

/**
 * Mock ALL common context modules at once.
 * Call this in beforeAll() before importing your dialog under test.
 */
export function mockAllContexts(): void {
  mockLanguage()
  mockPlatform()
  mockSettings()
  mockLocal()
  mockSync()
  mockSDK()
  mockProviders()
  mockServerContext()
  mockCommand()
  mockPrompt()
  mockLayout()
  mockServer()
  mockFileContext()
}
