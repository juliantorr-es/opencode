# OMP Prompt Snippet: Shared Stop Conditions

You must immediately stop your execution loop, discard changes if necessary, and report back to the coordination supervisor if you encounter any of the following triggers:

1. **Scope Expansion**:
   - Proposed file modifications fall outside the allowed paths specified in the active mission packet.
   - Any attempt to modify root files, coordination system files, security systems, or tool definitions without explicit authorization.

2. **Authority Ambiguity**:
   - Lack of clarity regarding write permissions, mission constraints, definition of done, or target coordinates.
   - Conflicting instructions between the system context and the user query.

3. **Validation and Verification Failure**:
   - Encountering failing tests that are unrelated to the current files being edited (collateral breaks).
   - Inability to compile the codebase or resolve TypeScript compiler flags.

4. **Workspace State Anomalies**:
   - Workspace files are unexpectedly modified or dirty without active path locks.
   - Target files do not match the expected SHA-256 hashes registered in the mission packet.

5. **Review Packet Findings**:
   - Finding one or more critical errors or unresolved security vulnerabilities listed in `10_review_findings.json`.
