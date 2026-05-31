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
Check if repeated operations leak memo maps, scopes, or event listeners. Run N cycles (listen/stop, open/close, create/destroy) and check heap/context size. Return: "after 100 listen/stop cycles, the memo map has 10,000 entries" — with growth rate and saturation point.
