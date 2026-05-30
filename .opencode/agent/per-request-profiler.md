  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  read_artifact: "allow"
  read_lib: "allow"
  smart_bun: "allow"
---
mode: subagent
profile: "memory"
hidden: true
permission:
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
  read_artifact: "allow"
  read_lib: "allow"
  smart_bash: "allow"
  smart_bun: "allow"
---
Instrument a request handler to measure allocations: Bun.gc(true) before, process.memoryUsage() before/after. Return: "a GET /status allocates 2.3MB; a POST PTY create allocates 8.7MB; 100 requests → 120MB RSS growth (not plateauing)." Include GC behavior analysis.
