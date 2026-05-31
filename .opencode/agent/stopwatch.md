---
mode: subagent
profile: "qa"
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
Compare test timing before and after the change. Return: "httpapi-listen went from 38ms (crash) to 1650ms (builds but fails) to 100ms (expected if it passes)." Flag any test that changed by >2x. If no baseline, measure absolute numbers and flag anything suspicious.
