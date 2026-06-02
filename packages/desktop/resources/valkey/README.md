# Valkey Coordination Sidecar

Valkey is the optional coordination sidecar for live multi-agent orchestration.
It powers realtime agent status, tool scheduling, backpressure, cache fanout, and
the task board live overlay. It is only used when the coordination backend is
set to "local-valkey" or "remote-valkey".

## Default Mode

The default local desktop mode does NOT require Valkey. Tribunus uses LocalFabric
by default, which provides in-memory coordination without any external process.

## macOS Release Support

macOS is fully supported with vendored Valkey 9.1.0 binaries for both
Apple Silicon (arm64) and Intel (x64). Each platform directory includes:
- `bin/valkey-server` — the binary
- `COPYING` — BSD-3-Clause license
- `VALKEY_BUILD.json` — build provenance (source, compiler, flags)
- `SHA256SUMS` — cryptographic hash for integrity verification

## Binary Provenance

- Source: https://github.com/valkey-io/valkey (tag 9.1.0)
- License: BSD-3-Clause
- Build: Clang on macOS, optimized for the target architecture
- Verification: SHA256SUMS in each platform directory; verified at runtime in packaged mode

## Platform Matrix

| Platform        | Status       | Binary         | SHA256 Verified | Notes |
|-----------------|-------------|----------------|-----------------|-------|
| darwin-arm64    | ✅ Vendored  | valkey-server 9.1.0 | ✅ | Built from source, BSD-3-Clause |
| darwin-x64      | ✅ Vendored  | valkey-server 9.1.0 | ✅ | Cross-compiled from arm64, BSD-3-Clause |
| linux-x64       | 🔮 Planned  | —              | — | Can be built from source during release packaging |
| linux-arm64     | 🔮 Planned  | —              | — | Can be built from source during release packaging |
| win32-x64       | ❌ Unsupported | —             | — | Valkey is Unix-first. Windows uses remote-valkey or LocalFabric |

## Runtime Behavior

- Binds 127.0.0.1 only — no external network exposure
- Uses random local port
- No persistence by default (`--save "" --appendonly no`)
- Runtime data stored under `appData/state/valkey`
- Logs stored under `appData/logs`
- Exits cleanly when Tribunus exits
- SHA256 verified at startup in packaged mode

## Future: Team Mode

The vendored Valkey binaries are the foundation for future team collaboration features:
- Shared coordination across LAN/VPN
- Senior sandbox grants
- Shared repo claims
- Peer identity
- Signed approvals
- Multi-user task board

Networked team mode and remote-Valkey are planned post-v1.

## License

Valkey is distributed under the BSD-3-Clause license.
The full license text is preserved in each platform directory.

Valkey is a Redis-compatible fork that retained the BSD license after
Redis changed licensing in 2024.
