# task_board — Fleet Dashboard

**Used by**: GM, Secretary

## Purpose
See what's happening across all lanes. Shows running agents, stale sessions, wave progress, and alerts. Defaults to last 30 minutes.

## Arguments
- `max_age_minutes` — Only show recent sessions (default 30, 0 = all)
- `quick` — Skip coordination parsing, just show running/stale agents

## Output
```json
{
  "summary": "5 running, 12 done, 0 failed",
  "wave_summary": "cartography: ██ 2\nplan: · 0\nreview: · 0\nexecution: ███ 3\nvalidation: · 0\npublication: · 0",
  "fleet": [{"agent": "cartographer", "wave": "cartography", "status": "🟢 running", "current": "smart_find:started", "elapsed": "45s"}]
}
```

## When to Call
- Every turn to see fleet status
- Before spawning new agents to check lane progress
- When investigating stale agents
