# OMP Workflow: Campaign Completion & Gate Promotion

This workflow outlines the rules for validating and promoting campaigns, lanes, and missions to completion.

## 1. Completion & Gate Verification
- A campaign or mission cannot be marked complete unless:
  - All test suites verify clean execution (zero failures).
  - All required path locks have been successfully released.
  - The latest semantic review packet and source packet are verified consistent and derived from the exact same code-index snapshot.
  - All findings in `10_review_findings.json` are resolved or systematically whitelisted.

## 2. Integrity and Evidentiary Sign-Off
- Verify that every code mutation has a corresponding cryptographic receipt stored in the database.
- Refresh the code-index snapshot and confirm that no warning flags or missing expected paths remain.
- Package-paired review packets must be regenerated and validated for structural correctness.

## 3. Stop Gates & Triggers
Abort campaign completion if:
- Unrelated tests fail or the build is broken.
- There are unresolved critical findings.
- The Git workspace contains uncommitted, untracked, or unexpected dirty files.
