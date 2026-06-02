# Tribunus

Local-first control plane for agentic engineering.

Tribunus coordinates coding agents with realtime task boards, tool queues,
capacity-aware scheduling, workflow gates, and release-readiness evidence.
It starts as a macOS desktop cockpit with a local coordination engine,
with a longer-term path toward secure team collaboration.

[![macOS active](https://img.shields.io/badge/macOS-active-4c1?style=flat-square)](https://tribunus.dev)
[![Valkey 9.1.0 bundled](https://img.shields.io/badge/Valkey-9.1.0%20bundled-036?style=flat-square)](https://valkey.io)
[![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange?style=flat-square)](https://tribunus.dev)

## Why Tribunus

Coding agents are cheap to spawn but expensive to coordinate. Teams need
queues, claims, gates, visibility, and evidence. Tribunus provides the
real-time control plane that makes multi-agent engineering operational —
you can see, constrain, queue, audit, and review agent work across
repositories in real time.

## What It Does Today

- **macOS desktop cockpit** — Electron app with sidecar runtime, project activation, and operator IDE surfaces
- **Local Valkey coordination** — Bundled Valkey 9.1.0 for darwin-arm64 and darwin-x64 with SHA256 verification; powers realtime task boards, tool scheduling, and cache fanout
- **Tool execution scheduler** — Resource-class queues (read_light, search_medium, cpu_heavy, io_heavy, exclusive_repo, network) prevent agent swarms from saturating the machine
- **Single-flight cache** — Identical expensive tool calls (typecheck, build, test) deduplicate; one execution fans out to all waiters
- **Capacity profiler** — Hardware-adaptive scheduler limits derived from CPU cores, memory class, and disk throughput; M1 Air gets conservative limits, M3 Max gets room to run
- **Workflow presets** — Quick Fix, Frontend Polish, Backend Hardening, Security Review, Enterprise Closure, and more; each defines agent roles, validation gates, tool policies, and required outputs
- **Desktop secret store** — OS-encrypted provider/GitHub credentials via Electron safeStorage; renderer sees metadata only, sidecar receives secrets by ref only when needed
- **Desktop notifications** — High-signal events only (agent blocked, review required, release binder complete, sidecar failed); per-kind toggles, quiet hours
- **Release binder** — Structured audit evidence: what changed, what passed, what failed, platform matrix, known limitations, release recommendation
- **`.tribunus/` project config** — Repo-local declarative policy: workflows, sandbox templates, protected paths, tool policies; committed and reviewable; runtime state stays in appData

## Current Status

Tribunus is in active development. macOS is the first platform.

| Item | Status |
|------|--------|
| macOS desktop app | Active development |
| Local Valkey coordination | Bundled, SHA256 verified, PONG-proven |
| Tool scheduler / cache | Primitives in place, local scheduler functional |
| Workflow presets | 8 presets, UI designer, execution engine scaffold |
| Project activation | Single-owner state machine, typed readiness contract |
| Secret store + notifications | Desktop services in Electron main |
| Team collaboration | Foundation present; full networked team mode not shipped |
| Linux / Windows | Planned; LocalFabric fallback available |

## Quick Start

```bash
# Install dependencies
bun install

# Run typecheck
cd packages/desktop && bun run typecheck

# Run tests
cd packages/opencode && bun test

# Run the desktop app (dev mode)
bun run dev:desktop

# Run branding guard
bash scripts/check-branding.sh

# Run Valkey smoke test
cd packages/desktop && bun run scripts/smoke-valkey-packaged.ts .
```

## macOS Valkey Coordination

Tribunus bundles Valkey 9.1.0 for Apple Silicon (arm64) and Intel (x64).
Each platform directory includes the binary, BSD-3-Clause COPYING, build
provenance (VALKEY_BUILD.json), and SHA256SUMS for integrity verification.

- Binds 127.0.0.1 only — no external network exposure
- Uses a random local port
- No persistence by default
- Exits cleanly when the app exits
- SHA256 verified at startup in packaged mode

Valkey is the live coordination substrate — it powers queues, leases,
pub/sub, and cache. The durable database (PGlite) remains the source of truth.

## Project Configuration

Tribunus uses two config layers:

**`.tribunus/`** — Repo-local declarative project policy. Commit this.
Contains workflows, sandbox templates, protected paths, tool policies,
and agent profiles. JSON config is loaded automatically; executable
code (plugin.ts, tools/*.ts) requires workspace trust.

**appData** — Local runtime state. Never commit this.
Contains PGlite database, Valkey runtime, secret metadata, logs,
caches, and debug bundles.

Safety invariants (secret redaction, path scope restrictions, unsafe
git prohibitions, audit event recording, tool permission enforcement,
runtime artifact hygiene) cannot be disabled by any config layer.

## Architecture

```
Electron main
  ├── Sidecar supervisor
  ├── Optional Valkey supervisor
  ├── IPC contract + runtime decode
  ├── Desktop secret store
  └── Desktop notification service

Sidecar / Runtime
  ├── PGlite durable database
  ├── Coordination fabric (local or Valkey)
  ├── Tool scheduler + single-flight cache
  ├── Capacity profiler + pressure monitor
  ├── Project / session / tool runtime
  └── Diagnostics

Renderer
  ├── Project activation machine
  ├── Realtime task board overlay
  ├── Operator IDE surfaces
  ├── Workflow designer
  └── Performance profile panel
```

## Roadmap

**Near-term**
- Packaged macOS smoke test
- Project/session activation closure
- Realtime task board vertical slice
- Public alpha release

**Later**
- LAN/VPN team coordinator
- Senior/junior sandbox grants
- Shared repo claims
- Peer identity + signed approvals
- Multi-user task board
- Linux / Windows support

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Early contributions are welcome. The project is macOS-first and uses Bun
as the primary runtime. TypeScript throughout. AGPLv3 with dual-licensing.

## Upstream Attribution

Tribunus began as a derivative of [opencode](https://github.com/sst/opencode)
and has since diverged toward local-first multi-agent engineering orchestration.
Upstream notices and licenses are preserved in [NOTICE.md](NOTICE.md).

## License

Tribunus is licensed under the GNU Affero General Public License v3.0 (AGPLv3).
A separate commercial license may be obtained — contact hello@tribunus.dev.

See [LICENSE](LICENSE) for the full text.
