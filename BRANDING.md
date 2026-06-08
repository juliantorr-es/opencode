# Branding Guidelines: Tribunus and OpenCode Namespaces

This document defines the boundary between the **Tribunus** user-facing brand identity and the **OpenCode** compatibility namespaces.

---

## 1. Brand Boundary Policy

The core rule is:
> **Tribunus** is the only product, user-facing, and developer-facing identity. **OpenCode** remains only as an upstream SDK dependency, explicit upstream attribution, or deprecated compatibility fallback.

---

## 2. Naming Categories and Classifications

All occurrences of the legacy brand name (e.g. `opencode`, `OpenCode`) must be classified into one of the following categories:

1. **`UPSTREAM_SDK_DEPENDENCY_ALLOWED`**: Direct dependency declarations and imports from `@tribunus/sdk` required to compile or run the application.
2. **`UPSTREAM_ATTRIBUTION_PRESERVED`**: Historical references in license headers, `NOTICE.md`, original repository references, and provenance tracking.
3. **`PROVIDER_UPSTREAM_ALLOWED`**: Commercial provider mappings or integrations that actively reference hosted upstream services (e.g. `opencodeZen`, `opencodeGo`).
4. **`TEST_COMPATIBILITY_REFERENCE_ALLOWED`**: References in test code and test assertions specifically designed to verify backward compatibility, migration logic, or fallback handlers (e.g., verifying `OPENCODE_*` environment variables resolve when `TRIBUNUS_*` is absent).
5. **`DEPRECATED_ALIAS_TEMPORARILY_RETAINED`**: Temporary configuration fallback paths, commands, headers, or environment variables kept solely for compatibility, accompanied by explicit deprecation notices and a scheduled removal path.
6. **`SHOULD_RENAME_TO_TRIBUNUS`**: References in user-facing surfaces or active code paths that must be migrated to Tribunus.
7. **`SOURCE_LAYOUT_RENAME_PENDING`**: Repository layout and source paths containing the legacy name (e.g., `packages/runtime/`) marked for renaming in a future lifecycle step.
8. **`REMOVE_NOW`**: Unused legacy files or references that can be deleted safely immediately.
9. **`DECISION_REQUIRED`**: Unresolved naming boundaries requiring explicit architectural decisions.

---

## 3. Deprecation Policy & Guidelines

To eliminate brand dilution, legacy `opencode` interfaces are strictly deprecated in favor of **Tribunus** canonical defaults.

### A. Allowed OpenCode References
1. **Upstream SDK Packages**: Direct dependency declarations and imports from `@tribunus/sdk` are allowed where required to compile or run.
2. **Attribution and Provenance**: Historical references in `NOTICE.md` or license attributions remain preserved.
3. **Upstream Services**: Commercial provider mappings (e.g., `opencodeZen` or `opencodeGo`) are allowed if they actively map to upstream hosted services.
4. **Ecosystem Aliases**: Temporary fallback configurations/aliases are permitted only if they emit deprecation warnings or have explicit removal schedules.
5. **Test Assertions**: Compatibility tests verifying fallback behavior.

### B. Deprecated OpenCode References
The following are deprecated and should be actively migrated to **Tribunus**:
1. **CLI Commands**: The command `opencode` is deprecated in favor of `tribunus`.
2. **Config Files**: Configurations in `opencode.json` are deprecated in favor of `tribunus.json`.
3. **Primary Env Vars**: `TRIBUNUS_*` variables are the canonical defaults; `OPENCODE_*` variables are deprecated fallback aliases.
4. **Session Formats**: Session files should transition from `.opencode-session` to `.tribunus-session`.
5. **Headers & Protocols**: Header configurations like `x-opencode-directory` are deprecated in favor of `x-tribunus-directory`.

