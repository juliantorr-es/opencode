import path from "path"
import fs from "fs/promises"
import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdapter as PluginWorkspaceAdapter,
} from "@tribunus/plugin"
import { Config } from "@/config/config"
import { Bus } from "../bus"
import * as Log from "@tribunus/core/util/log"
import { createOpencodeClient } from "@tribunus/sdk"
import { ServerAuth } from "@/server/auth"
import { CodexAuthPlugin } from "./openai/codex"
import { Session } from "@/session/session"
import { NamedError } from "@tribunus/core/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { AzureAuthPlugin } from "./azure"
import { DigitalOceanAuthPlugin } from "./digitalocean"
import { XaiAuthPlugin } from "./xai"
import { Effect, Layer, Context, Stream, Option, ConfigProvider } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { HealthRegistry, HealthStatus } from "@/server/health"
import { Global } from "@tribunus/core/global"
import { PluginLoader } from "./loader"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstallationChannel } from "@tribunus/core/installation/version"
import { Registry as CapabilityRegistry, makeCapabilityRegistry, checkCapability, HOOK_CAPABILITY_MAP, ALWAYS_ALLOWED_HOOKS, makeFallbackState, makeHookDispatchGuard, HookDispatchGuard, CapabilityId, type TrustLevel, isValidCapabilityId } from "./capability"

const log = Log.create({ service: "plugin" })

// ── Plugin health store (crash counters + quarantine) ────────
// Persisted to a JSON file in the Global data directory so crash
// counts survive restarts and auto-quarantined plugins stay disabled.

interface PluginHealthEntry {
  crashCount: number
  quarantined: boolean
  lastCrashed?: string
}

interface PluginHealthStore {
  plugins: Record<string, PluginHealthEntry>
}

const PLUGIN_HEALTH_FILE = path.join(Global.Path.data, "plugin-health.json")

function loadPluginHealthStore(): Effect.Effect<PluginHealthStore> {
  return Effect.promise<PluginHealthStore>(async () => {
    try {
      const raw = await fs.readFile(PLUGIN_HEALTH_FILE, "utf-8")
      return JSON.parse(raw) as PluginHealthStore
    } catch {
      return { plugins: {} }
    }
  })
}

function savePluginHealthStore(store: PluginHealthStore): Effect.Effect<void> {
  return Effect.tryPromise(() => fs.writeFile(PLUGIN_HEALTH_FILE, JSON.stringify(store, null, 2))).pipe(
    Effect.tapError((cause) => Effect.logError("plugin health save failed", cause)),
    Effect.ignore,
  )
}

const MAX_CRASHES_BEFORE_QUARANTINE = 3

type PluginRegistration = {
  pluginId: string
  trust: TrustLevel
  hooks?: Hooks
  pluginName?: string
}

type ListedPlugin = Hooks & { pluginId: string }

type State = {
  plugins: PluginRegistration[]
  capabilityRegistry: CapabilityRegistry
  dispatchGuard: HookDispatchGuard
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
  readonly checkCapability: (pluginId: string, capability: string) => Effect.Effect<boolean>
  readonly getRegistry: () => Effect.Effect<CapabilityRegistry>
  /** Reset the crash counter and clear quarantine for a plugin. */
  readonly unquarantine: (pluginId: string) => Effect.Effect<void>
  /** Get the persisted crash/quarantine status for all plugins. */
  readonly getCrashStatus: () => Effect.Effect<Record<string, { crashCount: number; quarantined: boolean; lastCrashed?: string }>>
}

export class Service extends Context.Service<Service, Interface>()("@tribunus/Plugin") {}

export function experimentalWebSocketsEnabled(input: { enabled: boolean; channel?: string }) {
  return input.enabled || ["local", "dev", "beta"].includes(input.channel ?? InstallationChannel)
}

// Built-in plugins that are directly imported (not installed from npm)
function internalPlugins(flags: RuntimeFlags.Info): PluginInstance[] {
  return [
    // Temporary rollout: pre-release builds use WebSockets by default; releases require explicit opt-in.
    (input) =>
      CodexAuthPlugin(input, {
        experimentalWebSockets: experimentalWebSocketsEnabled({ enabled: flags.experimentalWebSockets }),
      }),
    CopilotAuthPlugin,
    GitlabAuthPlugin,
    PoeAuthPlugin,
    CloudflareWorkersAuthPlugin,
    CloudflareAIGatewayAuthPlugin,
    AzureAuthPlugin,
    DigitalOceanAuthPlugin,
    XaiAuthPlugin,
  ]
}

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: PluginInstance[] = []

  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push(plugin)
  }

  return result
}

async function applyPlugin(load: PluginLoader.Loaded, input: PluginInput, hooks: Hooks[]): Promise<string> {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    const pluginId = await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    hooks.push(await (plugin as PluginModule).server(input, load.options))
    return pluginId
  }

  for (const server of getLegacyPlugins(load.mod)) {
    hooks.push(await server(input, load.options))
  }
  return load.spec
}

const SECRET_PATTERNS = ["apiKey", "token", "password", "secret", "key", "credential", "auth"] as const

function hasSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((pattern) => key.toLowerCase().includes(pattern.toLowerCase()))
}

function stripSecrets<T extends Record<string, unknown>>(config: T): T {
  const result = { ...config }
  for (const key of Object.keys(result)) {
    if (hasSecretKey(key)) {
      delete result[key]
    }
  }
  return result
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    // SAFETY: state is self-referential (used inside bus event subscription created
    // during initialization). Effect.fn wrapping obscures return type from InstanceState.make.
    const state: any = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const hooks: Hooks[] = []
        const registrations: PluginRegistration[] = []
        const bridge = yield* EffectBridge.make()
        const capabilityRegistry = yield* makeCapabilityRegistry()
        const dispatchGuard = makeHookDispatchGuard(capabilityRegistry)

        function publishPluginError(message: string) {
          try {
            bridge.fork(bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
          } catch (err) {
            console.error("plugin error publish failed", message, err)
          }
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const client = createOpencodeClient({
          baseUrl: "http://localhost:4096",
          directory: ctx.directory,
          headers: ServerAuth.headers(),
          fetch: async (...args) => Server.Default().app.fetch(...args),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              registerAdapter(ctx.project.id, type, adapter as WorkspaceAdapter)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        for (const plugin of flags.disableDefaultPlugins ? [] : internalPlugins(flags)) {
          log.info("loading internal plugin", { name: plugin.name })
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: (err) => {
              log.error("failed to load internal plugin", { name: plugin.name, error: err })
            },
          }).pipe(Effect.option)
          if (init._tag === "Some") {
            hooks.push(init.value)
            const pluginId = plugin.name ?? `built-in-${registrations.length}`
            registrations.push({ pluginId, trust: "built-in" })
            yield* capabilityRegistry.register(pluginId, makeFallbackState("built-in"))
          }
        }

        const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])
        if (flags.pure && cfg.plugin_origins?.length) {
          log.info("skipping external plugins in pure mode", { count: cfg.plugin_origins.length })
        }
        if (plugins.length) yield* config.waitForDependencies()

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {
                log.info("loading plugin", { path: candidate.plan.spec })
              },
              missing(candidate, _retry, message) {
                log.warn("plugin has no server entrypoint", { path: candidate.plan.spec, message })
              },
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  log.error("failed to install plugin", { pkg: parsed.pkg, version: parsed.version, error: message })
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  log.warn("plugin incompatible", { path: spec, error: message })
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  log.error("failed to resolve plugin server entry", { path: spec, error: message })
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                log.error("failed to load plugin", { path: spec, target: resolved?.entry, error: message })
                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          }),
        )
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          const pluginId = yield* Effect.tryPromise({
            try: () => applyPlugin(load, input, hooks),
            catch: (err) => {
              const message = errorMessage(err)
              log.error("failed to load plugin", { path: load.spec, error: message })
              return ""
            },
          }).pipe(Effect.catch(() => Effect.succeed("")))

          if (pluginId) {
            registrations.push({ pluginId, trust: "external" })
            yield* capabilityRegistry.register(pluginId, makeFallbackState("external"))
          }
        }

        // Zip hooks and registrations into a single plugins array
        if (hooks.length !== registrations.length) {
          yield* Effect.logWarning("plugin arrays desynchronized", { hooksLen: hooks.length, regsLen: registrations.length })
        }
        const pluginList: PluginRegistration[] = []
        for (let i = 0; i < hooks.length; i++) {
          const reg = registrations[i]
          pluginList.push({
            pluginId: reg?.pluginId ?? `__unregistered_${i}`,
            trust: reg?.trust ?? "external",
            hooks: hooks[i],
            pluginName: reg?.pluginId ?? `__unregistered_${i}`,
          })
        }

        // Notify plugins of current config
        // Filter secrets per-plugin based on capability manifest.
        for (const reg of pluginList) {
          const hook = reg.hooks
          if (!hook) continue
          const pluginId = reg.pluginId
          let configForPlugin = cfg
          if (pluginId) {
            const hasSecretsAccess = yield* checkCapability(capabilityRegistry, pluginId, CapabilityId.SecretsAccess)
            if (!hasSecretsAccess) {
              configForPlugin = stripSecrets(cfg)
            }
          }
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(configForPlugin)),
            catch: (err) => {
              log.error("plugin config hook failed", { pluginId: pluginId ?? "unknown", error: err })
            },
          }).pipe(Effect.ignore)
        }

        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            pluginList,
            (reg) =>
              Effect.tryPromise({
                try: () => Promise.resolve(reg.hooks?.dispose?.()),
                catch: (error) => {
                  log.error("plugin dispose hook failed", { error })
                },
              }).pipe(Effect.ignore),
            { discard: true },
          ),
        )

        // Subscribe to bus events, fiber interrupted when scope closes
        // SAFETY: Each event dispatch checks the plugin's event.subscribe capability and network access gate.
        yield* (yield* bus.subscribeAll()).pipe(
          Stream.runForEach((input) =>
            Effect.gen(function* () {
              const s = (yield* InstanceState.get(state)) as State
              for (const reg of s.plugins) {
                const fn = reg.hooks?.["event"]
                if (!fn) continue
                const pluginId = reg.pluginId
                if (!pluginId) {
                  fn({ event: input as any })
                  continue
                }
                const allowed = yield* dispatchGuard.shouldDispatch("event", pluginId)
                if (!allowed) { yield* Effect.logWarning("plugin event denied", { pluginId: reg.pluginId, hook: "event" }); continue }
                fn({ event: input as any })
              }
            }),
          ),
          Effect.forkScoped,
        )

        return { plugins: pluginList, capabilityRegistry, dispatchGuard }
      }) as any,
    )

    const pluginHealthStore = yield* loadPluginHealthStore()

    const persistCrash = (pluginId: string): any =>
      Effect.gen(function* () {
        const entry: PluginHealthEntry = pluginHealthStore.plugins[pluginId] ?? { crashCount: 0, quarantined: false }
        entry.crashCount++
        entry.lastCrashed = new Date().toISOString()
        if (entry.crashCount >= MAX_CRASHES_BEFORE_QUARANTINE) {
          entry.quarantined = true
          log.warn("plugin auto-quarantined after repeated crashes", { pluginId, crashCount: entry.crashCount })
        }
        pluginHealthStore.plugins[pluginId] = entry
        yield* savePluginHealthStore(pluginHealthStore)
        const reg: any = yield* InstanceState.get(state)
        yield* reg?.capabilityRegistry?.setCrashCount?.(pluginId, entry.crashCount)
        yield* reg?.capabilityRegistry?.setQuarantined?.(pluginId, entry.quarantined)
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("persistCrash: failed to persist crash state", { pluginId, error, errorType: typeof error }),
        ),
      )

    const persistSuccess = (pluginId: string): any =>
      Effect.gen(function* () {
        const entry = pluginHealthStore.plugins[pluginId]
        if (entry && entry.crashCount > 0) {
          entry.crashCount = 0
          pluginHealthStore.plugins[pluginId] = entry
          yield* savePluginHealthStore(pluginHealthStore)
          const reg: any = yield* InstanceState.get(state)
          yield* reg?.capabilityRegistry?.setCrashCount?.(pluginId, 0)
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("persistSuccess: failed to persist success state", { pluginId, error, errorType: typeof error }),
        ),
      )

    const trigger: Interface["trigger"] = function (name: any, input: any, output: any) {
      return Effect.gen(function* () {
        if (!name) return output
        const s: any = yield* InstanceState.get(state)
        const plugins = s.plugins
        if ((ALWAYS_ALLOWED_HOOKS as Set<string>).has(name)) {
          for (const reg of plugins) {
            const hook = reg.hooks
            if (!hook) continue
            // Deferred: Hooks intersection type has no index signature for dynamic hook dispatch.
            // Safe because hook[name] is validated to exist before calling. TypeScript limitation.
            const fn = (hook as any)[name]
            if (!fn) continue
            yield* Effect.tryPromise({ try: () => fn(input, output), catch: (err) => { log.error("plugin hook error", { pluginId: reg.pluginId ?? "unknown", hook: name, error: err }) } })
          }
          return output
        }
        const requiredCapability = HOOK_CAPABILITY_MAP[name]
        if (!requiredCapability) return output
        for (const reg of plugins) {
          const hook = reg.hooks
          if (!hook) continue
          // Deferred: Hooks intersection type has no index signature for dynamic hook dispatch.
          const fn = (hook as any)[name]
          if (!fn) continue
          const pluginId = reg.pluginId ?? "unknown"
          const allowed = yield* (s.dispatchGuard as HookDispatchGuard).shouldDispatch(name, pluginId)
          if (!allowed) { yield* Effect.logWarning("plugin hook dispatch blocked by guard", { pluginId, hook: name }); continue }
          const result = yield* Effect.tryPromise({
            try: () => fn(input, output),
            catch: (err) => {
              // Note: catch handler runs outside generator context — cannot use yield* Effect.logError here
              log.error("plugin hook error", { pluginId, hook: name, error: err })
              return err
            },
          }).pipe(Effect.exit)
          if (result._tag === "Success") {
            yield* persistSuccess(pluginId)
          } else {
            yield* persistCrash(pluginId)
          }
        }
        return output
      })
    } as any

    const list = Effect.fn("Plugin.list")(function* () {
      const s = (yield* InstanceState.get(state)) as State
      return s.plugins.map((reg: PluginRegistration) => {
        const listed: ListedPlugin = Object.assign({}, reg.hooks ?? {}, { pluginId: reg.pluginId })
        return listed
      })
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
    })

    const checkCapabilityFn = Effect.fn("Plugin.checkCapability")(function* (pluginId: string, capability: string) {
      if (!isValidCapabilityId(capability)) {
        yield* Effect.logWarning("checkCapability: invalid capability ID", { pluginId, capability })
        return false
      }
      const s = (yield* InstanceState.get(state)) as State
      return yield* checkCapability(s.capabilityRegistry, pluginId, capability)
    })

    const getRegistry = Effect.fn("Plugin.getRegistry")(function* () {
      const s = (yield* InstanceState.get(state)) as State
      return s.capabilityRegistry
    })

    const unquarantine = Effect.fn("Plugin.unquarantine")(function* (pluginId: string) {
      const entry = pluginHealthStore.plugins[pluginId]
      if (entry) {
        entry.crashCount = 0
        entry.quarantined = false
        delete entry.lastCrashed
        yield* savePluginHealthStore(pluginHealthStore)
      }
      const reg: any = yield* InstanceState.get(state)
      yield* reg?.capabilityRegistry?.setCrashCount?.(pluginId, 0)
      yield* reg?.capabilityRegistry?.setQuarantined?.(pluginId, false)
      log.info("plugin manually un-quarantined", { pluginId })
    })

    const getCrashStatus = Effect.fn("Plugin.getCrashStatus")(function* () {
      return yield* Effect.succeed({ ...pluginHealthStore.plugins })
    })

    // Report Plugin health to optional HealthRegistry
    const hr = yield* Effect.serviceOption(HealthRegistry)
    if (Option.isSome(hr)) {
      yield* hr.value.set("plugin", {
        status: HealthStatus.Healthy,
        updatedAt: Date.now(),
      })
    }

    return Service.of({ trigger, list, init, checkCapability: checkCapabilityFn, getRegistry, unquarantine, getCrashStatus } as any)
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
)

export * as Plugin from "."
