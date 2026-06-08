# OpenCode → Tribunus Migration

> **This is the only documentation page where users encounter the legacy product name
> outside of historical attribution in NOTICE.md or similar legal/governance notices.**

Tribunus was formerly known as **OpenCode** and has been renamed. All new development,
documentation, packaging, and tooling references use the name _Tribunus_. Legacy
references are retained only where necessary for migration compatibility and will be
removed before the public stable release.

## Migration Paths

Every compatibility mechanism is **one-way**: new state is never written back to legacy
paths. Legacy aliases exist purely to bridge the transition period.

| Domain | Legacy | Current | Strategy |
|---|---|---|---|
| Config file | `opencode.jsonc` | `tribunus.jsonc` | Read-only fallback on miss; Tribunus wins on key conflict |
| Environment variables | `OPENCODE_*` | `TRIBUNUS_*` | `TRIBUNUS_` takes precedence; `OPENCODE_` read as fallback with deprecation event |
| App data directory | `.opencode/` | `.tribunus/` | One-time import on first start; new writes always go to `.tribunus/` |
| CLI command | `opencode` | `tribunus` | Old binary name removed; symlink or shell alias may be provided |
| HTTP headers | `x-opencode-*` | `x-tribunus-*` | Read at ingress only; never emitted |
| Deep links | `opencode://` | `tribunus://` | Redirect-only handler; never generates legacy scheme |

### 1. Config: `opencode.jsonc` → `tribunus.jsonc`

- Tribunus reads `tribunus.jsonc` first.
- If the file does not exist and `opencode.jsonc` is present, it is read as a
  fallback. A `ConfigFileFallback` event is emitted once per session.
- When both files exist, `tribunus.jsonc` keys always win on conflict. Merged
  values are served from `tribunus.jsonc` — legacy keys are **never** written into
  the new file.
- No automatic migration rewrites `opencode.jsonc`.

### 2. Environment Variables: `OPENCODE_*` → `TRIBUNUS_*`

- At startup the process environment is scanned for both prefixes.
- `TRIBUNUS_*` keys take precedence unconditionally.
- `OPENCODE_*` keys are read as a fallback only when no `TRIBUNUS_*` equivalent
  exists. Each fallback read emits a `DeprecatedEnvVar` event.
- The variable name transformation is: strip the `OPENCODE_` prefix, replace
  with `TRIBUNUS_`. Example: `OPENCODE_HOME` → `TRIBUNUS_HOME`.
- No new `OPENCODE_*` variables are ever created by Tribunus.

### 3. App Data: `.opencode/` → `.tribunus/`

- On first startup after install, Tribunus checks for the legacy `.opencode/`
  directory under the platform-standard app data root.
- If found, it performs a **one-time import**: well-known files and directories
  are copied to `.tribunus/`. The import does **not** delete `.opencode/`.
- After the import, all reads and writes target `.tribunus/`. The legacy
  directory is ignored on subsequent starts unless explicitly requested (user
  passes `--import-legacy`).
- Subdirectories imported: `glossary/`, `checkpoints/`, `state/`, `logs/`,
  `cache/`. Unknown top-level items are silently skipped.

### 4. CLI: `opencode` → `tribunus`

- The `opencode` binary has been renamed to `tribunus`. The old binary name is
  removed from the distribution.
- Package managers and install scripts may install a `opencode` → `tribunus`
  symlink for a transition period, but documentation and help text reference
  only `tribunus`.
- All subcommands and flags remain identical; there is no CLI-breaking change.

### 5. HTTP Headers: `X-OpenCode-*` → `X-Tribunus-*`

- The API gateway reads legacy `x-opencode-*` headers at **ingress only**.
- Ingress normalizes them to the `x-tribunus-*` namespace before any
  application logic runs.
- Responses **never** include `x-opencode-*` headers. All new headers use
  `x-tribunus-*`.
- If both `x-opencode-request-id` and `x-tribunus-request-id` are present on a
  request, the `x-tribunus-*` value wins.

### 6. Deep Links: `opencode://` → `tribunus://`

- The OS-level URL scheme handler for `opencode://` is a **redirect handler
  only**: it maps `opencode://<path>` → `tribunus://<path>` and hands off to
  the Tribunus URL handler.
- Tribunus never generates `opencode://` URLs. All deep links in UI,
  documentation, and APIs use `tribunus://`.
- The redirect handler is unregistered during the upgrade-to-stable flow.

## One-Way Migration

Every migration path above is **strictly one-way**:

- Old state may be read, but **never written** to.
- New state always goes to the current (`tribunus`-prefixed) location.
- There is no mechanism to export or sync back to legacy paths.
- The legacy `.opencode/` directory, once imported, is treated as a read-only
  input and is never modified by Tribunus.

## Removal Timeline

All compatibility aliases (symlinks, environment variable fallbacks, legacy
header ingress, deep-link redirect handlers, and `opencode.jsonc` fallback reads)
will be **removed before the public stable release (v1.0.0)**.

| Alias | Removal Target |
|---|---|
| `opencode` binary symlink | Beta → Stable boundary |
| `OPENCODE_*` env var fallback | Before v1.0.0-rc.1 |
| `opencode.jsonc` fallback read | Before v1.0.0-rc.1 |
| `.opencode/` import logic | Before v1.0.0 |
| `x-opencode-*` ingress normalization | Before v1.0.0 |
| `opencode://` redirect handler | Before v1.0.0 |

## Complete Registry

For the authoritative, exhaustive list of every legacy name, path, variable,
header, and alias — including those not covered by automatic migration — see:

[`schemas/identity/legacy-reference-registry.v1.json`](../schemas/identity/legacy-reference-registry.v1.json)

This registry is the source of truth for all compatibility tooling and is
maintained in lockstep with the codebase.
