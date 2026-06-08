// === OMP Custom Tools — Manifest Builders ===
// Hardcoded canonical tool manifests for the OMP bootstrap tools.
import type { OmpToolManifestV1, OmpAuthorityProfileV1 } from "./types.js"

// ── Shared helpers ──

function auth(overrides: Partial<OmpAuthorityProfileV1>): OmpAuthorityProfileV1 {
  return {
    risk_level: overrides.risk_level ?? "read",
    side_effects: overrides.side_effects ?? "none",
    requires_approval: overrides.requires_approval ?? false,
    requires_hash_precondition: overrides.requires_hash_precondition ?? false,
    allowed_roots: overrides.allowed_roots ?? [],
    denied_patterns: overrides.denied_patterns ?? [],
    max_input_bytes: overrides.max_input_bytes,
    max_output_bytes: overrides.max_output_bytes,
    max_files_touched: overrides.max_files_touched,
    max_file_bytes: overrides.max_file_bytes,
  }
}

const ALL_EXPORTS = {
  mistral_function_calling: true,
  openai_tools: true,
  anthropic_tools: true,
  mcp: true,
} as const

// ── Generic buildManifest ──

export function buildManifest(
  toolId: string,
  opts: {
    version: string
    title: string
    description: string
    authority: OmpAuthorityProfileV1
    inputSchema: unknown
    outputSchema: unknown
    examples?: OmpToolManifestV1["examples"]
    providerExports?: OmpToolManifestV1["provider_exports"]
  },
): OmpToolManifestV1 {
  return {
    schema: "omp.tool.manifest.v1",
    tool_id: toolId,
    version: opts.version,
    title: opts.title,
    description: opts.description,
    authority: opts.authority,
    input_schema: opts.inputSchema,
    output_schema: opts.outputSchema,
    examples: opts.examples,
    provider_exports: opts.providerExports ?? ALL_EXPORTS,
  }
}

// ── text_replace ──

export function textReplaceManifest(): OmpToolManifestV1 {
  return {
    schema: "omp.tool.manifest.v1",
    tool_id: "text_replace",
    version: "1.0.0",
    title: "Text Replace",
    description:
      "Search and replace literal text in a file using exact string matching. " +
      "Use this for surgical edits where you know the exact text to replace. " +
      "Not regex — no escaping surprises. For line-based edits, use the built-in edit tool instead.",
    authority: auth({
      risk_level: "write_medium",
      side_effects: "filesystem_write",
      requires_approval: true,
      requires_hash_precondition: true,
    }),
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to project root" },
        expected_before_sha256: { type: "string", description: "SHA-256 of file before mutation" },
        old_text: { type: "string", description: "Exact text to replace — literal match, no regex" },
        new_text: { type: "string", description: "Replacement text" },
        replace_mode: { type: "string", enum: ["exact_once"], description: "Only replace if exactly one match" },
        allow_unverified_write: { type: "boolean", description: "Skip hash verification" },
        unverified_write_reason: { type: "string", description: "Why hash verification is skipped" },
        reason: { type: "string", description: "Why this replacement is needed" },
      },
      required: ["path", "expected_before_sha256", "old_text", "new_text"],
    },
    output_schema: {
      type: "object",
      properties: {
        file: { type: "string" },
        before_sha256: { type: "string" },
        after_sha256: { type: "string" },
        diff: { type: "string" },
        match_count: { type: "number" },
      },
    },
    provider_exports: ALL_EXPORTS,
  }
}

// ── batch_edit ──

export function batchEditManifest(): OmpToolManifestV1 {
  return {
    schema: "omp.tool.manifest.v1",
    tool_id: "batch_edit",
    version: "1.0.0",
    title: "Batch Edit",
    description:
      "Apply multiple text replacements across multiple files as a single atomic operation. " +
      "All edits are validated before any are applied. If any edit fails validation, none are applied. " +
      "Returns a consolidated diff. Use this for fix groups that must be applied together or not at all.",
    authority: auth({
      risk_level: "write_high",
      side_effects: "filesystem_write",
      requires_approval: true,
      requires_hash_precondition: true,
    }),
    input_schema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              expected_before_sha256: { type: "string" },
              edits: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: ["replace_exact_once"] },
                    old_text: { type: "string" },
                    new_text: { type: "string" },
                  },
                  required: ["kind", "old_text", "new_text"],
                },
              },
            },
            required: ["path", "expected_before_sha256", "edits"],
          },
        },
        allow_unverified_write: { type: "boolean" },
        unverified_write_reason: { type: "string" },
        reason: { type: "string" },
      },
      required: ["files"],
    },
    output_schema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "object" } },
        diff: { type: "string" },
      },
    },
    provider_exports: ALL_EXPORTS,
  }
}

// ── struct_read ──

export function structReadManifest(): OmpToolManifestV1 {
  return {
    schema: "omp.tool.manifest.v1",
    tool_id: "struct_read",
    version: "1.0.0",
    title: "Structured Read",
    description:
      "Read a source file and return a structured digest: imports, exports, top-level symbols. " +
      "When 'focus' is provided, extracts just that symbol with its import block using " +
      "tree-sitter or regex+brace-counting. Use this to navigate code structure without reading entire files.",
    authority: auth({
      risk_level: "read",
      side_effects: "filesystem_read",
      requires_approval: false,
      requires_hash_precondition: false,
    }),
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to project root" },
        mode: {
          type: "string",
          enum: ["full", "head", "range", "symbols", "focus"],
          description: "Read mode",
        },
        start_line: { type: "number", description: "Start line for range mode" },
        end_line: { type: "number", description: "End line for range mode" },
        symbol_name: { type: "string", description: "Symbol name for focus mode" },
        max_bytes: { type: "number", description: "Maximum bytes to read" },
        max_lines: { type: "number", description: "Maximum lines to read" },
        include_sha256: { type: "boolean", description: "Include file SHA-256" },
        include_line_numbers: { type: "boolean", description: "Include line numbers" },
      },
      required: ["path"],
    },
    output_schema: {
      type: "object",
      properties: {
        file: { type: "string" },
        lines: { type: "number" },
        sha256: { type: "string" },
        symbols: { type: "array" },
        content: { type: "string" },
      },
    },
    provider_exports: ALL_EXPORTS,
  }
}
