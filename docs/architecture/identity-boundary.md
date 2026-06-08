# Identity Boundary — Tribunus Canonical Identity Architecture

## Overview

The Identity Boundary defines how Tribunus establishes and enforces a single canonical identity across the entire project. It governs every naming decision — from the `canonicalProductName` and `canonicalRepository` down to environment variable prefixes, HTTP headers, protocol schemes, deep-link schemas, and desktop bundle identifiers. The system comprises three layers:

1. **The Canonical Identity Manifest** — the single source of truth for every Tribunus identifier.
2. **The Legacy Reference Registry** — a governed allowlist documenting every retained reference to the predecessor project (OpenCode), with explicit classification, lifecycle, and removal gates.
3. **The Identity Scanner** — a verification tool that inventories all legacy references, validates the registry, and gates the release pipeline.

## Canonical Identity Manifest

**File**: `schemas/identity/tribunus-identity.v1.json`
**Schema**: `schemas/identity/tribunus-identity.v1.schema.json`

The identity manifest is a JSON document validated against a JSON Schema (2020-12) that declares every canonical identifier used across the Tribunus ecosystem. Every subsystem — build scripts, desktop app, CLI, SDK, infrastructure, documentation, and package publishing — derives its naming from this manifest. No identifier is hard-coded outside this file.

### Manifest Fields

| Field | Value | Purpose |
|-------|-------|---------|
| `canonicalProductName` | `Tribunus` | Human-facing product name in UI, docs, and marketing. |
| `canonicalRepository` | `Tribunus-dev/Tribunus` | GitHub repository identifier (owner/repo). |
| `canonicalDomain` | `tribunus.dev` | Primary web domain for docs, API, and product site. |
| `canonicalExecutable` | `tribunus` | Binary/executable name on disk. |
| `canonicalCliInvocation` | `tribunus` | Command-line invocation name. |
| `canonicalProjectDir` | `.tribunus` | Hidden project configuration directory. |
| `canonicalConfigFile` | `tribunus.jsonc` | Project configuration filename. |
| `canonicalEnvPrefix` | `TRIBUNUS_` | Prefix for all environment variables. |
| `canonicalProtocolScheme` | `tribunus://` | URI scheme for deep links and protocol handlers. |
| `canonicalHttpHeaderPrefix` | `x-tribunus-` | Prefix for custom HTTP headers. |
| `canonicalPackageScope` | `@tribunus` | NPM/GitHub package scope. |
| `desktopProductName` | `Tribunus` | Product name in desktop menus, dock, and About dialog. |
| `desktopBundleId` | `dev.tribunus.desktop` | macOS bundle identifier. |
| `desktopAppSupportDir` | `Application Support/Tribunus` | Platform app support directory. |
| `displayContact` | `hello@tribunus.dev` | General contact email. |
| `securityContact` | `security@tribunus.dev` | Security disclosure contact. |
| `supportUrl` | `https://tribunus.dev/support` | Support page URL. |
| `docsRoot` | `https://tribunus.dev/docs` | Documentation root URL. |
| `updateEndpoint` | `https://tribunus.dev/updates` | Update manifest endpoint. |
| `deepLinkScheme` | `tribunus` | OS-level deep-link scheme. |
| `userAgentPrefix` | `Tribunus` | HTTP User-Agent prefix |
| `artifactPrefix` | `tribunus` | Release artifact filename prefix. |
| `telemetryNamespace` | `tribunus` | Telemetry event namespace. |
| `releaseNamingPattern` | `tribunus-{platform}-{arch}-{version}.{ext}` | Release artifact naming template |
| `version` | `1.0.0` | Schema/manifest version. |
| `displayStrings` | `{ tagline, shortDescription }` | Human-readable strings for UI and metadata. |

### Governance

The manifest is governed by JSON Schema (see ADR 0020). Any subsystem that introduces a new identifier field MUST add it to both the manifest instance and the schema. The schema enforces `additionalProperties: false`, preventing undeclared fields from entering the canonical identity surface.

## Legacy Reference Registry

**Schema**: `schemas/identity/legacy-reference-registry.v1.schema.json`

The Legacy Reference Registry is the canonical allowlist of every retained reference to "OpenCode" (the predecessor project) and related legacy identifiers. It exists because a complete rename of a complex, multi-year codebase is not an instantaneous find-and-replace — many references serve ongoing compatibility, historical, or upstream-attribution needs that cannot be mechanically removed.

### Classification System

Every entry in the registry carries one of eight classifications that determine its lifecycle, permanence, and removal requirements:

#### `UPSTREAM_ATTRIBUTION_PERMANENT`
References that give credit to OpenCode's origins as a fork or downstream of an upstream project (e.g., `anomalyco/opencode`, `sst/opencode` in git history, NOTICE.md, LICENSE files). These are permanent by definition — removing them would erase the project's provenance trail.

#### `EXTERNAL_UPSTREAM_DEPENDENCY`
References in third-party dependencies, lockfiles, vendored sources, or CI integrations that reference OpenCode by URL or name. These cannot be changed until the dependency releases a new version or the integration is migrated.

#### `LEGACY_READ_COMPATIBILITY`
References retained for backward compatibility in serialization formats, config files, database schemas, or protocol messages. These allow old data to be read without data loss. The corresponding identity reader maintains the ability to parse legacy field names.

#### `LEGACY_DATA_MIGRATION`
References in data migration scripts, ETL pipelines, or schema transformation logic. These are temporary and exist only as long as migration is actively running. Once the migration completes and is verified, these entries are removed.

#### `COMPATIBILITY_TEST_REFERENCE`
References in test fixtures, snapshot files, or golden files that must retain the legacy name to accurately reproduce real-world inputs. These validate that the system correctly handles legacy data.

#### `HISTORICAL_FIXTURE`
References in documentation, blog posts, changelogs, or archived artifacts that refer to the old identity. These are not actively read by the runtime but are preserved for historical accuracy. No removal gate — they age out naturally.

#### `REMOVE_BEFORE_ALPHA`
Temporary references that MUST be removed before the first public alpha release. These are references in active code paths, CI configuration, package names, or documentation that were not yet migrated but have no compatibility requirement. The `removalGate` field specifies the exact condition (e.g., "before public alpha").

#### `FORBIDDEN_ACTIVE_IDENTITY`
References that SHOULD NEVER appear in active code. If the scanner detects a match classified as `FORBIDDEN_ACTIVE_IDENTITY` outside the registry, the verification gate fails. This classification is used for patterns like the old npm scope, old binary names, or old CI action names that must never be introduced in new code.

### Schema Properties (per entry)

| Field | Purpose |
|-------|---------|
| `path` | Repository path where the reference exists. |
| `pattern` | Exact string or AST selector identifying the reference. |
| `classification` | One of the eight classifications above. |
| `subsystem` | Owning subsystem (e.g., `desktop`, `app`, `cli`, `infra`). |
| `reason` | Why this reference is retained. |
| `permanent` | Whether this reference is never to be removed. |
| `compatibilityContract` | The compatibility promise this reference serves. |
| `removalGate` | Condition for removal (e.g., "after migration reader ships for 2 releases"). |
| `replacementIdentity` | The canonical Tribunus identity that replaces this reference. |
| `validatingTest` | Path to the test that validates continued correctness. |

## Identity Scanner

**Script**: `scripts/identity/verify-identity.ts`

The identity scanner is a `bun` script that:

1. Runs `git ls-files` to enumerate every tracked file in the repository.
2. Scans file content for legacy OpenCode identity patterns (case-insensitive matching of "opencode", ".opencode", "OPENCODE", "OpenCode", "opencode.ai", "anomalyco/opencode", etc.).
3. Classifies each match into categories (`package-name`, `opencode-fs-path`, `opencode-ai-url`, `opencode-npm-scope`, `anomalyco-opencode-link`, `path-name`, etc.).
4. Detects "mixed-identity" lines — files that contain both "opencode" and "tribunus" patterns, indicating partial migration.
5. Writes `artifacts/identity/identity-inventory.before.json` (all occurrences with file, line, matched text, context hash, and category) and `artifacts/identity/identity-inventory.before.summary.txt` (summary statistics).

**Exit code**: 0 on success, 1 on scanner error.

The scanner output is consumed by the verifier, which cross-references every unclassified occurrence against the Legacy Reference Registry. Any occurrence outside the registry that matches a `FORBIDDEN_ACTIVE_IDENTITY` pattern causes the verification gate to fail.

## Compatibility Architecture

### Centralized Readers

All subsystems that need to read legacy-format identity data use centralized reader functions, not inline parsing. These readers are located in the `packages/opencode/src/capability/identity.ts` module (the Authority Identity capability). They provide strongly-typed interfaces (`Principal`, `Actor`, `Delegate`, `ServiceIdentity`) that resolve any authority identity to its concrete type regardless of whether the source data uses the legacy or canonical naming.

Centralized readers serve two purposes:
- **Compatibility**: old persisted data continues to load correctly.
- **Migration surface**: when a reader is updated to stop supporting legacy field names, every consuming site is automatically fixed — no scattered inline parsing to hunt down.

### One-Way Migration

Migration from legacy to canonical identity is strictly one-way. Once a file, field, or configuration value is migrated to the canonical Tribunus identity, it is never reverted to the legacy form. The migration path is:

1. **Scan** — the identity scanner inventories all occurrences.
2. **Classify** — each occurrence is either migrated or registered in the Legacy Reference Registry with an appropriate classification.
3. **Migrate** — occurrences not covered by the registry are updated to use the canonical identity.
4. **Verify** — the scanner is re-run; unclassified legacy references fail the gate.

### Deprecation Events

When a legacy identity reference is scheduled for removal, a deprecation event is recorded in the evidence chain (via the authority model's receipt system). The event captures:
- The specific pattern being deprecated.
- The replacement canonical identity.
- The deprecation window (when the pattern stops being read).
- The removal date (when the reference is mechanically removed from the codebase).

### Removal Gates

Each entry in the Legacy Reference Registry with `permanent: false` carries a `removalGate` field specifying the condition that must be met before the reference can be removed. Common gates:

| Gate | Trigger |
|------|---------|
| `before_public_alpha` | Remove before the first public alpha release. |
| `after_migration_reader_2_releases` | Remove after the centralized migration reader has shipped for 2 release cycles. |
| `after_upstream_dep_upgrade` | Remove after the upstream dependency that references the legacy identity is upgraded. |
| `after_data_migration_complete` | Remove after the data migration pipeline finishes and all stale data is converted. |
| `after_schema_rollout_2_releases` | Remove after the new schema has been live for 2 releases with backward-compatible readers. |

## Directory and File Reference

| Artifact | Path | Purpose |
|----------|------|---------|
| Identity Manifest | `schemas/identity/tribunus-identity.v1.json` | Canonical identity values. |
| Identity Manifest Schema | `schemas/identity/tribunus-identity.v1.schema.json` | Schema validating the manifest. |
| Legacy Reference Registry Schema | `schemas/identity/legacy-reference-registry.v1.schema.json` | Schema for registry entries. |
| Identity Scanner | `scripts/identity/verify-identity.ts` | Scans and inventories legacy references. |
| Scanner Output (JSON) | `artifacts/identity/identity-inventory.before.json` | Full scan results. |
| Scanner Output (Summary) | `artifacts/identity/identity-inventory.before.summary.txt` | Summary statistics. |
| Authority Identity Types | `packages/opencode/src/capability/identity.ts` | Centralized identity reader (Principal, Actor, Delegate, ServiceIdentity). |

## Related ADRs

- **ADR 0020**: JSON Schema Governance — schema-first design for all identity artifacts.
- **ADR 0024**: Policy Decision/Enforcement Points — how the identity PDP validates identity references.
- **ADR 0025**: Authority Governance Model — delegation, approval gates, and identity lifecycle.
- **ADR 0026**: Schema Migration Compatibility — compatibility contracts for schema evolution.
