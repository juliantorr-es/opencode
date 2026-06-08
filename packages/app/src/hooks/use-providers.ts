import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import { createMemo } from "solid-js"
import type { Config, Provider } from "@tribunus/sdk/v2/client"

export const popularProviders = [
  "opencode",
  "opencode-go",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)

type CustomProviderConfig = NonNullable<Config["provider"]>[string]

function normalizeCustomProvider(providerID: string, provider: CustomProviderConfig): Provider {
  const models = Object.fromEntries(
    Object.entries(provider.models ?? {}).map(([id, model]) => [
      id,
      {
        id,
        providerID,
        api: {
          id,
          url: provider.options?.baseURL ?? "",
          npm: provider.npm ?? "@ai-sdk/openai-compatible",
        },
        name: model.name ?? id,
        family: model.family ?? "",
        capabilities: {
          temperature: model.temperature ?? false,
          reasoning: model.reasoning ?? false,
          attachment: model.attachment ?? false,
          toolcall: model.tool_call ?? false,
          input: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          output: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          interleaved: model.interleaved ?? false,
        },
        cost: {
          input: model.cost?.input ?? 0,
          output: model.cost?.output ?? 0,
          cache: {
            read: model.cost?.cache_read ?? 0,
            write: model.cost?.cache_write ?? 0,
          },
          ...(model.cost?.context_over_200k
            ? {
                experimentalOver200K: {
                  input: model.cost.context_over_200k.input,
                  output: model.cost.context_over_200k.output,
                  cache: {
                    read: model.cost.context_over_200k.cache_read ?? 0,
                    write: model.cost.context_over_200k.cache_write ?? 0,
                  },
                },
              }
            : {}),
        },
        limit: {
          context: model.limit?.context ?? 200_000,
          input: model.limit?.input,
          output: model.limit?.output ?? 4_096,
        },
        status: model.status ?? "active",
        options: model.options ?? {},
        headers: model.headers ?? {},
        release_date: model.release_date ?? "",
        variants: model.variants ?? {},
      },
    ]),
  )

  return {
    id: providerID,
    name: provider.name ?? providerID,
    source: "config",
    env: provider.env ?? [],
    options: provider.options ?? {},
    models,
  }
}

export function useProviders() {
  const serverSync = useServerSync()
  const params = useParams()
  const dir = createMemo(() => decode64(params.dir) ?? "")
  const providers = () => {
    const disabled = new Set(serverSync.data.config.disabled_providers ?? [])
    const custom = serverSync.data.config.provider ?? {}
    const mergedCustom = new Map(
      Object.entries(custom)
        .filter(([id]) => !disabled.has(id))
        .map(([id, provider]) => [id, normalizeCustomProvider(id, provider)] as const),
    )
    if (dir()) {
      const [projectStore] = serverSync.child(dir())
      if (projectStore.provider_ready) {
        return {
          ...projectStore.provider,
          all: new Map([...projectStore.provider.all, ...mergedCustom]),
          connected: [...new Set([...projectStore.provider.connected, ...mergedCustom.keys()])].filter(
            (id) => !disabled.has(id),
          ),
          default: {
            ...projectStore.provider.default,
            ...Object.fromEntries(
              Object.entries(custom)
                .filter(([id]) => !disabled.has(id))
                .map(([id, provider]) => [
                  id,
                  Object.keys(provider.models ?? {})[0] ?? "",
                ]),
            ),
          },
        }
      }
    }
    return {
      ...serverSync.data.provider,
      all: new Map([...serverSync.data.provider.all, ...mergedCustom]),
      connected: [...new Set([...serverSync.data.provider.connected, ...mergedCustom.keys()])].filter(
        (id) => !disabled.has(id),
      ),
      default: {
        ...serverSync.data.provider.default,
        ...Object.fromEntries(
          Object.entries(custom)
            .filter(([id]) => !disabled.has(id))
            .map(([id, provider]) => [id, Object.keys(provider.models ?? {})[0] ?? ""]),
        ),
      },
    }
  }
  return {
    all: () => providers().all,
    default: () => providers().default,
    popular: () =>
      pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id)),
        (v) => Array.from(v),
      ),
    connected: () => {
      const connected = new Set(providers().connected)
      return pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => connected.has(p.id)),
        (v) => Array.from(v),
      )
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return [
        ...Iterable.filter(
          providers().all,
          ([id]) =>
            connected.has(id) &&
            (id !== "opencode" || Object.values(providers().all.get(id)?.models ?? {}).some((m) => m.cost?.input)),
        ),
      ]
    },
  }
}
