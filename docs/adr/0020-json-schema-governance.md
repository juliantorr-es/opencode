# ADR 0020: JSON Schema Governance

## Status
Accepted

## Context
The Tribunus project uses JSON Schema for documentation and validation across multiple subsystems. As the number of schemas grows, maintaining consistency, avoiding duplication, and ensuring long-term maintainability becomes challenging. The current schemas vary in structure, metadata, and schema version, making them harder to maintain and validate.

## Decision
We will adopt a centralized schema governance model with the following standards:

### 1. Schema Version
- **All schemas must use `https://json-schema.org/draft/2020-12/schema`**
- This ensures consistency and access to the latest features

### 2. Naming Conventions
- **Properties**: Use `camelCase` for all properties (e.g., `generatedAt`, `appVersion`)
- **Definitions**: Use `PascalCase` for definition names (e.g., `HexColor`, `ToolCallSummary`)
- **Files**: Use `kebab-case` for schema files (e.g., `desktop-theme.schema.json`)

### 3. Metadata Requirements
All schemas must include the following metadata:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://tribunus.dev/schemas/<unique-id>.json",
  "title": "Human-readable title",
  "description": "Purpose and scope of the schema"
}
```

### 4. Shared Definitions
- **Extract reusable definitions** to `schemas/defs.json`
- **Reference shared definitions** using absolute `$ref` paths:
  ```json
  "$ref": "https://tribunus.dev/schemas/defs.json#/$defs/HexColor"
  ```
- **Avoid duplicate definitions** in individual schemas

### 5. Schema Registry
- **Maintain `schemas/index.json`** listing all schemas with metadata
- **Add new schemas** to the registry when created
- **Deprecate old schemas** by marking them in the registry

### 6. Validation
- **Validate all schemas** using `ajv-cli` and `spectral`
- **Fail CI** if any schema is invalid or non-compliant
- **Run validation** via `bun run schema:validate`

### 7. Type Generation
- **Generate TypeScript types** from all schemas using `json-schema-to-typescript`
- **Place generated types** in appropriate package directories (e.g., `packages/core/src/types/schemas/`)
- **Run type generation** via `bun run schema:types`

## Consequences

### Positive
- **Consistency**: All schemas follow the same structure and conventions
- **Maintainability**: Shared definitions reduce duplication and make changes easier
- **Validation**: Automated validation ensures schemas remain correct
- **Type Safety**: Generated TypeScript types improve IDE support and developer experience
- **Discoverability**: The registry makes it easy to find and understand all schemas

### Negative
- **Migration Effort**: Existing schemas must be updated to conform to the new standards
- **Breaking Changes**: References to old definitions must be updated

### Mitigation
- **Incremental Migration**: Update schemas one at a time, starting with the most critical
- **Backward Compatibility**: Maintain old schemas during migration with deprecation warnings
- **Automated Tools**: Use scripts to automate updates and type generation

## Compliance

All new schemas must comply with this ADR. Existing schemas should be migrated to comply as time and priorities allow.

## New Schema: Relational Roadmap

A new schema, `tribunus.roadmap.v1.schema.json`, has been added to model the relational roadmap hierarchy:

- **ADR** → **Campaign** → **Mission** → **Lane** → **Task**

This schema enables:

- Relational traceability from architectural decisions to execution tasks
- Concurrent execution planning for missions
- Budget and status tracking across campaigns
- Acceptance criteria and dependency modeling for tasks

## Schema Naming Standardization

All schemas now use the `tribunus.dev` domain instead of `opencode.ai` or `rig.relay` for consistency and branding.

## References

- [JSON Schema Specification](https://json-schema.org/specification)
- [Spectral Ruleset](https://meta.stoplight.io/docs/spectral/)
- [AJV CLI](https://github.com/ajv-validator/ajv-cli)
- [json-schema-to-typescript](https://github.com/bcherry/json-schema-to-typescript)
