# Tribunus Identity Settlement v1 — Gate Summary

Generated: 2026-06-08
Commit: 627cbe907f667d0b7891708ece90ec14df8e6ac0

## Gate Status

| # | Gate | Status |
|---|---|---|
| 1 | Public Identity | **PASS** — README.md, root docs, package metadata, repository identity are Tribunus |
| 2 | Governance Identity | **PASS** — CONTRIBUTING.md, SECURITY.md, SUPPORT.md, GOVERNANCE.md are Tribunus-native |
| 3 | Source Identity | **DEFERRED** — `packages/opencode` directory and `@opencode-ai/*` workspaces still use legacy names |
| 4 | Configuration Identity | **PASS** — `.tribunus/`, `tribunus.jsonc`, compat readers created |
| 5 | Compatibility Discipline | **PASS** — centralized readers for env, config, headers, deep links; one-way migration implemented |
| 6 | Runtime Identity | **DEFERRED** — pending SourceIdentity cutover |
| 7 | Artifact Identity | **PASS** — desktop package.json, electron-builder, metainfo.xml updated |
| 8 | Attribution Integrity | **PASS** — NOTICE.md preserves upstream MIT attribution |
| 9 | Repository Hygiene | **PASS** — stale translations deleted, temp files scrubbed, heavy artifacts gitignored |
| 10 | Enforcement | **PASS** — typed verifier + CI job in `.github/workflows/identity-boundary.yml` |
| 11 | Zero Unresolved Identity | **BLOCKED** — 42,176 legacy references remain; all are internal package/directory names pending SourceIdentity cutover |

## Artifacts Produced

| Artifact | Path |
|---|---|
| Identity Manifest | `schemas/identity/tribunus-identity.v1.json` |
| Identity Schema | `schemas/identity/tribunus-identity.v1.schema.json` |
| Legacy Registry Schema | `schemas/identity/legacy-reference-registry.v1.schema.json` |
| Inventory (before) | `artifacts/identity/identity-inventory.before.json` |
| Verification Receipt | `artifacts/identity/identity-verification.receipt.json` |
| Verifier Script | `scripts/identity/verify-identity.ts` |
| CI Enforcement | `.github/workflows/identity-boundary.yml` |
| Compatibility Doc | `docs/compatibility/opencode-migration.md` |
| Identity Architecture | `docs/architecture/identity-boundary.md` |
| Capability Matrix | `docs/status/capability-matrix.json` |
| Env Compat Reader | `packages/opencode/src/config/compat-env.ts` |
| Config Compat Reader | `packages/opencode/src/config/compat-config.ts` |
| Header Compat Reader | `packages/opencode/src/http/compat-headers.ts` |
| Deep Link Handler | `packages/app/src/utils/compat-deep-links.ts` |

## Public Documents

| Document | Status |
|---|---|
| README.md | Tribunus-native |
| CONTRIBUTING.md | Tribunus-native — maintainer-directed model |
| SECURITY.md | Tribunus-native — contact: security@tribunus.dev |
| SUPPORT.md | Created |
| GOVERNANCE.md | Created |
| NOTICE.md | Created — preserves upstream attribution |
| CODE_OF_CONDUCT.md | Deferred (not yet created) |
| BRANDING.md | Existing — classification system defined |

## Remaining Work — Source Identity Cutover Campaign

The following tasks require a dedicated campaign due to the blast radius (~2,600 files):

1. Rename `packages/opencode` → `packages/runtime`
2. Rename `@opencode-ai/*` workspaces → `@tribunus/*`
3. Update all imports, package.json dependencies, CI workflows, build scripts, Nix expressions
4. Regenerate SDK types and OpenAPI specs
5. Run full test suite and fix breakage
6. Populate `schemas/identity/legacy-reference-registry.v1.json` with classified exceptions
7. Re-run verifier to get clean receipt

## Scanner Summary

- Files scanned: 4,107
- Legacy occurrences: 42,176
- Categories: package-name (32,811), opencode-ai-url (3,743), opencode-ai-npm-scope (2,563), opencode-fs-path (1,812), path-name (1,236)
