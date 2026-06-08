import { Effect, Layer, Scope } from "effect"
import { Flag } from "@tribunus/core/flag/flag"
import { Database } from "../../src/storage/db"
import { LSP } from "../../src/lsp/lsp"
import { FileWatcher } from "../../src/file/watcher"
import { Plugin } from "../../src/plugin"
import { ShareNext } from "../../src/share/share-next"
import { createRoutes } from "../../src/server/routes/instance/httpapi/server"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { disposeMiddleware } from "../../src/server/routes/instance/httpapi/lifecycle"
import { disposeAllInstances } from "../fixture/fixture"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const lspMock = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(null),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  })
)

const fileWatcherMock = Layer.succeed(
  FileWatcher.Service,
  FileWatcher.Service.of({
    init: () => Effect.void,
  })
)

const pluginMock = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: (_name, _input, output) => Effect.succeed(output),
    list: () => Effect.succeed([]),
    checkCapability: () => Effect.succeed(false),
    getRegistry: () => { throw new Error("not implemented") },
    unquarantine: () => Effect.void,
    getCrashStatus: () => Effect.succeed({}),
  })
)

const shareNextMock = Layer.succeed(
  ShareNext.Service,
  ShareNext.Service.of({
    init: () => Effect.void,
    url: () => Effect.succeed("http://noop"),
    request: () => Effect.succeed({ headers: {}, api: {} as any, baseUrl: "http://noop" }),
    create: () => Effect.succeed({ id: "noop", secret: "noop", url: "http://noop" }),
    remove: () => Effect.void,
  })
)

export interface ServerTestCell {
  readonly workspaceDir: string
  readonly dbPath: string
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly teardown: () => Promise<void>
}

export async function createServerTestCell(): Promise<ServerTestCell> {
  // 1. Create a unique isolated temp workspace directory and unique database file path
  const cellId = Math.random().toString(36).slice(2)
  const workspaceDir = path.join(os.tmpdir(), `opencode-test-workspace-${cellId}`)
  const dbPath = path.join(workspaceDir, "opencode-test-cell.db")
  await fs.mkdir(workspaceDir, { recursive: true })

  // Disable file watcher and other background things via env/flags to avoid races
  process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
  process.env.OPENCODE_EXPERIMENTAL_FILEWATCHER = "false"

  // 2. Legacy global isolation: Reset Database singleton and configure the new path
  Database.close()
  Database.Client.reset()
  Flag.OPENCODE_DB = dbPath

  // 3. Create the test cell layer, providing mocks to override standard implementations
  const cellRoutes = createRoutes().pipe(
    Layer.provideMerge(lspMock),
    Layer.provideMerge(fileWatcherMock),
    Layer.provideMerge(pluginMock),
    Layer.provideMerge(shareNextMock),
  )

  // Use a fresh memo map to prevent caching/sharing services with other test cells
  const cellMemoMap = Layer.makeMemoMapUnsafe()
  const webHandler = HttpRouter.toWebHandler(cellRoutes, {
    disableLogger: true,
    memoMap: cellMemoMap,
    middleware: disposeMiddleware,
  })

  // 4. Request handler caller
  const request = async (urlPath: string, init?: RequestInit) => {
    const req = new Request(new URL(urlPath, "http://localhost"), init)
    return webHandler.handler(req, HttpApiApp.context)
  }

  // 5. Explicit, deterministic teardown
  const teardown = async () => {
    const steps: { name: string; run: () => Promise<void> | void }[] = [
      {
        name: "instance disposal / fiber cancellation",
        run: async () => {
          await disposeAllInstances()
        },
      },
      {
        name: "database close",
        run: async () => {
          await Database.close()
        },
      },
      {
        name: "global reset",
        run: () => {
          Database.Client.reset()
        },
      },
      {
        name: "temp directory cleanup",
        run: async () => {
          await fs.rm(workspaceDir, { recursive: true, force: true })
        },
      },
    ]

    for (const step of steps) {
      try {
        await step.run()
      } catch (err) {
        throw new Error(
          `ServerTestCell teardown failed at step: "${step.name}". Error: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  return {
    workspaceDir,
    dbPath,
    request,
    teardown,
  }
}
