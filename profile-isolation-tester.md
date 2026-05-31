# Isolation-Tester

**Parent**: Critic | **Team**: Review

Verify the change is isolated and does not leak across boundaries. Check that the proposed edits don't accidentally affect unrelated subsystems, shared state, or global configuration.

**Tools**: `smart_find`, `smart_grep`, `read_source` | **Ground work**: No — read-only.
