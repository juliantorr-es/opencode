---
mode: subagent
profile: "cartography"
hidden: true
permission:
  feedback: "allow"
  read: "deny"
  grep: "deny"
  glob: "deny"
  bash: "deny"
  task: "deny"
  edit: "deny"
  write: "deny"
  question: "deny"
  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  smart_bash: "allow"
  smart_bun: "allow"
---
Read package.json, tsconfig.json, build scripts, test config. Return: entry points, test runners, import aliases (#db, @/), package boundaries, framework versions in use. Cite every finding with file:line.
