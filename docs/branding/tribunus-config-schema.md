# .tribunus/ — Project Config Directory

.tribunus/ is a repo-local declarative configuration directory.
It defines project-level policy, workflows, agents, tools, and gates.
It is NOT for runtime state, secrets, caches, logs, or databases.

## Directory Structure

```
.tribunus/
  config.json          # Project config (required)
  workflows/           # Workflow presets (JSON)
  policies/            # Policy definitions (paths, tools, sandboxes)
  agents/              # Agent profile overrides
  gates/               # Release/security gate definitions
  tools/               # Shared tool definitions (TypeScript, trust-gated)
  plugin.ts            # Executable plugin (TypeScript, trust-gated)
  README.md            # Human-readable explanation
```

## What belongs here

- Project policy (protected paths, allowed tools, workflow presets)
- Sandbox templates for team mode
- Agent profile overrides
- Release gate definitions
- Shared tool definitions (if intentionally committed)

## What must NOT go here

- Secrets, tokens, API keys
- Databases, logs, caches, crash dumps
- Runtime queues, tool result caches
- Machine-specific paths
- PGlite state, Valkey state
- Debug bundles
- Agent transcripts unless intentionally exported

## Schema versioning

All config files use a `version` field. The loader validates the version
and rejects unknown versions with a typed error.

```json
{
  "$schema": "https://tribunus.dev/schemas/project-config.v1.json",
  "version": 1
}
```

## Trust model

Declarative JSON config is loaded and validated automatically.
Executable code (plugin.ts, tools/*.ts) requires workspace trust.
If the workspace is untrusted, executable config is not loaded.

## Loading order

1. Built-in defaults (hardcoded in the runtime)
2. User global config (appData)
3. Repo .tribunus declarative config (JSON, validated)
4. Repo .tribunus executable config (TypeScript, trust-gated)
5. Session/workflow overrides

Later layers override earlier layers, but safety invariants (secret redaction,
path boundaries, unsafe git prohibitions, audit recording, tool permission
enforcement, runtime artifact hygiene) cannot be disabled by any layer.
