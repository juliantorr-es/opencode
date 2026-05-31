# gate — Publish Findings

**Used by**: All agents

## Purpose
Share discoveries with other sessions. When you find something other lanes should know about, publish it.

## Actions
- `finding` — Publish a finding so other agents can discover it
- `checkpoint` — Record a wave checkpoint for coordination tracking

## Example
```
gate(action="finding", finding_type="smell", file="src/adapter.ts:142", detail="DatabaseAdapter.query() undocumented — no type signature", confidence=0.9)
```
