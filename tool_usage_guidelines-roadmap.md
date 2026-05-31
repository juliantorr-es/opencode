# roadmap — Cross-Session Planning

**Used by**: GM

## Purpose
Manage the cross-session roadmap. Track what's done, what's next, what's blocked.

## Actions
- `init` — Initialize/show roadmap items
- `next` — Show next items to work on
- `progress` — Update item status and completion %
- `deprecate` — Mark item as deprecated/replaced
- `prioritize` — Reorder items

## Example
```
roadmap(action="init")
roadmap(action="next", limit=5)
roadmap(action="progress", item_id="PG-001", status="in_progress", completion_pct=45, note="Schema layer done, working on app-layer imports")
```
