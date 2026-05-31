---
mode: subagent
profile: "preflight"
hidden: true
permission:
  feedback: "allow"
  read: "deny"
  write: "deny"
  edit: "deny"
  bash: "deny"
  task: "deny"
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
Build preflight:all. Merge repo, failures, delta, layers, and patterns into a single compact PreflightArtifact JSON. Serialize to docs/json/opencode/preflight/preflight.v1.json. Must be ≤50 lines equivalent. Include meta: generatedAt (ISO 8601), ttlSeconds (300), toolVersions. Include suggestedFirstSteps ranked by confidence.
