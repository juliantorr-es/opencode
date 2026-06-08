# JSON Schema Registry

This directory contains the JSON Schema registry for the OpenCode/Tribunus project. All schemas should follow the conventions below for consistency and maintainability.

## Conventions

- **Schema Version**: Use `https://json-schema.org/draft/2020-12/schema`
- **Naming**: Use `camelCase` for all properties and definitions
- **Metadata**: All schemas must include `title`, `description`, and `$id`
- **Definitions**: Shared definitions should be extracted to `schemas/defs.json`
- **Validation**: All schemas must pass validation via `ajv-cli` and `spectral`

## Adding a New Schema

1. Create a new file in `docs/schemas/` or the appropriate location
2. Add it to `schemas/index.json`
3. Extract any shared definitions to `schemas/defs.json`
4. Ensure it references shared definitions where applicable

## Schema Index

All schemas are listed in `schemas/index.json`.

## Shared Definitions

Shared definitions are in `schemas/defs.json`.

## Validation

Run `bun run schema:validate` to validate all schemas.

## Type Generation

Run `bun run schema:types` to generate TypeScript types from all schemas.
