# Valkey Coordination Sidecar

Valkey is an optional coordination sidecar used for live agent coordination
in team/distributed mode. It is only used when the coordination backend is
set to "local-valkey" or "remote-valkey".

## Default Mode

The default local desktop mode does NOT require Valkey. The app uses LocalFabric
by default, which provides in-memory coordination without any external process.

## Binary

The `darwin-arm64` binary is built from Valkey 9.1.0 source:
- Source: https://github.com/valkey-io/valkey
- License: BSD-3-Clause (see darwin-arm64/COPYING)
- Build provenance: darwin-arm64/VALKEY_BUILD.json

## Platform Support

Only darwin-arm64 is currently vendored. Other platforms will be added
as the Valkey coordination feature matures.

## License

Valkey is distributed under the BSD-3-Clause license.
The full license text is preserved in each platform directory.

Valkey is a Redis-compatible fork that retained the BSD license after
Redis changed licensing in 2024.

## Platform Matrix

| Platform        | Status      | Binary    | Notes |
|-----------------|-------------|-----------|-------|
| darwin-arm64    | ✅ Vendored  | valkey-server 9.1.0 | Built from source, BSD-3-Clause |
| darwin-x64      | ❌ Not built | — | Needs cross-compilation or native build |
| linux-x64       | ❌ Not built | — | Can be built from source during release packaging |
| linux-arm64     | ❌ Not built | — | Can be built from source during release packaging |
| win32-x64       | ❌ Not supported | — | Valkey is Unix-first. Windows needs WSL, remote-Valkey-only, or alternative |

## Windows Strategy

Valkey/Redis-style servers are Unix-first. On Windows:
- **Local dev**: Use LocalFabric (default, no Valkey needed)
- **Team mode**: Connect to a remote Valkey instance (remote-valkey backend)
- **Future**: Evaluate WSL-based local Valkey or a Windows-compatible coordination alternative
