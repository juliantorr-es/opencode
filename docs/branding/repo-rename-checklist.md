# Repo Rename Checklist

Target: `anomalyco/opencode` → `tribunus-dev/tribunus`

## Pre-rename (completed)

- [x] Workflow action references audited (`.github/workflows/deploy.yml`, `opencode.yml`, `publish.yml`, `stats.yml`)
- [x] Package repository URLs updated (`package.json`)
- [x] Documentation URLs updated (`README.md`, all translated `README.*.md`, `CONTRIBUTING.md`, `SECURITY.md`)
- [x] Badge URLs updated (all `README.*.md` files)
- [x] Clone/fetch instructions updated (`INSTALL.md`, `install` script)
- [x] `electron-builder.config.ts` publish config updated (`owner`/`repo` fields for beta and prod channels)
- [x] Config schema URLs updated (`opencode.jsonc`, `tui.json`, `plugins/smoke-theme.json`, `themes/mytheme.json`)
- [x] Glossary PR reference URLs updated (`.opencode/glossary/*.md`)
- [x] Internal agent commands updated (`.opencode/command/issues.md`)
- [x] `opencode.ai` → `tribunus.dev` in all public-facing docs and workflow files (except `NOTICE.md` upstream section)

## At rename time

- [ ] Rename repo in GitHub settings (`anomalyco/opencode` → `tribunus-dev/tribunus`)
- [ ] Update local git remote: `git remote set-url origin git@github.com:tribunus-dev/tribunus.git`
- [ ] Verify GitHub redirect works for old clone URLs (`github.com/anomalyco/opencode` → `github.com/tribunus-dev/tribunus`)
- [ ] Update any GitHub App / OAuth App callback URLs
- [ ] Update any external CI integrations (Buildkite, etc.)
- [ ] Announce in community channels

## Post-rename

- [ ] Verify CI workflows trigger on push
- [ ] Verify release/publish scripts work
- [ ] Update external docs/wiki references
- [ ] Update npm package homepage URLs if published
- [ ] Verify `brew install tribunus-dev/tap/tribunus` Homebrew tap works
- [ ] Update `ghcr.io/anomalyco` → `ghcr.io/tribunus-dev` in container registry references (`packages/containers/`)
- [ ] Update `anomalyco/ghostty-web` → `tribunus-dev/ghostty-web` in `bun.lock` and `packages/app/package.json`
- [ ] Update `anomalyco/models.dev` → `tribunus-dev/models.dev` in `CONTRIBUTING.md`
- [ ] Update `infra/console.ts` and `infra/stats.ts` SST organization from `anomalyco` → `tribunus-dev`
- [ ] Update `packages/console/app/src/config.ts` repo URL
- [ ] Update `packages/console/app/src/lib/changelog.ts` API URL
- [ ] Update `packages/console/app/src/routes/` repo URLs (index.tsx, [...404].tsx, temp.tsx, openapi.json.ts, download/)
- [ ] Update `packages/app/src/desktop-menu.ts` issue template URLs
- [ ] Update `github/` action references (`action.yml`, `index.ts`, `README.md`) — `anomalyco/opencode` → `tribunus-dev/tribunus` and `api.opencode.ai` → `api.tribunus.dev`
- [ ] Update `nix/opencode.nix` homepage URL
- [ ] Update `packages/app/src/constants/index.ts` BASE_URL and related URLs
- [ ] Update `packages/app/src/` components referencing `opencode.ai` (dialog-connect-provider.tsx, dialog-custom-provider.tsx, settings-general.tsx, desktop-menu.ts, entry.tsx)
- [ ] Update `packages/app/src/i18n/*.ts` locale strings referencing `opencode.ai/zen`
- [ ] Update `infra/stage.ts` and `infra/stats.ts` domain references
- [ ] Update `install` script release URLs and docs URL
- [ ] Update `packages/containers/README.md` and Dockerfiles with `ghcr.io/tribunus-dev`
- [ ] Update `packages/app/AGENTS.md` proxy URL reference
