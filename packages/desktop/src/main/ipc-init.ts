import { app, ipcMain } from "electron"
import { Effect } from "effect"
import { registerIpcEffectHandler } from "./ipc-adapter"
import * as path from "node:path"
import { existsSync } from "node:fs"
import { IPC } from "./ipc-channels"
import * as S from "../ipc/schema-compat"
import type { DesktopRuntime } from "./effect/desktop-runtime"
import { mapInitError } from "./errors/init-errors"
import type {
  InitStep,
  FatalRendererError,
  SafeModeAction,
  SafeModeDiagnostics,
  ServerReadyData,
  WindowConfig,
  WslConfig,
} from "../preload/types"

export type Deps = {
  killSidecar: () => Promise<void> | void
  awaitInitialization: (sendStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getWindowConfig: () => Promise<WindowConfig> | WindowConfig
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  loadingWindowComplete: () => void
  rendererReady: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void> | void
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
  getSafeModeDiagnostics: () => Promise<SafeModeDiagnostics>
  safeModeAction: (action: SafeModeAction) => Promise<void>
}

/**
 * Register IPC handlers that delegate through the `deps` object.
 * These are thin wrappers — the actual logic lives in index.ts
 * and its dependencies.
 */
export function registerInitIpcHandlers(deps: Deps, runtime: DesktopRuntime) {
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.KILL_SIDECAR,
    params: S.Tuple([]),
    success: S.UndefinedConst,
    timeout: 10_000,
    senderPolicy: "strict",
    mapError: mapInitError,
  }, () => Effect.tryPromise(async () => { return await (deps.killSidecar() as Promise<any>) }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.AWAIT_INITIALIZATION,
    params: S.Tuple([]),
    success: S.Unknown,
    timeout: 60_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, () => Effect.tryPromise(async () => deps.awaitInitialization((_: InitStep) => {})))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.GET_WINDOW_CONFIG,
    params: S.Tuple([]),
    success: S.Unknown,
    timeout: 10_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, () => Effect.tryPromise(async () => { return await (deps.getWindowConfig() as Promise<any>) }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.CONSUME_INITIAL_DEEP_LINKS,
    params: S.Tuple([]),
    success: S.Arr(S.Str),
    timeout: 30_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, () => Effect.tryPromise(async () => { return await (deps.consumeInitialDeepLinks() as Promise<any>) }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.GET_DEFAULT_SERVER_URL,
    params: S.Tuple([]),
    success: S.Nullable(S.Str),
    timeout: 10_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, () => Effect.tryPromise(async () => { return await (deps.getDefaultServerUrl() as Promise<any>) }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.SET_DEFAULT_SERVER_URL,
    params: S.Tuple([S.Nullable(S.Str)]),
    success: S.UndefinedConst,
    timeout: 30_000,
    senderPolicy: "strict",
    mapError: mapInitError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [url] = params as [string | null]
    return deps.setDefaultServerUrl(url)
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.GET_WSL_CONFIG,
    params: S.Tuple([]),
    success: S.Unknown,
    timeout: 10_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, () => Effect.tryPromise(async () => { return await (deps.getWslConfig() as Promise<any>) }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.SET_WSL_CONFIG,
    params: S.Tuple([S.Unknown]),
    success: S.UndefinedConst,
    timeout: 30_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [config] = params as [WslConfig]
    return deps.setWslConfig(config)
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.GET_DISPLAY_BACKEND,
    params: S.Tuple([]),
    success: S.Nullable(S.Str),
    timeout: 10_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, () => Effect.tryPromise(async () => { return await (deps.getDisplayBackend() as Promise<any>) }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.SET_DISPLAY_BACKEND,
    params: S.Tuple([S.Nullable(S.Str)]),
    success: S.UndefinedConst,
    timeout: 30_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [backend] = params as [string | null]
    return deps.setDisplayBackend(backend)
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.PARSE_MARKDOWN,
    params: S.Tuple([S.Str]),
    success: S.Str,
    timeout: 30_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [markdown] = params as [string]
    return deps.parseMarkdown(markdown)
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.CHECK_APP_EXISTS,
    params: S.Tuple([S.Str]),
    success: S.Bool,
    timeout: 30_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [appName] = params as [string]
    return deps.checkAppExists(appName)
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.WSL_PATH,
    params: S.Tuple([S.Str, S.Nullable(S.Str)]),
    success: S.Str,
    timeout: 30_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [wslPath_, mode] = params as [string, string | null]
    return deps.wslPath(wslPath_, mode as "windows" | "linux" | null)
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.RESOLVE_APP_PATH,
    params: S.Tuple([S.Str]),
    success: S.Nullable(S.Str),
    timeout: 30_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [appName] = params as [string]
    return deps.resolveAppPath(appName)
  }))

  ipcMain.on(IPC.send.LOADING_WINDOW_COMPLETE, () => deps.loadingWindowComplete())

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.RUN_UPDATER,
    params: S.Tuple([S.Bool]),
    success: S.UndefinedConst,
    timeout: 60_000,
    senderPolicy: "strict",
    mapError: mapInitError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [alertOnFail] = params as [boolean]
    return deps.runUpdater(alertOnFail)
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.CHECK_UPDATE,
    params: S.Tuple([]),
    success: S.Unknown,
    timeout: 60_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, () => Effect.tryPromise(async () => { return await (deps.checkUpdate() as Promise<any>) }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.INSTALL_UPDATE,
    params: S.Tuple([]),
    success: S.UndefinedConst,
    timeout: 60_000,
    senderPolicy: "strict",
    mapError: mapInitError,
  }, () => Effect.tryPromise(async () => { return await (deps.installUpdate() as Promise<any>) }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.SET_BACKGROUND_COLOR,
    params: S.Tuple([S.Str]),
    success: S.UndefinedConst,
    timeout: 30_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, (params: unknown) => Effect.sync(() => {
    const [color] = params as [string]
    deps.setBackgroundColor(color)
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.EXPORT_DEBUG_LOGS,
    params: S.Tuple([]),
    success: S.Str,
    timeout: 60_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, () => Effect.tryPromise(async () => { return await (deps.exportDebugLogs() as Promise<any>) }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.RECORD_FATAL_RENDERER_ERROR,
    params: S.Tuple([S.Unknown]),
    success: S.UndefinedConst,
    timeout: 30_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [error] = params as [FatalRendererError]
    return deps.recordFatalRendererError(error)
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.GET_SAFE_MODE_DIAGNOSTICS,
    params: S.Tuple([]),
    success: S.Unknown,
    timeout: 30_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, () => Effect.tryPromise(async () => { return await (deps.getSafeModeDiagnostics() as Promise<any>) }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.SAFE_MODE_ACTION,
    params: S.Tuple([S.Str]),
    success: S.UndefinedConst,
    timeout: 30_000,
    senderPolicy: "strict",
    mapError: mapInitError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [action] = params as [SafeModeAction]
    return deps.safeModeAction(action)
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.OPEN_PROJECT,
    params: S.Tuple([S.Str]),
    success: S.Str,
    timeout: 30_000,
    senderPolicy: "strict",
    mapError: mapInitError,
  }, (params: unknown) => Effect.sync(() => {
    const [directory] = params as [string]
    const resolved = path.resolve(directory)
    if (!existsSync(resolved)) {
      throw new Error(`Directory not found: ${resolved}`)
    }
    const userData = app.getPath("userData")
    if (userData && (resolved === userData || resolved.startsWith(userData + path.sep))) {
      console.warn(
        `[project.open] Directory resolves inside app data directory (userData). ` +
          `This may indicate the user selected the app-data directory instead of a project: ${resolved}`,
      )
    }
    return resolved
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.SYSTEM_STATUS,
    params: S.Tuple([]),
    success: S.Unknown,
    timeout: 5_000,
    senderPolicy: "standard",
    mapError: mapInitError,
  }, () => Effect.sync(() => ({
    sidecar: { ready: true, url: process.env.TRIBUNUS_VALKEY_URL ?? null, pid: null, restartCount: 0, lastError: null },
    server: { url: null, configured: false },
    safeMode: false,
    degraded: false,
    degradedReason: null,
    ipc: { protocolVersion: 1 },
    update: { status: "idle", version: null },
    build: { version: app.getVersion(), channel: "dev", electronVersion: process.versions.electron },
  })))
}
