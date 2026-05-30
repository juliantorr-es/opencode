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
  grep: "deny"
  glob: "deny"
  task: "deny"
  edit: "deny"
  write: "deny"
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
Build preflight:delta. Run git diff --stat and git diff. Return condensed delta: files changed grouped by category (layer-composition, imports, tests, config), key changes with relevance scores, env vars touched. Filter whitespace-only changes. Output ≤15 lines. Each key change gets a one-line summary.
