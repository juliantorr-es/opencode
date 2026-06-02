import type { Config, OpencodeClient, Path, Project, ProviderAuthResponse, Session, Todo } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { batch, createContext, getOwner, onCleanup, onMount, type ParentProps, untrack, useContext } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { useServerSDK } from "./server-sdk"
import type { ProjectReadiness } from "./project-activation"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  loadAgentsQuery,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./global-sync/event-reducer"
import { clearSessionPrefetchDirectory } from "./global-sync/session-prefetch"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext } from "./directory-sync"
import { createSimpleContext, NormalizedProviderListResponse } from "@opencode-ai/ui/context"
import { createRefCountMap } from "@/utils/refcount"
import { Schema } from "effect"

export const queryKeys = {
  diagnostics: ["sidecar", "diagnostics"] as const,
  globalBootstrap: ["global", "bootstrap"] as const,
  project: {
    status: (dir: string) => ["project", dir, "status"] as const,
    path: (dir: string) => ["project", dir, "path"] as const,
    providers: (dir: string) => ["project", dir, "providers"] as const,
    sessions: (dir: string) => ["project", dir, "sessions"] as const,
    agents: (dir: string) => ["project", dir, "agents"] as const,
    fileProviders: (dir: string) => ["project", dir, "file-providers"] as const,
  },
}

let childStoreReady: (key: string) => boolean = () => true

type SessionsBootResult =
  | { status: "ok"; sessions: any[] }
  | { status: "error"; message: string }

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  session_todo: {
    [sessionID: string]: Todo[]
  }
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

export const loadMcpQuery = (directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [directory, "mcp"] as const,
    queryFn: () => sdk.mcp.status().then((r) => r.data ?? {}),
  })

export const loadLspQuery = (directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [directory, "lsp"] as const,
    queryFn: () => sdk.lsp.status().then((r) => r.data ?? []),
  })

function makeQueryOptionsApi(serverSDK: () => OpencodeClient, sdkFor: (dir: PathKey) => OpencodeClient) {
  return {
    globalConfig: () => loadGlobalConfigQuery(serverSDK()),
    projects: () => loadProjectsQuery(serverSDK()),
    providers: (directory: PathKey | null) =>
      loadProvidersQuery(directory, directory === null ? serverSDK() : sdkFor(directory)),
    path: (directory: PathKey | null) => loadPathQuery(directory, directory === null ? serverSDK() : sdkFor(directory)),
    agents: (directory: PathKey) => loadAgentsQuery(directory, sdkFor(directory)),
    mcp: (directory: PathKey) => loadMcpQuery(directory, sdkFor(directory)),
    lsp: (directory: PathKey) => loadLspQuery(directory, sdkFor(directory)),
    sessions: (directory: PathKey) => ({ queryKey: queryKeys.project.sessions(directory), enabled: () => childStoreReady(directory) }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>


// ── IPC Decode Helpers ───────────────────────────────────
// Every renderer boot dependency must be decoded before use.
// TypeScript lies at IPC boundaries; schemas prove the shape.

export const SidecarConfig = Schema.Struct({
  url: Schema.String,
  username: Schema.String,
  password: Schema.String,
})

export const Diagnostics = Schema.Struct({
  classification: Schema.String,
  recommendation: Schema.UndefinedOr(Schema.String),
  sidecarReady: Schema.Boolean,
  instanceCount: Schema.Number,
  instanceHealthy: Schema.Number,
})

export function decodeOrThrow<T>(label: string, schema: Schema.Schema<T>, value: unknown): T {
  const result = Schema.decodeUnknownSync(schema)(value)
  if (result._tag === "Left") {
    console.error(`[ipc-decode] ${label} failed`, { errors: result.left })
    throw new Error(`${label} decode failed`)
  }
  return result.right
}
export function createServerSyncContext() {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("ServerSync must be created within owner")
  const sessionLoads = new Map<string, Promise<SessionsBootResult>>()
  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = serverSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const queryOptionsApi = makeQueryOptionsApi(() => serverSDK.client, sdkFor)

  const [configQuery, providerQuery, pathQuery] = useQueries(() => ({
    queries: [queryOptionsApi.globalConfig(), queryOptionsApi.providers(null), queryOptionsApi.path(null)],
  }))

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return !bootstrap.isPending && !bootstrap.isError
    },
    project: [],
    session_todo: {},
    provider_auth: {},
    get path() {
      const EMPTY = { state: "", config: "", worktree: "", directory: "", home: "" }
      if (pathQuery.isLoading) return EMPTY
      return pathQuery.data ?? EMPTY
    },
    get provider() {
      const EMPTY = { all: new Map(), connected: [], default: {} }
      if (providerQuery.isLoading) return EMPTY
      return providerQuery.data ?? EMPTY
    },
    get config() {
      if (configQuery.isLoading) return {}
      return configQuery.data ?? {}
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  })
  const queryClient = useQueryClient()

  let bootedAt = 0
  let bootingRoot = false
  let eventFrame: number | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
  })

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: queryKeys.globalBootstrap,
    queryFn: async () => {
      await bootstrapGlobal({
        serverSDK: serverSDK.client,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
      bootedAt = Date.now()
      return bootedAt
    },
  }))

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const setSessionTodo = (sessionID: string, todos: Todo[] | undefined) => {
    if (!sessionID) return
    if (!todos) {
      setGlobalStore(
        "session_todo",
        produce((draft) => {
          delete draft[sessionID]
        }),
      )
      return
    }
    setGlobalStore("session_todo", sessionID, reconcile(todos, { key: "id" }))
  }

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => queryClient.fetchQuery({ queryKey: queryKeys.globalBootstrap }),
    bootstrapInstance,
  })

  const children = createChildStoreManager({
    owner,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      queue.clear(key)
      sessionMeta.delete(key)
      sdkCache.delete(key)
      clearProviderRev(key)
      clearSessionPrefetchDirectory(key)
    },
    translate: language.t,
    queryOptions: queryOptionsApi,
    global: {
      provider: globalStore.provider,
    },
  })

  // Wire childStoreReady so project-scoped query enabled guards can check
  // whether the per-directory child store has reached partial/complete status.
  childStoreReady = (key) => {
    const child = children.children[key]
    return child?.[0].status === "partial" || child?.[0].status === "complete"
  }

  // ── ensureReady ────────────────────────────────────────
  // Single canonical path: bootstrap the backend instance,
  // then load sessions. Call this before touching providers/files/sessions.

  async function ensureReady(directory: string): Promise<ProjectReadiness> {
    const key = directoryKey(directory)
    if (!key) return { status: "failed", directory, code: "INVALID_KEY", message: "Directory key missing", retryable: false }
    children.pin(key)
    try {
      children.ensureChild(directory)
      // Bootstrap the instance if needed
      if (booting.has(key) || !children.children[key] || children.children[key]![0].status === "loading") {
        await bootstrapInstance(directory)
      }
      await loadSessionsBootstrapped(directory)
      return { status: "ready", directory }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { status: "failed", directory, code: "ENSURE_READY_ERROR", message, retryable: true }
    } finally {
      children.unpin(key)
    }
  }

  // ── loadSessionsBootstrapped ────────────────────────────
  // Internal: assumes instance is already ready.
  // Does NOT create/pin child store — caller must do that.

  async function loadSessionsBootstrapped(directory: string): Promise<{ status: "ok"; sessions: any[] } | { status: "error"; message: string }> {
    const key = directoryKey(directory)
    if (!key) return { status: "error", message: "Invalid directory" }
    const pending = sessionLoads.get(key)
    if (pending) return pending
    const store = children.children[key]?.[0]
    const setStore = children.children[key]?.[1]
    if (!store || !setStore) return { status: "error", message: "Child store not ready" }
    const meta = sessionMeta.get(key)
    if (meta && meta.limit >= store.limit) {
      const next = trimSessions(store.session, {
        limit: store.limit,
        permission: store.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
        cleanupDroppedSessionCaches(store, setStore, next, setSessionTodo)
      }
      const sessions = store.session
      return { status: "ok", sessions: sessions as any[] }
    }

    const limit = Math.max(store.limit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = (async (): Promise<{ status: "ok"; sessions: any[] } | { status: "error"; message: string }> => {
      try {
        const sessions = await queryClient.fetchQuery({
          ...queryOptionsApi.sessions(key),
          queryFn: async () => {
            const result = await loadRootSessionsWithFallback({
              directory,
              limit,
              list: (query) => serverSDK.client.session.list(query),
            })
            const nonArchived = (result.data ?? [])
              .filter((s) => !!s?.id)
              .filter((s) => !s.time?.archived)
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            const childSessions = store.session.filter((s) => !!s.parentID)
            const sessions = trimSessions([...nonArchived, ...childSessions], {
              limit: store.limit,
              permission: store.permission,
            })
            batch(() => {
              setStore(
                "sessionTotal",
                estimateRootSessionTotal({
                  count: nonArchived.length,
                  limit: result.limit,
                  limited: result.limited,
                }),
              )
              setStore("session", reconcile(sessions, { key: "id" }))
              cleanupDroppedSessionCaches(store, setStore, sessions, setSessionTodo)
            })
            sessionMeta.set(key, { limit })
            return sessions
          },
        })
        return { status: "ok" as const, sessions: sessions as any[] }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { status: "error" as const, message }
      }
    })()

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      sessionLoads.delete(key)
    })
    return promise
  }

  // ── loadSessions (public) ──────────────────────────────
  async function loadSessions(directory: string) {
    return ensureReady(directory)
  }

  async function bootstrapInstance(directory: string) {
    const key = directoryKey(directory)
    if (!key) return
    const pending = booting.get(key)
    if (pending) return pending

    children.pin(key)
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(key)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions: loadSessionsBootstrapped,
        translate: language.t,
        queryClient,
      })
    })

    booting.set(key, promise)
    void promise.finally(() => {
      booting.delete(key)
      children.unpin(key)
    })
    return promise
  }

  const unsub = serverSDK.event.listen((e) => {
    const directory = e.name
    const key = directoryKey(directory)
    const event = e.details
    const recent = bootingRoot || Date.now() - bootedAt < 1500

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          bootstrap.refetch()
        },
        setGlobalProject: setProjects,
      })
      if (event.type === "server.connected" || event.type === "global.disposed") {
        if (recent) return
        for (const directory of Object.keys(children.children)) {
          queue.push(directory)
        }
      }
      return
    }

    const existing = children.children[key]
    if (!existing) return
    children.mark(key)
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: queue.push,
      setSessionTodo,
      vcsCache: children.vcsCache.get(key),
      loadLsp: () => {
        void queryClient.fetchQuery(queryOptionsApi.lsp(key))
      },
    })
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directoryKey(directory))
    }
  })

  onMount(() => {
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          void serverSDK.event.start()
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void serverSDK.event.start()
      }, 0)
    }
  })

  const projectApi = {
    loadSessions,
    ensureReady,
    bootstrapInstance,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: Config) => serverSDK.client.global.config.update({ config }),
    onSuccess: () => {
      bootstrap.refetch()
      // Invalidate all provider queries so newly configured custom providers
      // appear immediately in the available provider list across all directories.
      queryClient.invalidateQueries({ queryKey: [null, "providers"] })
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey.at(-1) === "providers" })
    },
  }))

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    queryOptions: queryOptionsApi,
    // bootstrap,
    updateConfig: updateConfigMutation.mutateAsync,
    project: projectApi,
    todo: {
      set: setSessionTodo,
    },
  }
}

export const { use: useServerSync, provider: ServerSyncProvider } = createSimpleContext({
  name: "ServerSync",
  init: () => {
    const sync = createServerSyncContext()

    return {
      ...sync,
      createDirSyncContext: createRefCountMap((dir) => createDirSyncContext(dir, sync)),
    }
  },
})

export function useQueryOptions() {
  return useServerSync().queryOptions
}
