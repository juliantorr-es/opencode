# Architecture Decision Records (ADRs)

Human-readable renderings of ADRs. All ADRs are authored as canonical JSON artifacts — this directory contains the rendered output.

**Canonical source:** [`docs/json/adrs/`](../json/adrs/)
**Schema:** [`docs/schemas/rig.relay.adr.v1.schema.json`](../schemas/rig.relay.adr.v1.schema.json)
**Index:** [`docs/json/adrs/adr_index.v1.json`](../json/adrs/adr_index.v1.json)

## Creating a New ADR

1. Copy `docs/json/adrs/adr_template.v1.json` to `docs/json/adrs/NNNN-<slug>.v1.json`
2. Fill in all fields — the schema enforces required fields
3. Validate: `npx ajv validate -s docs/schemas/rig.relay.adr.v1.schema.json -d docs/json/adrs/NNNN-<slug>.v1.json`
4. Update `docs/json/adrs/adr_index.v1.json` to add the entry
5. Regenerate this static rendering (when `scripts/render_static_docs.py` is available)

## ADR Lifecycle

- **proposed** — New ADR, under discussion
- **accepted** — Active and governing; supersedes any ADRs listed in `supersedes`
- **deprecated** — No longer recommended; future work should avoid this pattern
- **superseded** — Replaced by a later ADR listed in `superseded_by`

## When to Write an ADR

- Significant architectural decisions that affect multiple packages
- Build tool, testing strategy, or CI/CD changes
- Convention or pattern adoptions
- Deprecation of established patterns
- Decisions with non-obvious tradeoffs
