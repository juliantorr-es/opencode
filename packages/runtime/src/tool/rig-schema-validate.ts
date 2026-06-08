import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./rig-schema-validate.txt"

const Parameters = Schema.Struct({
  artifact: Schema.String.annotate({ description: "Path to the JSON or JSONL artifact" }),
  schema: Schema.optional(Schema.String).annotate({ description: "Optional path to a JSON Schema file" }),
  label: Schema.optional(Schema.String).annotate({ description: "Optional human-readable label" }),
})

function detectKind(filePath: string): "jsonl" | "json" {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".jsonl" || ext === ".ndjson" || ext === ".jsonlines") return "jsonl"
  return "json"
}

interface ValidationError {
  line?: number
  message: string
}

function buildPath(segments: (string | number)[]): string {
  if (segments.length === 0) return ""
  return segments
    .map((s) => (typeof s === "number" ? `[${s}]` : `.${s}`))
    .join("")
    .replace(/^\./, "")
}

// Basic JSON Schema validation using structural checks
function validateAgainstSchema(
  data: unknown,
  schema: Record<string, unknown>,
  path: (string | number)[] = [],
): ValidationError[] {
  const errors: ValidationError[] = []

  // Check type
  if (schema.type && typeof data !== schema.type) {
    errors.push({
      message: `${buildPath(path)}: Expected type '${String(schema.type)}', got '${typeof data}'`,
    })
  }

  // Check required properties for objects
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>
    const required = schema.required as string[] | undefined
    if (Array.isArray(required)) {
      for (const prop of required) {
        if (!(prop in obj)) {
          errors.push({
            message: `${buildPath([...path, prop])}: Missing required property '${prop}'`,
          })
        }
      }
    }

    // Check properties
    const properties = schema.properties as Record<string, unknown> | undefined
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in obj) {
          errors.push(...validateAgainstSchema(obj[key], propSchema as Record<string, unknown>, [...path, key]))
        }
      }
    }
  }

  // Check array items
  if (Array.isArray(data) && schema.items) {
    const itemsSchema = schema.items as Record<string, unknown>
    for (let i = 0; i < data.length; i++) {
      errors.push(...validateAgainstSchema(data[i], itemsSchema, [...path, i]))
    }
  }

  return errors
}

export const RigSchemaValidateTool = Tool.define(
  "rig_schema_validate",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      cacheable: true,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const artifactPath = path.isAbsolute(params.artifact)
            ? params.artifact
            : path.resolve(instance.directory, params.artifact)
          const schemaPath = params.schema
            ? path.isAbsolute(params.schema)
              ? params.schema
              : path.resolve(instance.directory, params.schema)
            : null
          const label = params.label ?? artifactPath

          if (!(yield* fs.existsSafe(artifactPath))) {
            return {
              title: "rig_schema_validate",
              metadata: { status: "fail" },
              output: JSON.stringify(
                {
                  status: "fail",
                  label,
                  artifact: artifactPath,
                  kind: detectKind(artifactPath),
                  error: `File not found: ${artifactPath}`,
                },
                null,
                2,
              ),
            }
          }

          const kind = detectKind(artifactPath)

          // Load schema if provided
          let schema: Record<string, unknown> | null = null
          if (schemaPath) {
            if (!(yield* fs.existsSafe(schemaPath))) {
              return {
                title: "rig_schema_validate",
                metadata: { status: "fail" },
                output: JSON.stringify(
                  {
                    status: "fail",
                    label,
                    artifact: artifactPath,
                    kind,
                    error: `Schema file not found: ${schemaPath}`,
                  },
                  null,
                  2,
                ),
              }
            }
            try {
              const schemaContent = yield* fs.readFileString(schemaPath)
              schema = JSON.parse(schemaContent) as Record<string, unknown>
            } catch (err) {
              return {
                title: "rig_schema_validate",
                metadata: { status: "fail" },
                output: JSON.stringify(
                  {
                    status: "fail",
                    label,
                    artifact: artifactPath,
                    kind,
                    schema: schemaPath,
                    error: `JSONDecodeError: Failed to parse schema: ${err}`,
                  },
                  null,
                  2,
                ),
              }
            }
          }

          try {
            if (kind === "jsonl") {
              const content = yield* fs.readFileString(artifactPath)
              const lines = content.split("\n").filter((l: string) => l.trim())
              const records: unknown[] = []
              const allErrors: ValidationError[] = []

              for (let lineNo = 0; lineNo < lines.length; lineNo++) {
                try {
                  const record = JSON.parse(lines[lineNo])
                  records.push(record)

                  if (schema) {
                    const recordErrors = validateAgainstSchema(record, schema)
                    allErrors.push(
                      ...recordErrors.map((e) => ({
                        ...e,
                        message: `line ${lineNo + 1}: ${e.message}`,
                      })),
                    )
                    if (allErrors.length >= 10) break
                  }
                } catch (err) {
                  allErrors.push({
                    line: lineNo + 1,
                    message: `line ${lineNo + 1}: JSON parse error: ${err}`,
                  })
                  if (allErrors.length >= 10) break
                }
              }

              if (allErrors.length > 0) {
                return {
                  title: "rig_schema_validate",
                  metadata: { status: "fail", records: records.length },
                  output: JSON.stringify(
                    {
                      status: "fail",
                      label,
                      artifact: artifactPath,
                      kind,
                      schema: schemaPath ?? "none",
                      records: records.length,
                      errors: allErrors,
                    },
                    null,
                    2,
                  ),
                }
              }

              return {
                title: "rig_schema_validate",
                metadata: { status: "pass", records: records.length },
                output: JSON.stringify(
                  {
                    status: "pass",
                    label,
                    artifact: artifactPath,
                    kind,
                    schema: schemaPath ?? "none",
                    records: records.length,
                    validated_records: records.length,
                  },
                  null,
                  2,
                ),
              }
            } else {
              const content = yield* fs.readFileString(artifactPath)
              const data = JSON.parse(content)
              const allErrors: ValidationError[] = []

              if (schema) {
                const errors = validateAgainstSchema(data, schema)
                allErrors.push(...errors)
              }

              if (allErrors.length > 0) {
                return {
                  title: "rig_schema_validate",
                  metadata: { status: "fail" },
                  output: JSON.stringify(
                    {
                      status: "fail",
                      label,
                      artifact: artifactPath,
                      kind,
                      schema: schemaPath ?? "none",
                      errors: allErrors.slice(0, 10),
                    },
                    null,
                    2,
                  ),
                }
              }

              return {
                title: "rig_schema_validate",
                metadata: { status: "pass" },
                output: JSON.stringify(
                  {
                    status: "pass",
                    label,
                    artifact: artifactPath,
                    kind,
                    schema: schemaPath ?? "none",
                    validated_records: 1,
                  },
                  null,
                  2,
                ),
              }
            }
          } catch (err) {
            return {
              title: "rig_schema_validate",
              metadata: { status: "fail" },
              output: JSON.stringify(
                {
                  status: "fail",
                  label,
                  artifact: artifactPath,
                  kind,
                  schema: schemaPath ?? "none",
                  error: `JSONDecodeError: ${err}`,
                },
                null,
                2,
              ),
            }
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as RigSchemaValidate from "./rig-schema-validate"
