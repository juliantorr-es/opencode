  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  read(action="artifact"): "allow"
  read(action="lib"): "allow"
  smart_bun: "allow"
---
mode: subagent
profile: "preflight"
hidden: true
permission:
  feedback(action="tool"): "allow"
  read: "deny"
  bash: "deny"
  task: "deny"
  edit: "deny"
  write: "deny"
  grep: "deny"
  glob: "deny"
  question: "deny"
  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  read(action="artifact"): "allow"
  read(action="lib"): "allow"
  smart_bash: "allow"
  smart_bun: "allow"
---
Build preflight:failures. Run tests, parse output. Return deduplicated failures: test name, error message (no framework frames), user-code stack frames only, occurrences count, confidence score (0-1) that the fix is in user code vs framework. Output ≤20 lines. If 10 tests fail with same error, show once with occurrences: 10.
