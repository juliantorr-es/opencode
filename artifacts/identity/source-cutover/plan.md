# Source Identity Cutover — Migration Plan

Legacy scope: `@opencode-ai/`
Canonical scope: `@tribunus/`
Generated: 2026-06-08T03:47:22.783Z
Source: `scripts/identity/build-package-authority-map.ts`
Total first-party packages: 29
Packages requiring rename: 24
Migration waves: 6

## Package Rename Table

| Current Name | Intended Name | Path | Deps | Consumers |
|---|---|---|---|---|
| `@opencode-ai/app` | `@tribunus/app` | `packages/app` | @opencode-ai/core, @opencode-ai/sdk, @opencode-ai/ui | tribunus |
| `@tribunus/console-app` | `@tribunus/console-app` | `packages/console/app` | @opencode-ai/console-core, @opencode-ai/console-mail, @opencode-ai/console-resource, @opencode-ai/ui | — |
| `@tribunus/console-function` | `@tribunus/console-function` | `packages/console/function` | @opencode-ai/console-core, @opencode-ai/console-resource | — |
| `@opencode-ai/console-support` | `@tribunus/console-support` | `packages/console/support` | @opencode-ai/console-core | — |
| `@tribunus/containers` | `@tribunus/containers` | `packages/containers` | — | — |
| `@tribunus/enterprise` | `@tribunus/enterprise` | `packages/enterprise` | @opencode-ai/core, @opencode-ai/ui | — |
| `@tribunus/function` | `@tribunus/function` | `packages/function` | — | — |
| `@opencode-ai/http-recorder` | `@tribunus/http-recorder` | `packages/http-recorder` | — | llm, opencode |
| `@opencode-ai/script` | `@tribunus/script` | `packages/script` | — | opencode |
| `@opencode-ai/slack` | `@tribunus/slack` | `packages/slack` | @opencode-ai/sdk | — |
| `@tribunus/stats-app` | `@tribunus/stats-app` | `packages/stats/app` | @opencode-ai/stats-core, @opencode-ai/ui | — |
| `@tribunus/stats-server` | `@tribunus/stats-server` | `packages/stats/server` | @opencode-ai/stats-core | — |
| `@opencode-ai/storybook` | `@tribunus/storybook` | `packages/storybook` | — | — |
| `@opencode-ai/web` | `@tribunus/web` | `packages/web` | — | — |
| `@opencode-ai/core` | `@tribunus/core` | `packages/core` | — | app, ui, opencode, enterprise |
| `@opencode-ai/llm` | `@tribunus/llm` | `packages/llm` | — | opencode |
| `@opencode-ai/ui` | `@tribunus/ui` | `packages/ui` | @opencode-ai/core, @opencode-ai/sdk | app, tribunus, opencode, enterprise, storybook, stats-app, console-app |
| `@opencode-ai/plugin` | `@tribunus/plugin` | `packages/plugin` | @opencode-ai/sdk | opencode |
| `@opencode-ai/sdk` | `@tribunus/sdk` | `packages/sdk/js` | @tribunus/protocol | app, ui, opencode, plugin, slack |
| `@opencode-ai/console-core` | `@tribunus/console-core` | `packages/console/core` | @opencode-ai/console-mail, @opencode-ai/console-resource | console-app, console-function, console-support |
| `@opencode-ai/console-mail` | `@tribunus/console-mail` | `packages/console/mail` | — | console-core, console-app |
| `@opencode-ai/console-resource` | `@tribunus/console-resource` | `packages/console/resource` | — | console-core, console-app, console-function |
| `@opencode-ai/stats-core` | `@tribunus/stats-core` | `packages/stats/core` | — | stats-app, stats-server |
| `opencode` | `@tribunus/runtime` | `packages/opencode` | @opencode-ai/llm, @opencode-ai/plugin, @opencode-ai/sdk, @opencode-ai/ui | web |
| `opencode` | `@tribunus/runtime` | `packages/opencode` | — | — |

## Production Dependency Graph

```
  @opencode-ai/core → (none)
  @opencode-ai/app → @opencode-ai/core, @opencode-ai/sdk, @opencode-ai/ui
  tribunus → (none)
  @opencode-ai/web → (none)
  @opencode-ai/ui → @opencode-ai/core, @opencode-ai/sdk
  @opencode-ai/llm → (none)
  @tribunus/compute → @tribunus/compute-native
  @tribunus/compute-native → (none)
  @tribunus/protocol → (none)
  opencode → @opencode-ai/llm, @opencode-ai/plugin, @opencode-ai/sdk, @opencode-ai/ui
  @opencode-ai/sdk → @tribunus/protocol
  @opencode-ai/plugin → @opencode-ai/sdk
  @opencode-ai/script → (none)
  @opencode-ai/slack → @opencode-ai/sdk
  @tribunus/enterprise → @opencode-ai/core, @opencode-ai/ui
  @opencode-ai/http-recorder → (none)
  @tribunus/function → (none)
  @opencode-ai/storybook → (none)
  @tribunus/containers → (none)
  @tribunus-ai/github-pages-mcp → (none)
  @opencode-ai/stats-core → (none)
  @tribunus/stats-app → @opencode-ai/stats-core, @opencode-ai/ui
  @tribunus/stats-server → @opencode-ai/stats-core
  @opencode-ai/console-core → @opencode-ai/console-mail, @opencode-ai/console-resource
  @tribunus/console-app → @opencode-ai/console-core, @opencode-ai/console-mail, @opencode-ai/console-resource, @opencode-ai/ui
  @tribunus/console-function → @opencode-ai/console-core, @opencode-ai/console-resource
  @opencode-ai/console-support → @opencode-ai/console-core
  @opencode-ai/console-mail → (none)
  @opencode-ai/console-resource → (none)
```

## Reverse Dependency Graph (who depends on whom)

```
  @opencode-ai/core ← @opencode-ai/app, @tribunus/enterprise, @opencode-ai/ui
  @opencode-ai/app ← (no workspace consumers)
  tribunus ← (no workspace consumers)
  @opencode-ai/web ← (no workspace consumers)
  @opencode-ai/ui ← @opencode-ai/app, @tribunus/console-app, @tribunus/enterprise, @tribunus/stats-app, opencode
  @opencode-ai/llm ← opencode
  @tribunus/compute ← (no workspace consumers)
  @tribunus/compute-native ← @tribunus/compute
  @tribunus/protocol ← @opencode-ai/sdk
  opencode ← (no workspace consumers)
  @opencode-ai/sdk ← @opencode-ai/app, @opencode-ai/plugin, @opencode-ai/slack, @opencode-ai/ui, opencode
  @opencode-ai/plugin ← opencode
  @opencode-ai/script ← (no workspace consumers)
  @opencode-ai/slack ← (no workspace consumers)
  @tribunus/enterprise ← (no workspace consumers)
  @opencode-ai/http-recorder ← (no workspace consumers)
  @tribunus/function ← (no workspace consumers)
  @opencode-ai/storybook ← (no workspace consumers)
  @tribunus/containers ← (no workspace consumers)
  @tribunus-ai/github-pages-mcp ← (no workspace consumers)
  @opencode-ai/stats-core ← @tribunus/stats-app, @tribunus/stats-server
  @tribunus/stats-app ← (no workspace consumers)
  @tribunus/stats-server ← (no workspace consumers)
  @opencode-ai/console-core ← @tribunus/console-app, @tribunus/console-function, @opencode-ai/console-support
  @tribunus/console-app ← (no workspace consumers)
  @tribunus/console-function ← (no workspace consumers)
  @opencode-ai/console-support ← (no workspace consumers)
  @opencode-ai/console-mail ← @tribunus/console-app, @opencode-ai/console-core
  @opencode-ai/console-resource ← @tribunus/console-app, @opencode-ai/console-core, @tribunus/console-function
```

## Wave 1: Leaf Packages

Packages with no first-party workspace dependents — safe to rename without cascading.

**Packages:** 14

### `@opencode-ai/app` → `@tribunus/app`

- **Location:** `packages/app`
- **Workspace production deps:** @opencode-ai/core, @opencode-ai/sdk, @opencode-ai/ui

**Import references to update in `package.json`:**

| Consumer | Package | Dep Type |
|----------|---------|----------|
| `packages/desktop/package.json` | `tribunus` | devDependencies |

### `@tribunus/console-app` → `@tribunus/console-app`

- **Location:** `packages/console/app`
- **Workspace production deps:** @opencode-ai/console-core, @opencode-ai/console-mail, @opencode-ai/console-resource, @opencode-ai/ui

**No workspace import references to update.**

### `@tribunus/console-function` → `@tribunus/console-function`

- **Location:** `packages/console/function`
- **Workspace production deps:** @opencode-ai/console-core, @opencode-ai/console-resource

**No workspace import references to update.**

### `@opencode-ai/console-support` → `@tribunus/console-support`

- **Location:** `packages/console/support`
- **Workspace production deps:** @opencode-ai/console-core

**No workspace import references to update.**

### `@tribunus/containers` → `@tribunus/containers`

- **Location:** `packages/containers`
- **Workspace production deps:** (none)

**No workspace import references to update.**

### `@tribunus/enterprise` → `@tribunus/enterprise`

- **Location:** `packages/enterprise`
- **Workspace production deps:** @opencode-ai/core, @opencode-ai/ui

**No workspace import references to update.**

### `@tribunus/function` → `@tribunus/function`

- **Location:** `packages/function`
- **Workspace production deps:** (none)

**No workspace import references to update.**

### `@opencode-ai/http-recorder` → `@tribunus/http-recorder`

- **Location:** `packages/http-recorder`
- **Workspace production deps:** (none)

**Import references to update in `package.json`:**

| Consumer | Package | Dep Type |
|----------|---------|----------|
| `packages/llm/package.json` | `llm` | devDependencies |
| `packages/opencode/package.json` | `opencode` | devDependencies |

### `@opencode-ai/script` → `@tribunus/script`

- **Location:** `packages/script`
- **Workspace production deps:** (none)

**Import references to update in `package.json`:**

| Consumer | Package | Dep Type |
|----------|---------|----------|
| `packages/opencode/package.json` | `opencode` | devDependencies |

### `@opencode-ai/slack` → `@tribunus/slack`

- **Location:** `packages/slack`
- **Workspace production deps:** @opencode-ai/sdk

**No workspace import references to update.**

### `@tribunus/stats-app` → `@tribunus/stats-app`

- **Location:** `packages/stats/app`
- **Workspace production deps:** @opencode-ai/stats-core, @opencode-ai/ui

**No workspace import references to update.**

### `@tribunus/stats-server` → `@tribunus/stats-server`

- **Location:** `packages/stats/server`
- **Workspace production deps:** @opencode-ai/stats-core

**No workspace import references to update.**

### `@opencode-ai/storybook` → `@tribunus/storybook`

- **Location:** `packages/storybook`
- **Workspace production deps:** (none)

**No workspace import references to update.**

### `@opencode-ai/web` → `@tribunus/web`

- **Location:** `packages/web`
- **Workspace production deps:** (none)

**No workspace import references to update.**

## Wave 2: Foundation Packages

Core infrastructure packages (core, llm, ui, protocol, compute) — broad consumer base, renamed early to unblock downstream.

**Packages:** 3

### `@opencode-ai/core` → `@tribunus/core`

- **Location:** `packages/core`
- **Workspace production deps:** (none)

**Import references to update in `package.json`:**

| Consumer | Package | Dep Type |
|----------|---------|----------|
| `packages/app/package.json` | `app` | dependencies |
| `packages/ui/package.json` | `ui` | dependencies |
| `packages/opencode/package.json` | `opencode` | devDependencies |
| `packages/enterprise/package.json` | `enterprise` | dependencies |

### `@opencode-ai/llm` → `@tribunus/llm`

- **Location:** `packages/llm`
- **Workspace production deps:** (none)

**Import references to update in `package.json`:**

| Consumer | Package | Dep Type |
|----------|---------|----------|
| `packages/opencode/package.json` | `opencode` | dependencies |

### `@opencode-ai/ui` → `@tribunus/ui`

- **Location:** `packages/ui`
- **Workspace production deps:** @opencode-ai/core, @opencode-ai/sdk

**Import references to update in `package.json`:**

| Consumer | Package | Dep Type |
|----------|---------|----------|
| `packages/app/package.json` | `app` | dependencies |
| `packages/desktop/package.json` | `tribunus` | devDependencies |
| `packages/opencode/package.json` | `opencode` | dependencies |
| `packages/enterprise/package.json` | `enterprise` | dependencies |
| `packages/storybook/package.json` | `storybook` | devDependencies |
| `packages/stats/app/package.json` | `stats-app` | dependencies |
| `packages/console/app/package.json` | `console-app` | dependencies |

## Wave 3: SDK & Plugin

SDK consumed by public consumers, and Plugin (depends on SDK) — must be renamed before consumer wave.

**Packages:** 2

### `@opencode-ai/plugin` → `@tribunus/plugin`

- **Location:** `packages/plugin`
- **Workspace production deps:** @opencode-ai/sdk

**Import references to update in `package.json`:**

| Consumer | Package | Dep Type |
|----------|---------|----------|
| `packages/opencode/package.json` | `opencode` | dependencies |

### `@opencode-ai/sdk` → `@tribunus/sdk`

- **Location:** `packages/sdk/js`
- **Workspace production deps:** @tribunus/protocol

**Import references to update in `package.json`:**

| Consumer | Package | Dep Type |
|----------|---------|----------|
| `packages/app/package.json` | `app` | dependencies |
| `packages/ui/package.json` | `ui` | dependencies |
| `packages/opencode/package.json` | `opencode` | dependencies |
| `packages/plugin/package.json` | `plugin` | dependencies |
| `packages/slack/package.json` | `slack` | dependencies |

## Wave 4: Consumer Packages

Application-level packages consuming foundation, SDK, and UI packages.

**Packages:** 4

### `@opencode-ai/console-core` → `@tribunus/console-core`

- **Location:** `packages/console/core`
- **Workspace production deps:** @opencode-ai/console-mail, @opencode-ai/console-resource

**Import references to update in `package.json`:**

| Consumer | Package | Dep Type |
|----------|---------|----------|
| `packages/console/app/package.json` | `console-app` | dependencies |
| `packages/console/function/package.json` | `console-function` | dependencies |
| `packages/console/support/package.json` | `console-support` | dependencies |

### `@opencode-ai/console-mail` → `@tribunus/console-mail`

- **Location:** `packages/console/mail`
- **Workspace production deps:** (none)

**Import references to update in `package.json`:**

| Consumer | Package | Dep Type |
|----------|---------|----------|
| `packages/console/core/package.json` | `console-core` | dependencies |
| `packages/console/app/package.json` | `console-app` | dependencies |

### `@opencode-ai/console-resource` → `@tribunus/console-resource`

- **Location:** `packages/console/resource`
- **Workspace production deps:** (none)

**Import references to update in `package.json`:**

| Consumer | Package | Dep Type |
|----------|---------|----------|
| `packages/console/core/package.json` | `console-core` | dependencies |
| `packages/console/app/package.json` | `console-app` | dependencies |
| `packages/console/function/package.json` | `console-function` | dependencies |

### `@opencode-ai/stats-core` → `@tribunus/stats-core`

- **Location:** `packages/stats/core`
- **Workspace production deps:** (none)

**Import references to update in `package.json`:**

| Consumer | Package | Dep Type |
|----------|---------|----------|
| `packages/stats/app/package.json` | `stats-app` | dependencies |
| `packages/stats/server/package.json` | `stats-server` | dependencies |

## Wave 5: Runtime Package

The main opencode runtime npm name change (opencode → @tribunus/runtime); last npm rename before directory move.

**Packages:** 1

### `opencode` → `@tribunus/runtime`

- **Location:** `packages/opencode`
- **Workspace production deps:** @opencode-ai/llm, @opencode-ai/plugin, @opencode-ai/sdk, @opencode-ai/ui

**Import references to update in `package.json`:**

| Consumer | Package | Dep Type |
|----------|---------|----------|
| `packages/web/package.json` | `web` | devDependencies |

## Wave 6: Directory Rename

Rename packages/opencode → packages/runtime; all npm renames already applied, only filesystem path references and imports remain.

**Packages:** 1

### Directory Rename

- **From:** `packages/opencode`
- **To:** `packages/runtime`
- **Associated npm name:** `opencode` → `@tribunus/runtime`

**NOTE:** All npm renames in Wave 5 must be complete before this wave executes.

## Directory Renames

- packages/opencode → packages/runtime

## Execution Order

Execute waves sequentially. Each wave must be verified before proceeding to the next.

1. **Wave 1 — Leaf Packages** (14 packages)
   - Rename `@opencode-ai/app` → `@tribunus/app` in `packages/app/package.json`
   - Update references in: `packages/desktop/package.json`
   - Rename `@tribunus/console-app` → `@tribunus/console-app` in `packages/console/app/package.json`
   - Rename `@tribunus/console-function` → `@tribunus/console-function` in `packages/console/function/package.json`
   - Rename `@opencode-ai/console-support` → `@tribunus/console-support` in `packages/console/support/package.json`
   - Rename `@tribunus/containers` → `@tribunus/containers` in `packages/containers/package.json`
   - Rename `@tribunus/enterprise` → `@tribunus/enterprise` in `packages/enterprise/package.json`
   - Rename `@tribunus/function` → `@tribunus/function` in `packages/function/package.json`
   - Rename `@opencode-ai/http-recorder` → `@tribunus/http-recorder` in `packages/http-recorder/package.json`
   - Update references in: `packages/llm/package.json`, `packages/opencode/package.json`
   - Rename `@opencode-ai/script` → `@tribunus/script` in `packages/script/package.json`
   - Update references in: `packages/opencode/package.json`
   - Rename `@opencode-ai/slack` → `@tribunus/slack` in `packages/slack/package.json`
   - Rename `@tribunus/stats-app` → `@tribunus/stats-app` in `packages/stats/app/package.json`
   - Rename `@tribunus/stats-server` → `@tribunus/stats-server` in `packages/stats/server/package.json`
   - Rename `@opencode-ai/storybook` → `@tribunus/storybook` in `packages/storybook/package.json`
   - Rename `@opencode-ai/web` → `@tribunus/web` in `packages/web/package.json`
   - Verify: `bun run scripts/identity/verify-identity.ts`

1. **Wave 2 — Foundation Packages** (3 packages)
   - Rename `@opencode-ai/core` → `@tribunus/core` in `packages/core/package.json`
   - Update references in: `packages/app/package.json`, `packages/ui/package.json`, `packages/opencode/package.json`, `packages/enterprise/package.json`
   - Rename `@opencode-ai/llm` → `@tribunus/llm` in `packages/llm/package.json`
   - Update references in: `packages/opencode/package.json`
   - Rename `@opencode-ai/ui` → `@tribunus/ui` in `packages/ui/package.json`
   - Update references in: `packages/app/package.json`, `packages/desktop/package.json`, `packages/opencode/package.json`, `packages/enterprise/package.json`, `packages/storybook/package.json`, `packages/stats/app/package.json`, `packages/console/app/package.json`
   - Verify: `bun run scripts/identity/verify-identity.ts`

1. **Wave 3 — SDK & Plugin** (2 packages)
   - Rename `@opencode-ai/plugin` → `@tribunus/plugin` in `packages/plugin/package.json`
   - Update references in: `packages/opencode/package.json`
   - Rename `@opencode-ai/sdk` → `@tribunus/sdk` in `packages/sdk/js/package.json`
   - Update references in: `packages/app/package.json`, `packages/ui/package.json`, `packages/opencode/package.json`, `packages/plugin/package.json`, `packages/slack/package.json`
   - Verify: `bun run scripts/identity/verify-identity.ts`

1. **Wave 4 — Consumer Packages** (4 packages)
   - Rename `@opencode-ai/console-core` → `@tribunus/console-core` in `packages/console/core/package.json`
   - Update references in: `packages/console/app/package.json`, `packages/console/function/package.json`, `packages/console/support/package.json`
   - Rename `@opencode-ai/console-mail` → `@tribunus/console-mail` in `packages/console/mail/package.json`
   - Update references in: `packages/console/core/package.json`, `packages/console/app/package.json`
   - Rename `@opencode-ai/console-resource` → `@tribunus/console-resource` in `packages/console/resource/package.json`
   - Update references in: `packages/console/core/package.json`, `packages/console/app/package.json`, `packages/console/function/package.json`
   - Rename `@opencode-ai/stats-core` → `@tribunus/stats-core` in `packages/stats/core/package.json`
   - Update references in: `packages/stats/app/package.json`, `packages/stats/server/package.json`
   - Verify: `bun run scripts/identity/verify-identity.ts`

1. **Wave 5 — Runtime Package** (1 package)
   - Rename `opencode` → `@tribunus/runtime` in `packages/opencode/package.json`
   - Update references in: `packages/web/package.json`
   - Verify: `bun run scripts/identity/verify-identity.ts`

1. **Wave 6 — Directory Rename** (1 directory)
   - Rename directory: `packages/opencode` → `packages/runtime`
   - Verify: `bun run scripts/identity/verify-identity.ts`
