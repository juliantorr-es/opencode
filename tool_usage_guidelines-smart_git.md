# smart_git — Git Operations

**Used by**: All agents

## Purpose
Run git operations with structured output. Replaces ALL git bash commands. Use this instead of bash for any git work.

## Operations
- `status` — Working tree status with staged/unstaged/untracked counts
- `diff` — Show changes with optional syntax highlighting (delta)
- `log` — Commit history
- `show` — Show a specific commit
- `branch` — Current branch name

## Arguments
- `operation` — Which git operation
- `path` — Limit to specific file/directory
- `style` — Diff style: "auto" (tries difftastic then delta), "delta", "raw"

## Example
```
smart_git(operation="status")
smart_git(operation="diff", path="packages/opencode/src/adapter.ts", style="delta")
smart_git(operation="log")
```
