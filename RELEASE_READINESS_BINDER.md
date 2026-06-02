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

- [x] Build Valkey 9.1.0 for darwin-arm64 from pinned source (sha=b4fa2913)
- [x] Verify SHA256 of darwin-arm64 binary matches VALKEY_BUILD.json
- [x] Verify LocalFabric tests pass without Valkey binary (6 pass, 0 fail, 2 ValkeyFabric skipped)
- [ ] Run ValkeyFabric integration tests (RUN_VALKEY_TESTS=1) — gated, not yet exercised
- [x] Verify no ioredis import in renderer (packages/app/src — zero matches)
- [ ] Verify app boots in local mode without Valkey installed (needs full Electron build)
- [ ] Build Valkey for darwin-x64, linux-x64, linux-arm64 from pinned source + checksum
- [ ] Codesign binaries for macOS distribution
- [ ] Notarize binaries for macOS distribution
- [x] Document Windows strategy (remote-valkey or WSL — in README.md)

## Valkey Release Shape Proof Results (2026-06-02)

8/8 release shape checks passed:

| # | Check | Result |
|---|-------|--------|
| 1 | No valkey source tree tracked in git | ✅ 0 files |
| 2 | Only intentional valkey resource files tracked | ✅ 6 files (README, COPYING, BUILD.json, binary, supervisor, valkey-fabric) |
| 3 | VALKEY_BUILD.json contains all 11 provenance fields + 64-char SHA256 | ✅ |
| 4 | LocalFabric is default, VALKEY_ENABLED=false, valkey backend gated | ✅ |
| 5 | Valkey binary smoke test (arm64, version 9.1.0, PING/PONG) | ✅ |
| 6 | No ioredis imports in renderer (packages/app/src) | ✅ 0 matches |
| 7 | Platform matrix honest (darwin-arm64 vendored, others marked not-built/unsupported) | ✅ |
| 8 | Release binder has all required sections | ✅ 6/6 sections |
