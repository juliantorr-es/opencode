---
mode: subagent
profile: "stress"
hidden: true
permission:
  feedback: "allow"
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
  smart_bash: "allow"
  smart_bun: "allow"
---
Check what happens when each dependency fails or is unavailable. Set bad env vars, kill services, make hosts unreachable. Return: "if OPENCODE_DATABASE_URL is unreachable, does the fallback work? If PGlite fails to init, does the error surface cleanly?" Include exact commands to reproduce each failure.
