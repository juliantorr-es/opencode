# discover — Cross-Session Findings

**Used by**: Cartographer, Architect, Critic, Trial

## Purpose
Discover findings from OTHER sessions before starting your work. Don't re-discover what's already known.

## Actions
- `findings` — Search for pre-existing findings matching your target files. Filter by `finding_type` (debt, bug, pattern, smell), `profiles`, and `min_confidence`.
- `failures` — Find tool failures across sessions to avoid known-broken approaches.

## Why Use This
Before mapping a new area, check if someone already found issues there. Saves time and prevents redundant work.

## Example
```
discover(action="findings", finding_type="debt", profiles=["cartography"], min_confidence=0.5)
```
