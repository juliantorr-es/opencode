# OpenCode Orchestration Plugin — Installation Guide

## What This Is

The orchestration plugin is a **distributable extension** for OpenCode that provides:

- **Multi-agent orchestration** — cartographer → architect → critic → surgeon → trial → journalist lifecycle
- **Fleet management** — concurrent lane execution with status tracking
- **Shared persistence** — SQLite database with JSONL mirroring for all orchestration state
- **Knowledge graph** — codebase indexing, error hotspots, dependency tracking
- **Doctor + Validator** — health checks and structural validation
- **TUI dashboard** — real-time fleet view, orchestration panel

## Plugin Surface

### Required files (must exist)
```
.opencode/
├── plugin.ts                    # Plugin entry point — registers all hooks
├── package.json                 # Dependencies
├── opencode.jsonc               # Project config (permissions, agents, tools)
├── tui.json                     # TUI plugin registration
├── agents/                      # Agent definitions (58 markdown profiles)
│   ├── cartographer.md
│   ├── architect.md
│   ├── critic.md
│   ├── surgeon.md
│   ├── trial.md
│   ├── journalist.md
│   ├── general-man-agent.md
│   └── ... (specialized agents)
├── tools/                       # Tool implementations
│   ├── db.ts                    # Database schema + low-level operations
│   ├── persistence.ts           # High-level persistence API (tools use this)
│   ├── config.ts                # Unified config resolution
│   ├── doctor.ts                # Health check tool
│   ├── validator.ts             # Structural validator
│   ├── task_board.ts            # Fleet dashboard
│   ├── dashboard.ts             # Web dashboard server
│   ├── janitor.ts               # DB maintenance
│   ├── system_test.ts           # Self-test
│   ├── config_sync.ts           # Config sync tool
│   ├── deep_analyze.ts          # Deep code analysis
│   ├── codebase_index.ts        # Codebase indexing
│   ├── semantic_search.ts       # Semantic search
│   ├── smart_*.ts               # Smart tool wrappers (bash, bun, git, etc.)
│   ├── leaf_handoff.ts          # Agent coordination
│   ├── ping.ts                  # Agent heartbeat
│   ├── session_journal.ts       # Session persistence
│   ├── roadmap.ts               # Lane planning
│   ├── diagram.ts               # Architecture diagrams
│   ├── github_full.ts           # GitHub integration
│   ├── local_llm.ts             # Local LLM support
│   └── bin/                     # Binary dependencies (delta, fd, jql, rg, tokei)
├── plugins/                     # TUI plugins
│   ├── orchestration-tui.tsx    # Orchestration panel
│   ├── fleet-tui.tsx            # Fleet view
│   └── tui-smoke.tsx            # Smoke theme
├── skills/                      # Agent skills
├── command/                     # Custom commands
├── glossary/                    # i18n glossary
├── themes/                      # UI themes
└── docs/                        # Documentation
    └── wave-orchestration-diagram.md
```

### Generated / runtime state (not shipped)
```
docs/json/opencode/
├── state.db                     # SQLite database (runtime)
├── state.db-wal                 # WAL journal
├── mirror/                      # JSONL safety net
│   ├── lane_agents.v1.jsonl
│   ├── journal.v1.jsonl
│   ├── heartbeats.v1.jsonl
│   └── ...
└── *.jsonl.migrated             # Legacy data (after migration)
```

## Installation

### Prerequisites
- **OpenCode** with plugin support (`@opencode-ai/plugin` ≥ 1.15.0)
- **Bun** runtime (for TypeScript tools)
- **Node.js** ≥ 20 (for some binary dependencies)

### Quick Install

```bash
# 1. Clone the orchestration plugin into your project's .opencode directory
git clone <repo-url> .opencode

# 2. Install dependencies
cd .opencode && bun install

# 3. Run the validator to verify structure
# (via OpenCode: "run validator")

# 4. Run the doctor to verify health
# (via OpenCode: "run doctor")

# 5. Sync configs to your global OpenCode config
# (via OpenCode: "run config_sync action='sync'")
```

### Manual Install

1. Copy the `.opencode/` directory into your project root
2. Run `cd .opencode && bun install`
3. Add `"./plugin.ts"` to the `plugin` array in `opencode.jsonc`
4. Configure permissions for the orchestration tools in `opencode.jsonc`
5. Run doctor to verify

### Global Config

The plugin syncs permissions to your global OpenCode config (`~/.config/opencode/opencode.json`).
This is done automatically on startup and can be triggered manually:

```
config_sync(action="sync", direction="local_to_global")
```

## Verification

After installation, run these checks:

```bash
# Structural validation (must pass — no violations)
validator(strict=true)

# Health check (should be "healthy" or "degraded")
doctor()

# Self-test
system_test(action="smoke")

# Config sync check
config_sync(action="check")
```

## Architecture

### Configuration Resolution

```
global config (~/.config/opencode/opencode.json)
    ↓
project config (.opencode/opencode.jsonc)
    ↓
plugin defaults (config.ts → DEFAULTS)
    ↓
resolved configuration
```

All tools read resolved config through `config.ts`. No tool parses config independently.

### Persistence Layer

```
Tools → persistence.ts → db.ts → SQLite + JSONL mirror
```

- **persistence.ts** — high-level API: `spawnAgent()`, `recordEvent()`, `createClaim()`, etc.
- **db.ts** — schema, migrations, low-level queries, mirroring
- **SQLite** — primary state store (WAL mode)
- **JSONL mirror** — safety net at `docs/json/opencode/mirror/`

### Agent Directory

- **One canonical location**: `.opencode/agents/`
- **No duplicates**: `.opencode/agent` (singular) is a ghost — must not exist
- **Root-level profile stubs** are generated artifacts — not part of the plugin

## Maintenance

### DB Maintenance

```
janitor(action="vacuum")       # Optimize + vacuum
janitor(action="prune")        # Remove old data
janitor(action="full_clean")   # All maintenance
```

### Resetting State

```bash
# Remove runtime state (keeps plugin code)
rm -rf docs/json/opencode/state.db*
rm -rf docs/json/opencode/mirror/
```

### Upgrading

1. Pull latest plugin code
2. Run `bun install`
3. Run `validator(strict=true)` to check structure
4. Run `doctor()` to verify health
5. The DB auto-migrates on startup

## Troubleshooting

1. **Run doctor first** — captures DB health, file presence, config sync
2. **Run validator** — catches structural issues (ghost dirs, duplicate agents)
3. **Check config_sync** — ensures global and project configs are aligned
4. **Run system_test** — end-to-end smoke test
5. **Check the DB** — `db_query(query="SELECT COUNT(*) FROM lane_agents")`

## Uninstalling

1. Remove the `.opencode/` directory from your project
2. Remove orchestration permissions from your global OpenCode config
3. Optionally remove `docs/json/opencode/` to clean runtime state
