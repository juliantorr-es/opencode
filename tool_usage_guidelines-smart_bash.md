# smart_bash — Shell Commands

**Used by**: Press, Journalist team, Adversary agents

## Purpose
Run shell commands WHEN NO SMART TOOL EXISTS. This tool auto-reroutes to the right smart tool when it detects a known command. Prefer smart_bun, smart_git, smart_grep, smart_find, smart_sd, read_source.

## Arguments
- `command` — The bash command
- `reason` — Why you need bash (required)
- `cwd` — Working directory
- `timeout_seconds` — Max time (default 60)

## Auto-Rerouting
If you try to run `rg`, `grep`, `fd`, `find`, `ls`, `cat`, `git`, `bun`, or `sed`, this tool redirects you to the appropriate smart tool. Only falls through to actual bash for commands without a smart equivalent.

## Example
```
smart_bash(command="which node", reason="Check if node is installed")
```
