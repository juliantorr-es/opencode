# Contributing to Tribunus

Tribunus is a **maintainer-directed open-source project**. The source code is available for inspection and modification under the AGPLv3 license, with commercial licensing available for organizations that require it.

## What We Welcome

- **Inspection & modification** — read the code, fork it, learn from it
- **Bug reports** — clear, reproducible issue reports with minimal reproduction steps
- **Reproducible test cases** — shell scripts, configs, or code snippets that reliably demonstrate a problem
- **Documentation corrections** — typos, unclear passages, missing details
- **Design feedback** — thoughtful discussion on existing architecture and APIs
- **Funded feature bounties** — sponsored work coordinated through maintainers
- **Explicitly scoped contributions** — small, well-defined changes discussed in advance

## What May Be Declined

Unsolicited contributions that are large in scope or direction-setting are often declined. This includes:

- Architectural rewrites or major refactors without prior discussion
- Broad feature implementations that were not requested or scoped
- Product-direction changes that shift the project's focus
- Large AI-generated pull requests submitted without human understanding of every changed line

If you are unsure whether a change would be accepted, open an issue first.

## Before You Code

**Open an issue or reference an approved mission before starting implementation work.**

All pull requests must reference an existing issue or an active mission from the project's task board. This gives maintainers a chance to confirm the change is wanted and avoid wasted effort.

- Use `Fixes #123` or `Refs #123` in your PR description
- For documentation tweaks and trivial fixes, a brief issue is sufficient

## Types of Contribution

| Type | Process |
|------|---------|
| **Feedback** | Open a discussion or issue. No code required. |
| **Bug report** | Open an issue with a reproducible test case. |
| **Security report** | Follow the process in [SECURITY.md](./SECURITY.md). Do not file a public issue. |
| **Documentation change** | Open an issue, then submit a PR. No mission needed. |
| **Small patch** (typos, minor fixes) | Open an issue. PR welcome after triage. |
| **Funded bounty** | Contact maintainers to scope and price the work. |

## Development Setup

**Requirements:** Bun 1.3+

```bash
bun install                           # install all dependencies
bun run dev:desktop                   # start the desktop app in development mode
cd packages/opencode && bun test      # run opencode package tests
bun run typecheck                     # type-check the entire workspace from root
```

## Pull Requests

### Title Convention

PR titles must follow conventional commit format:

- `feat:` — new feature or functionality
- `fix:` — bug fix
- `docs:` — documentation changes
- `chore:` — maintenance, dependency updates
- `refactor:` — code restructuring without behavior change
- `test:` — adding or updating tests

Scopes may be used to indicate the affected package:

- `feat(ui):` — feature in the UI package
- `fix(desktop):` — bug fix in the desktop package

### Before Submitting

- Keep PRs small and focused on a single concern
- Explain what the change does and why
- Link the related issue or mission
- For UI changes, include before/after screenshots
- For logic changes, describe how you verified the fix works

## Licensing & CLAs

Tribunus is released under the AGPLv3 license, with commercial licensing available.

**Contributor License Agreements (CLAs) may be required for substantial contributions.** Before the project's commercial licensing launch, contributors of significant new features, architecture changes, or substantial code may be asked to sign a CLA. This ensures the project can offer commercial licenses while maintaining a clear chain of ownership.

Small fixes, documentation changes, and bug reports do not require a CLA.

## Decision Authority

Governance and decision-making authority are documented in [GOVERNANCE.md](./GOVERNANCE.md). In short: maintainers have final say on what is accepted. If a PR is declined, the reason will be explained.
