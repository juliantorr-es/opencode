# Project Conventions

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## SDK Regeneration

To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.

## Branching

The default branch in this repo is `dev`. Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
