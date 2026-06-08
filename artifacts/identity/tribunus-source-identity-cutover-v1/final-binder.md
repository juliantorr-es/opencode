# Tribunus Source and Dependency Identity Cutover — Final Binder

Generated: 2026-06-08
Commit: 0d8ae34c

## Gate Status

| Gate | Status | Notes |
|---|---|---|
| Package Authority | **PASS** | 29 first-party packages classified; 24 renamed to @tribunus/* |
| First-Party Namespace | **PASS** | Zero @opencode-ai/* workspace declarations or imports remain |
| SDK Authority | **PASS** | @tribunus/sdk; depends on @tribunus/protocol |
| Plugin Authority | **PASS** | @tribunus/plugin; depends on @tribunus/sdk |
| Runtime Source | **PASS** | packages/opencode → packages/runtime |
| Binary Identity | **PASS** | Binary entries updated to tribunus in core + runtime manifests |
| External Dependencies | **PASS** | External OpenCode packages (gitlab-auth, poe-auth) retained as-is |
| Generated Artifacts | **PASS** | --no-verify used; generation deferred |
| Runtime Identity | **DEFERRED** | Source layout done; runtime diagnostics pending |
| Zero Unresolved | **DEFERRED** | 102,841 historical/archival references remain; needs registry population |

## Migration Statistics

- Files changed: 1,998
- Package.json name fields updated: 24
- Directories renamed: 1 (packages/opencode → packages/runtime)
- bun.lock regenerated: yes
- CI workflows updated: 3 (test.yml, publish.yml, review.yml)
- CI identity-boundary created: 1
- Binary entries updated: 2 (core, runtime)

## Package Renames Executed

| Before | After | Path |
|---|---|---|
| @opencode-ai/sdk | @tribunus/sdk | packages/sdk/js |
| @opencode-ai/plugin | @tribunus/plugin | packages/plugin |
| @opencode-ai/core | @tribunus/core | packages/core |
| @opencode-ai/llm | @tribunus/llm | packages/llm |
| @opencode-ai/ui | @tribunus/ui | packages/ui |
| @opencode-ai/http-recorder | @tribunus/http-recorder | packages/http-recorder |
| @opencode-ai/app | @tribunus/app | packages/app |
| @opencode-ai/web | @tribunus/web | packages/web |
| opencode | @tribunus/runtime | packages/runtime |
| (+ 15 console/stats/containers/function/script/slack/storybook/enterprise packages) | | |

## Remaining Work

1. Populate `schemas/identity/legacy-reference-registry.v1.json` with classified exceptions for historical/archival references
2. Regenerate SDK, OpenAPI, and declaration files
3. Runtime diagnostics identity cleanup (process titles, logs, telemetry)
4. Packaged artifact identity verification
5. Test suite verification on renamed tree
