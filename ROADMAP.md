# Tribunus Roadmap

## Completed

### Effect Runtime and Lifecycle Consolidation
DesktopRuntime owns the Electron process lifetime. One ManagedRuntime, scoped resources, supervised startup, idempotent shutdown wired through all quit paths. `@opencode/` → `@tribunus/` service tag migration across 119 runtime files. Sidecar exit-code-1 root cause repaired (duplicate `serverLayer` EADDRINUSE, missing `ensureDirectories`, `CapabilityToolRegistry` service name).

### IPC Contract Spine v1
Versioned wire protocol (`IpcOk`/`IpcErr` envelopes), public error vocabulary (10 codes, 3 recoverability levels), contract registry, schema-compat façade for Effect beta.66. `registerIpcEffectHandler` adapter with sender authorization, `typedInvokeV2` preload client with production structural validation. 50 invoke methods migrated across store, init, filesystem, GitHub, and secrets domains onto `Effect.tryPromise` with typed error mapping.

### Desktop Runtime Surface Activation v1
`DesktopRuntimeProvider` (SolidJS context, 5 state domains), system-status panel, global health indicator, IPC error toast, window-role model replacing URL substring matching. Coordination projection service with snapshot/delta model, sequence-gap detection, resynchronization, and disposable subscriptions scoped under DesktopRuntime. Preload subscription contract (`getCoordinationSnapshot`, `subscribeCoordinationProjection`, `requestCoordinationResync`). Navigation security hardened (URL-parsing-based CSP, sender authorization, oc:// protocol handling).

### Qualification Infrastructure
IPC-over-stdio qualification driver (schema-validated, 12 commands, `app.isPackaged` guard). Qualification harness class with `Promise.withResolvers`. 18 qualification tests across RC-09/10/11/13 domains. Desktop test failure inventory classified. Build pipeline repaired (`../opencode` → `../runtime` paths in prebuild, predev, electron-vite config).

---

## Current Campaign

### Governed Execution Platform v1

The authority model that agents, local inference, collaboration, and distributed compute all depend on.

#### Phase 1: Plugin Manifests and Capability Declarations
- Plugin manifests with declared capabilities, activation scopes, and resource budgets
- Capability declarations: filesystem boundaries, network policy, secret access, shell access
- Lifecycle ownership: activate, suspend, revoke, audit receipts
- Each capability has a typed implementation contract and a preload-visible permission surface
- Renderer projection: active plugins, granted capabilities, revocation state

#### Phase 2: Supervised Agent Execution
- Single-machine agent runtime under Effect supervision
- Valkey-coordinated work scheduling, claims, retries, dead letters
- Durable work truth in PGlite/PostgreSQL
- Agents consume only governed capabilities
- Lifecycle projections streamed into the renderer: queue state, active attempts, agent status, recovery state
- Survives cancellation, restart, and crash recovery

#### Phase 3: Local Inference Providers
- Generic compute interface: cloud API, llama.cpp (cross-platform CPU/GPU), MLX (Apple silicon)
- Agent scheduler selects provider without changing agent contract
- Profiling evidence collected before Tribunus Rust compute kernel optimization
- Each provider is a governed capability with resource budgets and lifecycle

#### Phase 4: Collaboration Authority
- Durable intentions, receipts, projections, approvals, presence, shared artifacts
- Synchronization does not distribute raw mutable application state
- Local authority model must be correct first — collaboration multiplies ambiguity
- Renderer projections: presence, pending approvals, shared artifact state

#### Phase 5: Distributed Compute Federation
- Identity, node enrollment, resource advertisement, capability negotiation
- Model availability, job leasing, heartbeats, cancellation, result verification
- Privacy policy, accounting, abuse controls, recovery from disappearing workers
- Valkey Streams for delivery, consumer groups, pending work, acknowledgements
- Durable authority remains with PGlite/PostgreSQL

---

## Continuous Platform Validation (All Phases)

Lightweight GitHub Actions matrix on macOS, Windows, and Linux:

- Compilation and typecheck
- Dependency resolution and native-module availability
- Minimal launch smoke (unpacked development build)
- Does not produce signed installers, notarization, update feeds, or full installer qualification

Full packaging campaign (signing, notarization, installers, update feeds, migration matrices, accessibility, release evidence) deferred until the five execution platform systems have stable contracts.

---

## Dependency Chain

```
governed capabilities & plugins
    → supervised agents
        → local compute providers
            → collaboration authority
                → distributed compute federation
```

Each vertical includes its renderer projection, controls, failure states, recovery actions, and qualification journey before the next begins. No invisible backend systems — surface each one through the projection architecture.
