# Valkey Coordination — Release Readiness Binder

## Binary Provenance

| Attribute | Value |
|-----------|-------|
| Binary | packages/desktop/resources/valkey/darwin-arm64/bin/valkey-server |
| Source | https://github.com/valkey-io/valkey |
| Version | 9.1.0 |
| Tag | 9.1.0 |
| License | BSD-3-Clause |
| SHA256 | `464876c1bf14abfe7fe04af7eeaf4347a480c428e541e2f67b969527c394b002` |
| Platform | darwin-arm64 |
| Build Host | local-dev |
| Codesigned | No |
| Notarized | No |

## License Compliance

- Valkey is BSD-3-Clause licensed (a permissive license)
- The full license text is preserved at packages/desktop/resources/valkey/darwin-arm64/COPYING
- BSD-style redistribution requires preserving copyright and license notices
- This is satisfied by the COPYING file included with the binary

## Repo Hygiene

- [x] Valkey source tree removed from Git (valkey-9.1.0/)
- [x] .gitignore entries for valkey source drops and runtime state
- [x] Binary stored at packages/desktop/resources/valkey/<platform>/bin/
- [x] Build provenance manifest at packages/desktop/resources/valkey/<platform>/VALKEY_BUILD.json
- [x] License copy at packages/desktop/resources/valkey/<platform>/COPYING
- [x] README.md explaining optional coordination sidecar
- [ ] Codesigning (not yet done — local dev build)
- [ ] Notarization (not yet done — local dev build)

## Platform Gaps

Only darwin-arm64 is currently vendored. Before shipping to users on other platforms:
- darwin-x64: Build Valkey 9.1.0 on Intel Mac or cross-compile
- linux-x64: Build in CI during release packaging or use Docker
- linux-arm64: Build on ARM Linux or cross-compile
- win32-x64: Not supported by Valkey natively — needs WSL or remote-only strategy

## Feature Gates

- VALKEY_ENABLED = false by default (in coordination/fabric.ts)
- LocalFabric is the default coordination backend
- App boots without Valkey binary
- local-valkey is opt-in via environment variable + feature flag

## Diagnostics

- Valkey supervisor exports getDiagnostics()
- Diagnostics available via /global/diagnostics when enabled
- Shows: available, enabled, platform, binary path, version, pid, ready state

## Release Checklist

- [ ] Build Valkey for all target platforms from pinned source + checksum
- [ ] Verify SHA256 of each binary matches VALKEY_BUILD.json
- [ ] Run ValkeyFabric integration tests (RUN_VALKEY_TESTS=1)
- [ ] Verify LocalFabric tests pass without Valkey binary
- [ ] Verify app boots in local mode without Valkey installed
- [ ] Verify no ioredis import in renderer bundles
- [ ] Codesign binaries for macOS distribution
- [ ] Notarize binaries for macOS distribution
- [ ] Document Windows strategy (remote-valkey or WSL)
