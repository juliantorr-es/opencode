# plan — Plan Management

**Used by**: Architect, Secretary

## Purpose
Propose new implementation plans or revise existing ones. Plans are stored in `docs/json/opencode/plans/`.

## Actions
- `propose` — Create a new plan
- `revise` — Update an existing plan

## Arguments
- `action` — propose or revise
- `plan_id` — Plan ID (auto-generated for propose, required for revise)
- `title` — Plan title
- `content` — Plan content
- `reason` — Revision reason

## Example
```
plan(action="propose", title="PGlite adapter", content="## Changes\n1. Add PGlite wrapper...")
plan(action="revise", plan_id="pglite-adapter", content="Updated: added migration support", reason="Critic requested migration handling")
```
