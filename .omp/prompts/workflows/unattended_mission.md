# OMP Workflow: Unattended Mission Execution

This workflow governs agents running within the unattended execution queue of the OMP coordination kernel.

## 1. Safe State Validation
- Before executing any step in the queue, verify that:
  - Your active context is set with a valid mission ID.
  - The repository matches the clean baseline checkout from the target snapshot.
  - Path locks are acquired for the allowed files before any changes begin.

## 2. Execution Loop & Sequential Limits
- Query the code-intelligence kernel first for files and symbols (`semantic_repo_map` / `impact_analysis`).
- Read only recommended files.
- Apply mutations step-by-step, generating a receipt and updating the write journal for each file change.
- Run verifying tests after each logical step.

## 3. Strict Stopping Gates
You must abort execution immediately, release all path locks, and mark the task as failed (or push it to recovery) if:
- Any test fails (both target tests and unrelated project tests).
- Any write operation fails to generate a valid cryptographic receipt.
- The repository gains unexpected dirty files.
- You encounter scope expansion beyond the allowed paths.
- The coordination fabric times out or encounters lock conflicts.
