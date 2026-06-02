## Tribunus Fork — Agent Workflow Lab

This repository is my personal fork of Tribunus. It is not the upstream Tribunus project and is not affiliated with the Tribunus team.

I have deprecated the TUI-first approach in this fork. Current work centers on getting a v1 desktop executable ready for distribution on macOS, Linux, and Windows.

I use this fork as a working lab for AI coding-agent workflows, repo cartography, validation gates, review agents, tool wrappers, and multi-agent development patterns. The fork is meant to show not just agent prompts, but the surrounding engineering system that makes agent work repeatable and reviewable.

### What makes this fork special

The fork’s distinctive work falls into a few connected lanes:

| Path | Purpose |
| --- | --- |
| Agent workflow stack | `.tribunus/` contains custom agent profiles, workflow tools, repo navigation helpers, review agents, and validation utilities that shape how work gets done. |
| Runtime and product changes | `packages/opencode/`, `packages/app/`, `packages/desktop/`, `packages/ui/`, `packages/core/`, `packages/plugin/`, and `packages/effect-drizzle-sqlite/` contain the runtime, desktop, UI, plugin, storage, and migration work that backs the workflow layer. |
| Evidence and cartography | `docs/json/` is the largest body of fork-specific output, with structured audits, cartography, roadmaps, session records, and evidence artifacts. |
| Generated investigation artifacts | `.build/rig-relay/` holds planning records, investigation outputs, and implementation evidence from agent-assisted development sessions. |
| Repo rules and schemas | `docs/schemas/`, `AGENTS.md`, `PROJECT.md`, `TOOL_GUIDE.md`, and related project files define the operating rules, workflow documentation, and repo-specific guidance. |

### Why this fork matters

This fork is meant to show applied work inside a real AI coding-agent codebase. The focus is not just prompting an agent, but building repeatable engineering workflows around agents: scoped tool use, evidence-backed review, structured findings, safer automation, reproducible development lanes, and the runtime changes needed to make those workflows real.

### Upstream project

The original Tribunus README is preserved below for reference.

---

<p align="center">
  <a href="https://tribunus.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Tribunus logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://tribunus.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/tribunus-ai"><img alt="npm" src="https://img.shields.io/npm/v/tribunus-ai?style=flat-square" /></a>
  <a href="https://github.com/tribunus-dev/tribunus/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/tribunus-dev/tribunus/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![Tribunus Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://tribunus.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://tribunus.ai/install | bash

# Package managers
npm i -g tribunus-ai@latest        # or bun/pnpm/yarn
scoop install tribunus             # Windows
choco install tribunus             # Windows
brew install tribunus-dev/tap/tribunus # macOS and Linux (recommended, always up to date)
brew install tribunus              # macOS and Linux (official brew formula, updated less)
sudo pacman -S tribunus            # Arch Linux (Stable)
paru -S tribunus-bin               # Arch Linux (Latest from AUR)
mise use -g tribunus               # Any OS
nix run nixpkgs#tribunus           # or github:tribunus-dev/tribunus for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

Tribunus is also available as a desktop application. Download directly from the [releases page](https://github.com/tribunus-dev/tribunus/releases) or [tribunus.ai/download](https://tribunus.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `tribunus-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `tribunus-desktop-mac-x64.dmg`     |
| Windows               | `tribunus-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask tribunus-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/tribunus-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$TRIBUNUS_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.tribunus/bin` - Default fallback

```bash
# Examples
TRIBUNUS_INSTALL_DIR=/usr/local/bin curl -fsSL https://tribunus.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://tribunus.ai/install | bash
```

### Agents

Tribunus includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://tribunus.ai/docs/agents).

### Documentation

For more info on how to configure Tribunus, [**head over to our docs**](https://tribunus.ai/docs).

### Contributing

If you're interested in contributing to Tribunus, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on Tribunus

If you are working on a project that's related to Tribunus and is using "tribunus" as part of its name, for example "tribunus-dashboard" or "tribunus-mobile", please add a note to your README to clarify that it is not built by the Tribunus team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/tribunus) | [X.com](https://x.com/tribunus)
