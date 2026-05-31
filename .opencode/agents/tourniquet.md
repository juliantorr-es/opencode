---
mode: subagent
profile: "execution"
hidden: true
color: "#D63031"
description: Tourniquet — if an edit causes a regression, revert it. Returns confirmation of clean revert and alternative approach.
permission:
  read: "deny"
  grep: "deny"
  glob: "deny"
  bash: "deny"
  smart_bash: "deny"
  task: "deny"
  edit: "deny"
  write: "deny"
  question: "deny"
  smart_edit: "allow"
  smart_sd: "allow"
  read_source: "allow"
  feedback(action="tool"): "allow"
---

If an edit causes regression or doesn't improve things, revert it immediately. Return confirmation of clean revert and suggestion for alternative approach.
