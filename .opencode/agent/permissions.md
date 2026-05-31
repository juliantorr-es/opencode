---
mode: subagent
hidden: true
color: "#A0A0A0"
description: Permission doctrine — role-to-permission mapping, merge chain, and cross-cutting protections
permission:
  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  read: "allow"
  smart_bash: "allow"
  smart_bun: "allow"
---

# Permission Doctrine

This document records the role-to-permission mapping for all agents in the Rig
Relay / OpenCode Desktop orchestration wave model. It explains why each role
has its permission set, how permissions merge at runtime, and which conventions
from `AGENTS.md` are enforced by the permission layer.

---

## Permission Merge Chain

Permissions are resolved at runtime in a three-layer cascade. Later layers win
for matching tool-permission keys; per-pattern rules (e.g. `read: { "*.env":
"deny" }`) are more specific than blanket tool-level actions and survive
overrides at coarser granularity.

```
Layer 1  ──  Built-in defaults (agent.ts:106–125)
  ├──  "*": "allow"                          # all tools allowed by default
  ├──  doom_loop: "ask"                      # retry loops ask
  ├──  external_directory: { "*": "ask", … } # external dirs ask
  ├──  question: "deny"                      # question tool off
  ├──  plan_enter/exit: "deny"               # plan flow off
  ├──  repo_clone/overview: "deny"           # remote repo ops off
  └──  read: { "*": "allow", "*.env": "ask",
               "*.env.*": "ask",
               "*.env.example": "allow" }    # .env protection

Layer 2  ──  User config (opencode.jsonc → cfg.permission)
  ├──  Cross-cutting baseline (this file)
  ├──  Sensitive file patterns (read/edit)
  ├──  Bash restrictions (git only auto-allowed)
  ├──  External directory guard
  ├──  Web/repo defaults (deny or ask)
  └──  Survives agent overrides at pattern level

Layer 3  ──  Agent frontmatter (.opencode/agent/*.md → permission:)
  ├──  Each agent defines its own permission block
  ├──  Agent-level "*": "deny" denies all tools
  ├──  Individual tools opened back with "allow"
  └──  Per-pattern rules within a tool key further refine
```

**Key invariant**: The agent frontmatter's `*: deny` is a *tool-level* default.
It does not erase per-pattern rules from Layers 1 and 2. When the permission
evaluator searches for a matching rule, it picks the *most specific* match
across all layers. A `read: { "*.env": "deny" }` from the user config is more
specific than the agent's `read: "allow"` for `.env` file reads.

**Relevant source files:**
- `packages/opencode/src/config/permission.ts` — config schema for permission
- `packages/opencode/src/permission/index.ts` — runtime evaluation, `fromConfig()`, `merge()`
- `packages/opencode/src/agent/agent.ts` — merge chain construction (lines 106–309)

---

## Global Baseline (Layer 2) Rationale

The global `permission` block in `.opencode/opencode.jsonc` exists for three
purposes:

1. **Safety net for agents without frontmatter permissions.** If a new agent
   profile is added without an explicit `permission:` block, the global
   defaults still protect sensitive files and restrict dangerous tools.

2. **Cross-cutting concerns that should apply regardless of agent.** For
   example, `.env` file protection, SSH key blocking, and web-fetch
   restrictions are not agent-specific — every tool invocation should respect
   them.

3. **Enforceable pattern-level rules.** Even when an agent frontmatter says
   `read: "allow"`, the per-pattern rule `read: { "*.env": "deny" }` remains
   active and will block (or ask for) `.env` reads specifically.

### Sensitive file protections

| Pattern | Read | Edit | Rationale |
|---|---|---|---|
| `*.env`, `*.env.*` | ask | deny | Environment files may contain API keys and secrets |
| `*.pem`, `*.key`, `*.cert` | deny | deny | TLS/SSH private keys — never expose |
| `**/credentials*` | deny | deny | Credential files |
| `**/secret*` | deny | deny | Named secret files |
| `**/token*` | deny | deny | Auth tokens |
| `**/oauth*` | deny | deny | OAuth configuration |
| `**/password*` | deny | deny | Password files |
| `**/.ssh/**` | deny | deny | SSH key directory |
| `**/.netrc` | deny | deny | Machine credentials |
| `**/.gitconfig` | ask | allow* | Git config (may contain credentials) |
| Everything else | allow | allow | Normal project files |

\* Edit not restricted for `.gitconfig` because configuring git is a legitimate
operation, but reading is guarded because it may contain stored credentials.

### Bash restrictions

Only `git *` commands are automatically allowed — this enables agents to run
`git status`, `git diff`, `git log`, etc. without prompting. All other bash
commands require confirmation. Note that `git commit`, `git add`, `git push
--force`, etc. are **independently blocked** by the bash tool's own security
enforcement (see `AGENTS.md` Git section).

### Network and external operations

| Tool | Default | Rationale |
|---|---|---|
| `webfetch` | ask | Fetching URLs can leak the workspace context |
| `websearch` | deny | Search may leak intent; enable per-agent only |
| `repo_clone` | deny | Cloning repos is high-risk; enable per-agent |
| `repo_overview` | ask | Repository metadata is read-only but can leak structure |

---

## Role-to-Permission Mapping

### Orchestrator

**Frontmatter:**
```yaml
permission:
  feedback: "allow"
  feedback: "allow"
  "*": "deny"
  task: "allow"
  read: "allow"
  grep: "allow"
  glob: "allow"
  bash: "ask"
  coordinate: "allow"
  read: "allow"
```

**Rationale:** General Man-agent is a pure delegation controller. It must never
mutate files, validate output, or execute code directly. Everything is
delegated to subagents. The `task` tool allows spawning subagents for waves.
`read`/`grep`/`glob` allow inspecting the codebase for wave planning. `bash`
is limited to `ask` so General Man-agent can perform lightweight git state
checks but only with confirmation. `coordinate(action="send")` / `read(action="messages")` support
the coordination protocol.

**Notable denials:** `write`, `edit`, `search_replace`, `patch` — no mutation.
`validate`, `test`, `discover(action="failures")` — validation is delegated. `checkpoint`,
`gate(action="checkpoint")` — checkpointing is the executor's role.

**AGENTS.md conventions enforced:** General Man-agent's own file (line 21 of
general-man-agent.md) lists `"You never inspect your own output, execute code, write
files, or validate results."` This is directly enforced by the permission
block.

---

### Executor

**Frontmatter:**
```yaml
permission:
  feedback: "allow"
  "*": "deny"
  read: "allow"
  grep: "allow"
  glob: "allow"
  write: "allow"
  edit: "allow"
  search_replace: "allow"
  bash: "ask"
  task: "allow"
```

**Rationale:** The executor is a precision implementation worker. It needs full
read/write access to apply narrow code changes within a declared mission
boundary. `task` is allowed for sub-delegation of complex sub-tasks. `bash` is
guarded at `ask` because shell execution should only happen after explicit
approval (e.g. for running formatters or targeted tests).

**Notable denials:** `checkpoint`, `gate(action="checkpoint")` — publication is the
General Man-agent's role. `validate`, `test`, `discover(action="failures")` — the executor
self-validates inline but does not produce formal validation artifacts (that
is the validator's job).

**AGENTS.md conventions enforced:** The executor's additive-edits rule and
dirty-file preservation protocol are instructions-only (not hardware-enforced
by permissions), but the `bash: "ask"` gate ensures shell commands are never
run without oversight.

---

### Validator

**Frontmatter:**
```yaml
permission:
  feedback: "allow"
  "*": "deny"
  read: "allow"
  bash: "ask"
  task: "allow"
  glob: "allow"
  grep: "allow"
```

**Rationale:** The validator is a read-only quality gate. It runs schema
validation scripts, bounded tests, and evidence integrity checks. It does not
edit files — its outputs are limited to its own validation artifact. `bash:
"ask"` allows running linting and test commands with approval. `task` allows
spawning sub-validators for complex verification.

**Notable denials:** `write`, `edit`, `search_replace`, `patch` — no mutation,
not even to fix discovered issues (repair is the repair agent's role). The
validator reports findings, not fixes.

**AGENTS.md conventions enforced:** The validator agent file states "You
validate, you do not fix (except your own output artifacts)". The permission
block enforces this by denying all write tools.

---

### Repair

**Frontmatter:**
```yaml
permission:
  feedback: "allow"
  "*": "deny"
  read: "allow"
  grep: "allow"
  glob: "allow"
  write: "allow"
  edit: "allow"
  search_replace: "allow"
  bash: "ask"
  task: "allow"
```

**Rationale:** The repair agent is a surgical fix worker. It needs the same
read/write capabilities as the executor but is scoped to single-seam delta
fixes from JSON repair directives. `bash: "ask"` gates shell operations. `task`
allows sub-delegation.

**Notable denials:** Same as executor — no checkpointing of its own, no formal
validation artifacts. Repairs are validated inline before handoff.

**AGENTS.md conventions enforced:** "Apply the exact delta described — no
wider, no narrower" — this is instruction-based, but the permission block
ensures the repair agent has no checkpoint/publish capability, preventing it
from leaking unvalidated changes into the commit record.

---

### Stress (Red Team)

**Frontmatter:**
```yaml
permission:
  feedback: "allow"
  "*": "deny"
  read: "allow"
  grep: "allow"
  glob: "allow"
  bash: "ask"
  task: "allow"
```

**Rationale:** The stress agent is adversarial and read-only. It attacks the
implementation by inspecting code paths, running tests, and attempting to
provoke failures. It never fixes what it breaks — it reports findings.
`bash: "ask"` gates shell execution for running attack scripts. `task` allows
spawning sub-attack surfaces.

**Notable denials:** All write/edit tools. The stress agent must not
accidentally repair a vulnerability during testing — findings, not fixes.

**AGENTS.md conventions enforced:** "You break, you do not fix" — enforced by
denying all mutation tools.

---

### Critic

**Frontmatter:**
```yaml
permission:
  feedback: "allow"
  "*": "deny"
  read: "allow"
  grep: "allow"
  glob: "allow"
  task: "allow"
```

**Rationale:** The critic is a long-horizon senior engineer performing
adversarial review. It inspects artifacts, identifies risks, and produces
structured findings. It has the most restricted toolset — no bash, no
write/edit, no validation. It reads and thinks, then reports.

**Notable denials:** `bash` (not even `ask` — the critic should not execute
code). The critic's job is architectural review, not testing. `write`, `edit`,
`search_replace`, `patch` — all denied.

**AGENTS.md conventions enforced:** "You CANNOT write, edit, search_replace,
patch, or bash (unless asked)" — the permission block denies bash entirely
(no `ask` level), enforcing the critic's pure-review role.

---

## How AGENTS.md Conventions Map to Permissions

| AGENTS.md Convention | Enforcement Mechanism |
|---|---|
| "Never use `git commit --amend`, `git push --force`" | Bash tool's own security layer (not permission-based) |
| "Direct `git commit` and `git add` via bash are blocked" | Bash rerouting + checkpoint tool as authorized path |
| "Agents may NOT push, amend, rebase, merge, reset, clean" | Frontmatter permission denies checkpoint/publish tools for subagents |
| "Never run `ruff check` or `ruff format` on `docs/schemas/*.json`" | Instruction-only (no permission-based file-type filtering) |
| "Prefer read-only git operations via bash" | Global `bash: { "git *": "allow" }` streamlines git inspection |
| "Dirty-file preservation" | Instruction-only (no permission enforcement) |
| "Prepublication review before final publication" | Permission separation: only orchestrator publishes |
| "Cross-session coordination uses typed state" | `coordinate(action="send")`/`read(action="messages")` tools for coordination |
| "Never feed raw usage data back into agent prompts" | Instruction-only |
| "Out-of-scope findings must not be fixed opportunistically" | Frontmatter `"*": "deny"` prevents unauthorized writes |

---

## Permission Schema Reference

The config permission schema is defined at
`packages/opencode/src/config/permission.ts`:

```
Action  ::= "ask" | "allow" | "deny"
Object  ::= Record<string, Action>     # pattern → action mapping
Rule    ::= Action | Object            # shorthand string or per-pattern object
```

Each tool key in the permission block accepts either a single Action
(shorthand — applies to all patterns) or an Object mapping specific glob
patterns to Actions.

Known keys: `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`,
`external_directory`, `todowrite`, `question`, `webfetch`, `websearch`,
`repo_clone`, `repo_overview`, `lsp`, `doom_loop`, `skill`.

The runtime representation (after `Permission.fromConfig()`) is:
```
Rule ::= { permission: string, pattern: string, action: Action }
Ruleset ::= Rule[]
```

Evaluation order: most-specific pattern wins. When two rules match the same
input at the same specificity, the later ruleset in the merge chain wins.

---

## Adding a New Agent

When adding a new agent profile to `.opencode/agent/`:

1. **Always include a `permission:` block** with `"*": "deny"` as the base.
   This prevents the agent from inheriting broad allow rules from Layers 1-2.

2. **Open only the tools the agent genuinely needs.** Err on the side of
   restriction. Tools can be opened later when a need is proven.

3. **Set `bash` to `"ask"`** unless you have a strong reason to deny or allow
   it unconditionally. Shell access requires oversight.

4. **Use per-pattern rules** when a tool should only act on certain files.
   For example: `read: { ".opencode/plans/*.md": "allow", "*": "deny" }`.

5. **Check the merge chain.** If you want a global pattern to always apply
   (e.g. `.env` file denial), make sure your agent frontmatter does not
   override it with a coarser rule.
