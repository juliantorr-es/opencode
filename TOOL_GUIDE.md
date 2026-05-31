# Tool Guide Index

Every agent should know which tools are available to them. This index maps each tool to its purpose and which agents use it.

## Spawn Tools (GM + Orchestrators)

| Tool | Used By | Purpose |
|---|---|---|
| [lane_spawn](tool_usage_guidelines-lane_spawn.md) | GM only | Spawn lifecycle agents in correct lane order |
| [spawn_leaf](tool_usage_guidelines-spawn_leaf.md) | Cartographer, Architect, Critic, Surgeon, Trial, Journalist | Spawn leaf agents in correct team order |

## File Tools (Ground Workers)

| Tool | Used By | Purpose |
|---|---|---|
| [smart_edit](tool_usage_guidelines-smart_edit.md) | Scalpel, Tourniquet, Handy-agent, Journalist team | Exact text replacement with diff |
| [smart_write](tool_usage_guidelines-smart_write.md) | All ground workers | Create/overwrite files |
| [smart_batch](tool_usage_guidelines-smart_batch.md) | All ground workers | Atomic multi-file edits with rollback |
| [smart_sd](tool_usage_guidelines-smart_sd.md) | All ground workers | Fixed-string search and replace |

## Execution Tools (Ground Workers)

| Tool | Used By | Purpose |
|---|---|---|
| [smart_bun](tool_usage_guidelines-smart_bun.md) | Vitals, Stress-test, Second-opinion, Monitor, Trial team, Handy-agent | Typecheck, test, install, run |
| [smart_bash](tool_usage_guidelines-smart_bash.md) | Press, Journalist team, Adversary agents | Shell commands (use only when no smart tool exists) |

## Read Tools (All Agents)

| Tool | Used By | Purpose |
|---|---|---|
| [smart_find](tool_usage_guidelines-smart_find.md) | All agents | Find files by pattern, respects .gitignore |
| [smart_grep](tool_usage_guidelines-smart_grep.md) | All agents | Search file contents with regex |
| [smart_git](tool_usage_guidelines-smart_git.md) | All agents | Git operations with structured output |
| [smart_stats](tool_usage_guidelines-smart_stats.md) | Cartographer, Architect | Codebase line counts by language |
| [read_source](tool_usage_guidelines-read_source.md) | All agents | Read file with structured digest |
| [read](tool_usage_guidelines-read.md) | All agents | Read artifacts, lib types, messages |
| [json_query](tool_usage_guidelines-json_query.md) | All agents | Query JSON files with jql |

## Coordination Tools (GM + Orchestrators)

| Tool | Used By | Purpose |
|---|---|---|
| [task_board](tool_usage_guidelines-task_board.md) | GM, Secretary | Fleet dashboard — running agents, lane progress |
| [verify](tool_usage_guidelines-verify.md) | GM, Surgeon | Verify files, handoffs, imports |
| [file_lock](tool_usage_guidelines-file_lock.md) | All orchestrators | Lock shared files before editing |
| [fragment](tool_usage_guidelines-fragment.md) | All orchestrators | Declare file regions for shared-file coordination |

## Session Management (GM + Orchestrators)

| Tool | Used By | Purpose |
|---|---|---|
| [smart_session](tool_usage_guidelines-smart_session.md) | GM, Secretary | Session lifecycle: init, curate, suggest, diff, end |
| [record](tool_usage_guidelines-record.md) | All agents | Record lessons, activity, findings |
| [feedback](tool_usage_guidelines-feedback.md) | All agents | Report tool friction and failures |
| [roadmap](tool_usage_guidelines-roadmap.md) | GM | Manage roadmap items |
| [plan](tool_usage_guidelines-plan.md) | Architect, Secretary | Propose and revise plans |

## Infrequently Used

| Tool | Used By | Purpose |
|---|---|---|
| [discover](tool_usage_guidelines-discover.md) | Cartographer, Architect | Discover findings across sessions |
| [gate](tool_usage_guidelines-gate.md) | All agents | Publish findings and checkpoints |
| [analytics](tool_usage_guidelines-analytics.md) | GM | Aggregate usage data |
| [github](tool_usage_guidelines-github.md) | Triage | GitHub PR search and issue triage |
| [replace_symbol](tool_usage_guidelines-replace_symbol.md) | Ground workers | AST-aware symbol renaming |
| [rig_schema_validate](tool_usage_guidelines-rig_schema_validate.md) | Validators | Validate JSON against schema |
