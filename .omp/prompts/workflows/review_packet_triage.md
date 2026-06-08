# OMP Workflow: Review Packet Triage

This workflow outlines how agents interpret, triage, and act upon the outputs of paired review packets.

## 1. Finding Interpretation & Grading
- Read `10_review_findings.json` directly. Do not rely on command-line summaries or console outputs.
- Grade findings into three severity tiers:
  - **critical**: Security vulnerabilities, path policy bypasses, lock conflicts, missing integrity validations, or compilation errors. Must stop execution and block promotion.
  - **warning**: Missing optional docs, non-critical test failures, or minor style discrepancies. Requires manual review or warning bypass registration.
  - **info**: Code optimization tips, type hints, or profile-specific warnings. Can be safely registered and bypassed if allowed by project rules.

## 2. Semantic-Source Verification
- Compare the semantic ZIP snapshot and the source ZIP snapshot to ensure consistency.
- Verify that the `REVIEW_PACKET_MANIFEST.json` contains valid SHA-256 hashes matching all files.
- Reject the bundle if semantic review artifacts and physical source files are out of sync or derived from different git SHAs.

## 3. Safe Actions & Triage Progression
- If a finding is confirmed valid, structure a new mission targeting the exact file scope.
- Do not downgrade finding severities without a written, category-specific project policy change.
- Stop immediately if any file changes occur in the workspace during the triage process.
