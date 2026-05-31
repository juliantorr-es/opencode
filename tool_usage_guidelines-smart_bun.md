# smart_bun — Bun Operations

**Used by**: Vitals, Stress-test, Second-opinion, Monitor, Trial team, Handy-agent

## Purpose
Run bun operations and return structured results. REPLACES all bash bun commands.

## Commands
- `typecheck` — Run typecheck. Returns structured error list with file:line:code:message
- `test` — Run tests. Returns pass/fail counts and individual test results
- `install` — Install dependencies
- `run` — Run a bun script
- `solidjs-test` — Run tests with browser conditions (for SolidJS projects)

## Arguments
- `command` — Which operation (typecheck, test, install, run, solidjs-test)
- `cwd` — Working directory (e.g. "packages/opencode")
- `args` — Additional args (e.g. test file path, --filter)
- `timeout_seconds` — Max time (default 120)
- `test_pattern` — Filter tests by name

## Output
- typecheck: `{ status, errors: [{file, line, col, code, message}], error_summary: {files, total} }`
- test: `{ status, test_summary: {pass, fail, total, passed_tests, failed_tests} }`

## Example
```
smart_bun(command="typecheck", cwd="packages/opencode")
smart_bun(command="test", args="adapter", cwd="packages/opencode")
```
