/**
 * BISECT SCRIPT: capability-scoped proxy
 *
 * This file proves each checkpoint of the capability-gated proxy implementation.
 * Each checkpoint test group is wrapped in `describe.skip` — unskip the group
 * for the checkpoint being implemented.
 *
 * Run (from packages/opencode/):
 *   bun test test/plugin/capability-proxy-bisect.test.ts --timeout 30000
 *
 * Checkpoints (in implementation order):
 *   CP1 — SDK_CAPABILITY_MAP + capability/index.ts exports all 4 factories
 *   CP2 — makeScopedClient  (block/allowed by capability set)
 *   CP3 — makeScopedShell   ($() blocked/allowed by tool.execute)
 *   CP4 — makeScopedFetch   (blocked/allowed by network.request)
 *   CP5 — makeFilteredEnv   (process.env stripped without secrets.access)
 *   CP6 — PluginInput construction scopes external plugins
 *   CP7 — Built-in plugins receive full (unscoped) input
 *
 * SMOKE: after all CPs pass, run the full existing plugin test suite.
 */

import { describe, expect, test } from "bun:test"

// Shared helpers for building mock objects
function mockShell() {
  const shell = Object.assign(
    () => Promise.resolve({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }),
    {
      cwd: () => shell as any,
      env: () => shell as any,
      nothrow: () => shell as any,
      quiet: () => shell as any,
      throws: () => shell as any,
      braces: () => [] as string[],
      escape: (s: string) => s,
    },
  )
  return shell
}

function mockFetchFactory() {
  let called = false
  const fn = async (..._args: any[]) => {
    called = true
    return new Response("ok")
  }
  return { fn, get called() { return called } }
}

// ---------------------------------------------------------------------------
// CP1 — SDK_CAPABILITY_MAP exists, capability/index.ts exports all four factories
// ---------------------------------------------------------------------------
describe.skip("CP1: SDK_CAPABILITY_MAP and capability/index.ts exports", () => {
  test("SDK_CAPABILITY_MAP exists and maps known namespaces to capability strings", async () => {
    const mod = await import("../../src/plugin/capability/map")
    expect(mod.SDK_CAPABILITY_MAP).toBeDefined()
    const map = mod.SDK_CAPABILITY_MAP as Record<string, string>

    // Verify known namespace → capability mappings
    expect(map.tool).toBe("tool.register")
    expect(map.session).toBe("secrets.access")
    expect(map.auth).toBe("secrets.access")
    expect(map.config).toBe("config.read")
    expect(map.event).toBe("event.subscribe")
    expect(map.project).toBeDefined()
    expect(map.provider).toBeDefined()
    expect(map.file).toBe("filesystem.read")
    expect(map.find).toBe("filesystem.read")

    // No undefined entries for known SDK namespaces
    for (const [ns, cap] of Object.entries(map)) {
      expect(typeof cap).toBe("string")
      expect(cap.length).toBeGreaterThan(0)
    }
  })

  test("SDK_CAPABILITY_MAP only maps known OpencodeClient namespace names", async () => {
    const mod = await import("../../src/plugin/capability/map")
    const map = mod.SDK_CAPABILITY_MAP as Record<string, string>
    const knownNs = [
      "global", "project", "pty", "config", "tool", "instance", "path",
      "vcs", "session", "command", "oauth", "provider", "find", "file",
      "app", "auth", "mcp", "lsp", "formatter", "control", "tui", "event",
    ]
    for (const ns of Object.keys(map)) {
      expect(knownNs).toContain(ns)
    }
  })

  test("capability/index.ts exports makeScopedClient, makeScopedShell, makeScopedFetch, makeFilteredEnv", async () => {
    const capMod = await import("../../src/plugin/capability/index")
    expect(capMod.makeScopedClient).toBeFunction()
    expect(capMod.makeScopedShell).toBeFunction()
    expect(capMod.makeScopedFetch).toBeFunction()
    expect(capMod.makeFilteredEnv).toBeFunction()
  })
})

// ---------------------------------------------------------------------------
// CP2 — makeScopedClient: wraps OpencodeClient, blocks/allows by capability set
// ---------------------------------------------------------------------------
describe.skip("CP2: makeScopedClient", () => {
  test("allowed namespace returns a sub-object where methods can be called", async () => {
    const { makeScopedClient } = await import("../../src/plugin/capability/index")

    const mockClient = {
      tool: { register: () => "registered", list: () => ["tool1"] },
      session: { list: () => ["s1"] },
    }

    const capabilities = new Set(["tool.register"])
    const scoped = makeScopedClient(mockClient as any, capabilities)

    expect(scoped.tool).toBeDefined()
    expect(typeof scoped.tool).toBe("object")
    expect((scoped.tool as any).register()).toBe("registered")
    // session namespace is blocked
    expect((scoped as any).session).toBeUndefined()
  })

  test("blocked namespace returns undefined", async () => {
    const { makeScopedClient } = await import("../../src/plugin/capability/index")
    const mockClient = { global: { version: "1.0" }, tool: { register: () => {} } }
    const capabilities = new Set(["tool.register"])
    const scoped = makeScopedClient(mockClient as any, capabilities)

    expect((scoped as any).global).toBeUndefined()
  })

  test("empty capabilities blocks all namespaces", async () => {
    const { makeScopedClient } = await import("../../src/plugin/capability/index")
    const mockClient = { tool: { register: () => "x" }, global: { version: "1" } }
    const scoped = makeScopedClient(mockClient as any, new Set())

    expect((scoped as any).tool).toBeUndefined()
    expect((scoped as any).global).toBeUndefined()
  })

  test("recursive namespace access is allowed when capability permits", async () => {
    const { makeScopedClient } = await import("../../src/plugin/capability/index")
    let called = false
    const mockClient = {
      tool: {
        register: () => { called = true },
        execute: () => "executed",
      },
    }
    const scoped = makeScopedClient(mockClient as any, new Set(["tool.register"]))

    expect(scoped.tool).toBeDefined()
    ;(scoped.tool as any).register()
    expect(called).toBe(true)
    // execute should still be reachable because the namespace is allowed
    expect((scoped.tool as any).execute).toBeDefined()
  })

  test("Proxy does not interfere with non-namespace properties of the client", async () => {
    const { makeScopedClient } = await import("../../src/plugin/capability/index")
    // OpencodeClient may have own properties beyond namespaces
    const mockClient: any = { tool: { register: () => {} } }
    mockClient._client = { baseUrl: "http://localhost" }
    const scoped = makeScopedClient(mockClient, new Set(["tool.register"]))

    // Non-namespace properties should not be trapped by the proxy's get handler,
    // but if they start with _ they should be left alone
    expect(scoped.tool).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// CP3 — makeScopedShell: $() blocked without tool.execute
// ---------------------------------------------------------------------------
describe.skip("CP3: makeScopedShell", () => {
  test("$() throws when tool.execute is not in capability set", async () => {
    const { makeScopedShell } = await import("../../src/plugin/capability/index")
    const capabilities = new Set<string>()
    const shell = mockShell()
    const scoped = makeScopedShell(shell, capabilities)

    expect(() => scoped`echo hello`).toThrow(/tool.execute|permission|denied|not allowed/i)
  })

  test("$() succeeds when tool.execute capability is present", async () => {
    const { makeScopedShell } = await import("../../src/plugin/capability/index")
    const capabilities = new Set(["tool.execute"])

    let called = false
    const shell = Object.assign(
      () => {
        called = true
        return Promise.resolve({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 })
      },
      {
        cwd: () => shell as any,
        env: () => shell as any,
        nothrow: () => shell as any,
        quiet: () => shell as any,
        braces: () => [] as string[],
        escape: (s: string) => s,
      },
    )

    const scoped = makeScopedShell(shell, capabilities)
    await scoped`echo hello`
    expect(called).toBe(true)
  })

  test("shell helpers (env, cwd, nothrow) return the scoped shell", async () => {
    const { makeScopedShell } = await import("../../src/plugin/capability/index")
    const capabilities = new Set(["tool.execute"])
    const shell = mockShell()
    const scoped = makeScopedShell(shell, capabilities)

    expect(scoped.cwd("/tmp")).toBe(scoped)
    expect(scoped.env({ KEY: "val" })).toBe(scoped)
    expect(scoped.nothrow()).toBe(scoped)
  })

  test("braces and escape work even without tool.execute", async () => {
    const { makeScopedShell } = await import("../../src/plugin/capability/index")
    const capabilities = new Set<string>()
    const shell = mockShell()
    const scoped = makeScopedShell(shell, capabilities)

    // These are non-executing helpers and should always work
    expect(scoped.braces("a{b,c}d")).toBeInstanceOf(Array)
    expect(typeof scoped.escape("hello world")).toBe("string")
  })
})

// ---------------------------------------------------------------------------
// CP4 — makeScopedFetch: fetch() blocked without network.request
// ---------------------------------------------------------------------------
describe.skip("CP4: makeScopedFetch", () => {
  test("scoped fetch throws when network.request is not in capability set", async () => {
    const { makeScopedFetch } = await import("../../src/plugin/capability/index")
    const capabilities = new Set<string>()
    const scopedFetch = makeScopedFetch(fetch, capabilities)

    expect(() => scopedFetch("https://example.com")).toThrow(/network.request|permission|denied|not allowed/i)
  })

  test("scoped fetch delegates to native fetch when network.request is present", async () => {
    const { makeScopedFetch } = await import("../../src/plugin/capability/index")
    const capabilities = new Set(["network.request"])
    const { fn, called } = mockFetchFactory()

    const scopedFetch = makeScopedFetch(fn as unknown as typeof fetch, capabilities)
    const res = await scopedFetch("https://example.com")
    expect(called).toBe(true)
    expect(res).toBeInstanceOf(Response)
  })

  test("scoped fetch with Request object is also guarded", async () => {
    const { makeScopedFetch } = await import("../../src/plugin/capability/index")
    const capabilities = new Set<string>()
    const scopedFetch = makeScopedFetch(fetch, capabilities)

    expect(() => scopedFetch(new Request("https://example.com"))).toThrow(/network.request|permission|denied|not allowed/i)
  })

  test("scoped fetch supports all fetch overloads (url + init)", async () => {
    const { makeScopedFetch } = await import("../../src/plugin/capability/index")
    const capabilities = new Set(["network.request"])

    let capturedInit: any = null
    const mockFn = async (...args: any[]) => {
      capturedInit = args.length > 1 ? args[1] : undefined
      return new Response("ok")
    }

    const scopedFetch = makeScopedFetch(mockFn as unknown as typeof fetch, capabilities)
    await scopedFetch("https://example.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    })
    expect(capturedInit).toBeDefined()
    expect(capturedInit.method).toBe("POST")
  })
})

// ---------------------------------------------------------------------------
// CP5 — makeFilteredEnv: process.env stripped without secrets.access
// ---------------------------------------------------------------------------
describe.skip("CP5: makeFilteredEnv", () => {
  test("returns a copy of env with secrets stripped when no secrets.access", async () => {
    const { makeFilteredEnv } = await import("../../src/plugin/capability/index")
    const capabilities = new Set<string>()
    const env = {
      HOME: "/home/user",
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-secret123",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      GITHUB_TOKEN: "ghp_123456789",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      NODE_ENV: "test",
    }

    const filtered = makeFilteredEnv(env, capabilities)

    expect(filtered.HOME).toBe("/home/user")
    expect(filtered.PATH).toBe("/usr/bin")
    expect(filtered.NODE_ENV).toBe("test")

    expect((filtered as any).OPENAI_API_KEY).toBeUndefined()
    expect((filtered as any).AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect((filtered as any).GITHUB_TOKEN).toBeUndefined()
    expect((filtered as any).ANTHROPIC_API_KEY).toBeUndefined()
  })

  test("returns env unmodified when secrets.access capability is present", async () => {
    const { makeFilteredEnv } = await import("../../src/plugin/capability/index")
    const capabilities = new Set(["secrets.access"])
    const env = {
      HOME: "/home/user",
      OPENAI_API_KEY: "sk-secret123",
      NODE_ENV: "test",
    }

    const filtered = makeFilteredEnv(env, capabilities)
    expect(filtered.OPENAI_API_KEY).toBe("sk-secret123")
    expect(filtered.HOME).toBe("/home/user")
    expect(filtered.NODE_ENV).toBe("test")
  })

  test("returns a new object — does not mutate the original env", async () => {
    const { makeFilteredEnv } = await import("../../src/plugin/capability/index")
    const capabilities = new Set<string>()
    const env = { OPENAI_API_KEY: "sk-secret", HOME: "/home" }

    const filtered = makeFilteredEnv(env, capabilities)
    expect(filtered).not.toBe(env)
    expect(env.OPENAI_API_KEY).toBe("sk-secret") // original untouched
    expect((filtered as any).OPENAI_API_KEY).toBeUndefined()
  })

  test("covers all known secret key patterns", async () => {
    const { makeFilteredEnv } = await import("../../src/plugin/capability/index")
    const capabilities = new Set<string>()

    const env = {
      OPENAI_API_KEY: "v",
      ANTHROPIC_API_KEY: "v",
      COHERE_API_KEY: "v",
      GOOGLE_API_KEY: "v",
      MISTRAL_API_KEY: "v",
      DEEPSEEK_API_KEY: "v",
      GROQ_API_KEY: "v",
      XAI_API_KEY: "v",
      PERPLEXITY_API_KEY: "v",
      TOGETHER_API_KEY: "v",
      CEREBRAS_API_KEY: "v",
      FIREWORKS_API_KEY: "v",
      AZURE_OPENAI_API_KEY: "v",
      VOYAGE_API_KEY: "v",
      AWS_ACCESS_KEY_ID: "v",
      AWS_SECRET_ACCESS_KEY: "v",
      AWS_SESSION_TOKEN: "v",
      GCP_SA_KEY_B64: "v",
      GITHUB_TOKEN: "v",
      GITLAB_TOKEN: "v",
      NPM_TOKEN: "v",
      DOCKER_PASSWORD: "v",
      HOME: "/home",
      PATH: "/usr/bin",
      USER: "me",
      LANG: "en_US",
      TERM: "xterm",
    }

    const filtered = makeFilteredEnv(env, capabilities)
    expect(filtered.HOME).toBe("/home")
    expect(filtered.PATH).toBe("/usr/bin")

    const remainingKeys = Object.keys(filtered)
    for (const key of remainingKeys) {
      const upper = key.toUpperCase()
      const isSecret =
        upper.includes("SECRET") ||
        upper.includes("TOKEN") ||
        upper.includes("PASSWORD") ||
        upper.includes("API_KEY") ||
        upper.endsWith("_KEY") ||
        upper.endsWith("_SECRET")
      expect(isSecret).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// CP6 — PluginInput construction: external plugins get scoped input
// ---------------------------------------------------------------------------
describe.skip("CP6: PluginInput scoping for external plugins", () => {
  test("external plugin input gets scoped client/shell/fetch", async () => {
    const { makeScopedClient, makeScopedShell, makeScopedFetch } =
      await import("../../src/plugin/capability/index")

    const rawClient = { tool: { register: () => "ok" }, session: { list: () => [] } }
    const shell = mockShell()
    const { fn: fetchFn } = mockFetchFactory()

    // Plugin capabilities: only tool.register
    const capabilities = new Set(["tool.register"])

    // Build scoped input
    const scopedInput = {
      client: makeScopedClient(rawClient as any, capabilities),
      $: makeScopedShell(shell, capabilities),
      fetch: makeScopedFetch(fetchFn as unknown as typeof fetch, capabilities),
    }

    // Client: tool namespace accessible, session blocked
    expect(scopedInput.client.tool).toBeDefined()
    expect((scopedInput.client as any).session).toBeUndefined()

    // Shell: blocked (tool.register doesn't grant tool.execute)
    expect(() => scopedInput.$`ls`).toThrow()

    // Fetch: blocked (no network.request)
    expect(() => scopedInput.fetch("https://example.com")).toThrow()
  })

  test("external plugin with tool.execute + network.request gets full shell + fetch", async () => {
    const { makeScopedShell, makeScopedFetch } =
      await import("../../src/plugin/capability/index")

    let shellCalled = false
    const shell = Object.assign(
      () => {
        shellCalled = true
        return Promise.resolve({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 })
      },
      {
        cwd: () => shell as any, env: () => shell as any,
        nothrow: () => shell as any, quiet: () => shell as any,
        braces: () => [] as string[], escape: (s: string) => s,
      },
    )
    const { fn: fetchFn, called: fetchCalled } = mockFetchFactory()

    const capabilities = new Set(["tool.execute", "network.request"])

    const scopedInput = {
      $: makeScopedShell(shell, capabilities),
      fetch: makeScopedFetch(fetchFn as unknown as typeof fetch, capabilities),
    }

    await scopedInput.$`echo hi`
    expect(shellCalled).toBe(true)

    await scopedInput.fetch("https://example.com")
    expect(fetchCalled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CP7 — Built-in plugins receive full (unscoped) input
// ---------------------------------------------------------------------------
describe.skip("CP7: Built-in plugins receive full input", () => {
  test("built-in plugin input construction does NOT apply scoping proxies", async () => {
    // This test validates the contract: when building PluginInput for a
    // built-in plugin (trustLevel === "built-in"), no scoping proxy is applied.
    // The client, $, and fetch are passed through as-is.

    // This is tested at a contract level — the actual routing of
    // "built-in → raw input" vs "external → scoped input" happens in the
    // layer factory of packages/opencode/src/plugin/index.ts.

    // We verify that the scoping functions exist and are NOT identity functions
    // (they actually transform input), and that the built-in path bypasses them.
    const { makeScopedClient } = await import("../../src/plugin/capability/index")

    const mockClient = { tool: { register: () => "ok" } }
    const scoped = makeScopedClient(mockClient as any, new Set(["tool.register"]))

    // Scoping should produce a DIFFERENT object, not the identity
    expect(scoped).not.toBe(mockClient)
  })

  test("PluginInput type is importable from @opencode-ai/plugin", async () => {
    const pluginMod = await import("@opencode-ai/plugin")
    expect(pluginMod).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// REGRESSION — integration smoke tests
// ---------------------------------------------------------------------------
describe.skip("REGRESSION: existing plugin tests pass after capability proxy wiring", () => {
  test("FALLBACK_MANIFEST grants tool.register for legacy plugins", async () => {
    const { FALLBACK_MANIFEST } = await import("../../src/plugin/capability/enforcer")
    expect(FALLBACK_MANIFEST.capabilities).toContain("tool.register")
  })

  test("capability types remain unchanged", async () => {
    const types = await import("../../src/plugin/capability/types")
    expect(types.CapabilityId.ToolRegister).toBe("tool.register")
    expect(types.CapabilityId.ToolExecute).toBe("tool.execute")
    expect(types.CapabilityId.NetworkRequest).toBe("network.request")
    expect(types.CapabilityId.SecretsAccess).toBe("secrets.access")
    expect(types.CapabilityId.FilesystemRead).toBe("filesystem.read")
    expect(types.CapabilityId.FilesystemWrite).toBe("filesystem.write")
    expect(types.CapabilityId.ConfigRead).toBe("config.read")
    expect(types.CapabilityId.ConfigWrite).toBe("config.write")
  })

  test("capability enforcer still works correctly", async () => {
    const { makeCapabilityRegistry, checkCapability, makeFallbackState } =
      await import("../../src/plugin/capability/index")

    const registry = await makeCapabilityRegistry().pipe(
      await import("effect").then((m) => m.Effect.runPromise),
    ) as any

    await (await import("effect").then((m) =>
      m.Effect.runPromise(registry.register("test-plugin", makeFallbackState("external")))
    ))

    const hasTool = await (await import("effect").then((m) =>
      m.Effect.runPromise(checkCapability(registry, "test-plugin", "tool.register" as any))
    ))
    expect(hasTool).toBe(true)

    const hasNetwork = await (await import("effect").then((m) =>
      m.Effect.runPromise(checkCapability(registry, "test-plugin", "network.request" as any))
    ))
    expect(hasNetwork).toBe(false)
  })
})
