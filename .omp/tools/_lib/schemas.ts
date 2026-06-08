// === OMP Custom Tools — Inline Runtime Validators ===
// Hand-rolled validation (no Zod dependency) for _lib use.
// Following the types from types.ts exactly.

// ── Input Types ──

export type TextReplaceInputV1 = {
  path: string
  expected_before_sha256: string
  old_text: string
  new_text: string
  replace_mode?: "exact_once"
  allow_unverified_write?: boolean
  unverified_write_reason?: string
  reason?: string
}

export type BatchEditFileV1 = {
  path: string
  expected_before_sha256: string
  edits: Array<{ kind: "replace_exact_once"; old_text: string; new_text: string }>
}

export type BatchEditInputV1 = {
  files: BatchEditFileV1[]
  allow_unverified_write?: boolean
  unverified_write_reason?: string
  reason?: string
}

export type StructReadInputV1 = {
  path: string
  mode?: "full" | "head" | "range" | "symbols" | "focus"
  start_line?: number
  end_line?: number
  symbol_name?: string
  max_bytes?: number
  max_lines?: number
  include_sha256?: boolean
  include_line_numbers?: boolean
}

// ── Validators ──

function isString(v: unknown): v is string {
  return typeof v === "string"
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean"
}

function isNumber(v: unknown): v is number {
  return typeof v === "number"
}

function missingField(name: string): string {
  return `missing required field: ${name}`
}

function badType(name: string, expected: string): string {
  return `field "${name}": expected ${expected}`
}

/**
 * Validate a `TextReplaceInputV1` from an unknown input.
 */
export function validateTextReplaceInput(
  input: unknown,
): { ok: true; value: TextReplaceInputV1 } | { ok: false; error: string } {
  if (!isRecord(input)) {
    return { ok: false, error: "input must be a non-null object" }
  }

  // Required strings
  if (!isString(input.path)) return { ok: false, error: missingField("path") }
  if (!isString(input.expected_before_sha256)) return { ok: false, error: missingField("expected_before_sha256") }
  if (!isString(input.old_text)) return { ok: false, error: missingField("old_text") }
  if (!isString(input.new_text)) return { ok: false, error: missingField("new_text") }

  // Optional enum
  if (input.replace_mode !== undefined && input.replace_mode !== "exact_once") {
    return { ok: false, error: badType("replace_mode", '"exact_once" or undefined') }
  }

  // Optional booleans / strings
  if (input.allow_unverified_write !== undefined && !isBoolean(input.allow_unverified_write)) {
    return { ok: false, error: badType("allow_unverified_write", "boolean") }
  }
  if (input.unverified_write_reason !== undefined && !isString(input.unverified_write_reason)) {
    return { ok: false, error: badType("unverified_write_reason", "string") }
  }
  if (input.reason !== undefined && !isString(input.reason)) {
    return { ok: false, error: badType("reason", "string") }
  }

  return {
    ok: true,
    value: input as TextReplaceInputV1,
  }
}

/**
 * Validate a batch edit file entry.
 */
function validateBatchEditFile(file: unknown): { ok: true; value: BatchEditFileV1 } | { ok: false; error: string } {
  if (!isRecord(file)) {
    return { ok: false, error: "each file entry must be a non-null object" }
  }

  if (!isString(file.path)) return { ok: false, error: missingField("file.path") }
  if (!isString(file.expected_before_sha256)) return { ok: false, error: missingField("file.expected_before_sha256") }

  if (!Array.isArray(file.edits)) {
    return { ok: false, error: missingField("file.edits") }
  }

  for (let i = 0; i < file.edits.length; i++) {
    const ed = file.edits[i]
    if (!isRecord(ed)) {
      return { ok: false, error: `file.edits[${i}] must be a non-null object` }
    }
    if (ed.kind !== "replace_exact_once") {
      return { ok: false, error: `file.edits[${i}].kind must be "replace_exact_once"` }
    }
    if (!isString(ed.old_text)) {
      return { ok: false, error: `file.edits[${i}] missing required field: old_text` }
    }
    if (!isString(ed.new_text)) {
      return { ok: false, error: `file.edits[${i}] missing required field: new_text` }
    }
  }

  return {
    ok: true,
    value: file as BatchEditFileV1,
  }
}

/**
 * Validate a `BatchEditInputV1` from an unknown input.
 */
export function validateBatchEditInput(
  input: unknown,
): { ok: true; value: BatchEditInputV1 } | { ok: false; error: string } {
  if (!isRecord(input)) {
    return { ok: false, error: "input must be a non-null object" }
  }

  if (!Array.isArray(input.files)) {
    return { ok: false, error: missingField("files") }
  }
  if (input.files.length === 0) {
    return { ok: false, error: "files array must not be empty" }
  }

  const validatedFiles: BatchEditFileV1[] = []
  for (let i = 0; i < input.files.length; i++) {
    const result = validateBatchEditFile(input.files[i])
    if (!result.ok) {
      return { ok: false, error: `files[${i}]: ${result.error}` }
    }
    validatedFiles.push(result.value)
  }

  if (input.allow_unverified_write !== undefined && !isBoolean(input.allow_unverified_write)) {
    return { ok: false, error: badType("allow_unverified_write", "boolean") }
  }
  if (input.unverified_write_reason !== undefined && !isString(input.unverified_write_reason)) {
    return { ok: false, error: badType("unverified_write_reason", "string") }
  }
  if (input.reason !== undefined && !isString(input.reason)) {
    return { ok: false, error: badType("reason", "string") }
  }

  return {
    ok: true,
    value: { files: validatedFiles, allow_unverified_write: (input as any).allow_unverified_write, unverified_write_reason: (input as any).unverified_write_reason, reason: (input as any).reason },
  }
}

/**
 * Validate a `StructReadInputV1` from an unknown input.
 */
export function validateStructReadInput(
  input: unknown,
): { ok: true; value: StructReadInputV1 } | { ok: false; error: string } {
  if (!isRecord(input)) {
    return { ok: false, error: "input must be a non-null object" }
  }

  if (!isString(input.path)) return { ok: false, error: missingField("path") }

  const validModes: string[] = ["full", "head", "range", "symbols", "focus"]
  if (input.mode !== undefined) {
    if (typeof input.mode !== "string" || validModes.indexOf(input.mode) === -1) {
      return { ok: false, error: badType("mode", 'one of "full" | "head" | "range" | "symbols" | "focus"') }
    }
  }

  if (input.start_line !== undefined && !isNumber(input.start_line)) {
    return { ok: false, error: badType("start_line", "number") }
  }
  if (input.end_line !== undefined && !isNumber(input.end_line)) {
    return { ok: false, error: badType("end_line", "number") }
  }
  if (input.symbol_name !== undefined && !isString(input.symbol_name)) {
    return { ok: false, error: badType("symbol_name", "string") }
  }
  if (input.max_bytes !== undefined && !isNumber(input.max_bytes)) {
    return { ok: false, error: badType("max_bytes", "number") }
  }
  if (input.max_lines !== undefined && !isNumber(input.max_lines)) {
    return { ok: false, error: badType("max_lines", "number") }
  }
  if (input.include_sha256 !== undefined && !isBoolean(input.include_sha256)) {
    return { ok: false, error: badType("include_sha256", "boolean") }
  }
  if (input.include_line_numbers !== undefined && !isBoolean(input.include_line_numbers)) {
    return { ok: false, error: badType("include_line_numbers", "boolean") }
  }

  return {
    ok: true,
    value: input as StructReadInputV1,
  }
}
