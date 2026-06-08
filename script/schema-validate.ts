#!/usr/bin/env bun
// Schema validation script
// Validates all JSON schemas against the 2020-12 meta-schema via ajv,
// and lints them with spectral for best-practice compliance.

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

const SPECTRAL_BIN = resolve("node_modules/.bin/spectral");
const ROOT = resolve(import.meta.dirname, "..");

// Schema metadata files (self-describing registry files)
const SCHEMA_REGISTRY_FILES = ["schemas/index.json", "schemas/defs.json"];

// Directories containing .schema.json files
const SCHEMA_DIRS = ["docs/schemas", "packages/ui/src/theme"];

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------- helpers ----------

function findSchemaFiles(): string[] {
  const results: string[] = [];
  for (const dir of SCHEMA_DIRS) {
    const abs = resolve(ROOT, dir);
    if (!existsSync(abs)) continue;
    const entries = readdirSync(abs);
    for (const entry of entries) {
      if (entry.endsWith(".schema.json")) {
        const p = join(abs, entry);
        if (statSync(p).isFile()) results.push(p);
      }
    }
  }
  return results;
}

function parseJsonFile(filePath: string): unknown {
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

// ---------- AJV meta-schema validation ----------

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    strict: false,
    validateFormats: false,
  });
  addFormats(ajv);
  return ajv;
}

function registerDefs(ajv: Ajv2020): void {
  const defsPath = resolve(ROOT, "schemas/defs.json");
  if (!existsSync(defsPath)) return;
  try {
    const defs = parseJsonFile(defsPath) as Record<string, unknown>;
    ajv.addSchema(defs, defsPath);
  } catch {
    // Will be reported by validateMetaSchema separately
  }
}

function validateMetaSchema(schemaPath: string): ValidationResult {
  const errors: string[] = [];
  let schema: unknown;
  try {
    schema = parseJsonFile(schemaPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`JSON parse error in ${schemaPath}: ${msg}`);
    return { valid: false, errors };
  }

  // For defs.json, validate with a temporary ajv without registering first
  // For all other schemas, use an ajv that has defs.json registered
  const ajv = createAjv();
  const isDefs = schemaPath.includes("defs.json");
  if (!isDefs) {
    registerDefs(ajv);
  }

  // Compile the schema to check structural validity
  try {
    ajv.compile(schema);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`${schemaPath}: schema compile error: ${msg}`);
  }

  return { valid: errors.length === 0, errors };
}

// ---------- Spectral linting ----------

async function lintSchema(schemaPath: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const rel = relative(ROOT, schemaPath);

  try {
    // Use JSON output to parse and filter diagnostics.
    // Schemas reference defs.json via HTTPS URLs which spectral cannot
    // resolve (invalid-ref), but ajv handles local resolution.
    const proc = Bun.spawnSync(
      [SPECTRAL_BIN, "lint", schemaPath, "--ruleset", ".spectral.yaml", "--format", "json"],
      { cwd: ROOT, env: { ...process.env } },
    );

    const stderr = proc.stderr.toString().trim();

    if (proc.exitCode === 2) {
      errors.push(`${rel}: spectral runtime error: ${stderr || "unknown error"}`);
      return { valid: false, errors };
    }

    // Parse JSON output and filter out expected invalid-ref diagnostics.
    // spectral may append informational text after the JSON array (e.g.
    // "No results with a severity of 'error' found!"), so extract the
    // first valid JSON array from the output.
    const stdout = proc.stdout.toString().trim();
    if (stdout.length > 0) {
      let diagnostics: unknown[] = [];
      // Find the first '[' and parse everything up to the matching ']'
      const jsonStart = stdout.indexOf("[");
      if (jsonStart >= 0) {
        let depth = 0;
        let jsonEnd = -1;
        for (let i = jsonStart; i < stdout.length; i++) {
          if (stdout[i] === "[") depth++;
          else if (stdout[i] === "]") {
            depth--;
            if (depth === 0) { jsonEnd = i + 1; break; }
          }
        }
        if (jsonEnd > jsonStart) {
          try {
            diagnostics = JSON.parse(stdout.slice(jsonStart, jsonEnd)) as unknown[];
          } catch {
            // Fall through to report below
          }
        }
      }

      if (diagnostics.length === 0 && stdout.includes("[") === false) {
        errors.push(`${rel}: spectral non-JSON output: ${stdout.slice(0, 200)}`);
        return { valid: false, errors };
      }

      const realIssues: string[] = [];
      for (const d of diagnostics) {
        if (typeof d !== "object" || d === null) continue;
        const diag = d as Record<string, unknown>;
        // Skip invalid-ref - our schemas use HTTPS $ref to local files
        if (diag.code === "invalid-ref") continue;
        // Skip parser errors (handled by ajv)
        if (diag.code === "parser") continue;

        const code = diag.code ?? "unknown";
        const severity = diag.severity ?? 0;
        const message = diag.message ?? "";
        const path = diag.path ?? "";
        realIssues.push(`  [${severity}] ${code}: ${message} (at ${path})`);
      }

      if (realIssues.length > 0) {
        errors.push(`${rel}: spectral lint found issues:\n${realIssues.join("\n")}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`${rel}: spectral error: ${msg}`);
  }

  return { valid: errors.length === 0, errors };
}

// ---------- Index/defs registry data validation ----------

function validateRegistryEntry(entry: unknown, fileHint: string): string | null {
  if (typeof entry !== "object" || entry === null) {
    return `${fileHint}: entry is not an object`;
  }
  const obj = entry as Record<string, unknown>;
  if (typeof obj.id !== "string") return `${fileHint}: entry missing string 'id'`;
  if (typeof obj.title !== "string") return `${fileHint}: entry missing string 'title'`;
  if (typeof obj.path !== "string") return `${fileHint}: entry missing string 'path'`;
  return null;
}

function validateRegistryData(filePath: string): ValidationResult {
  const errors: string[] = [];
  const rel = relative(ROOT, filePath);

  let data: unknown;
  try {
    data = parseJsonFile(filePath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`JSON parse error in ${rel}: ${msg}`);
    return { valid: false, errors };
  }

  if (typeof data !== "object" || data === null) {
    errors.push(`${rel}: root value is not an object`);
    return { valid: false, errors };
  }

  const root = data as Record<string, unknown>;

  // schemas/index.json must have a "schemas" array
  if (filePath.includes("index.json")) {
    if (!Array.isArray(root.schemas)) {
      errors.push(`${rel}: missing 'schemas' array`);
    } else {
      for (let i = 0; i < root.schemas.length; i++) {
        const entryErr = validateRegistryEntry(root.schemas[i], `${rel}[${i}]`);
        if (entryErr !== null) errors.push(entryErr);
      }
      // Check for duplicate IDs
      const ids = new Map<string, number[]>();
      for (let i = 0; i < root.schemas.length; i++) {
        const entry = root.schemas[i] as Record<string, unknown> | null;
        if (entry && typeof entry.id === "string") {
          const prev = ids.get(entry.id) ?? [];
          prev.push(i);
          ids.set(entry.id, prev);
        }
      }
      for (const [id, indices] of ids) {
        if (indices.length > 1) {
          errors.push(`${rel}: duplicate schema id "${id}" at indices ${indices.join(", ")}`);
        }
      }
    }
  }

  // Verify referenced schema files exist
  if (filePath.includes("index.json") && Array.isArray(root.schemas)) {
    for (let i = 0; i < root.schemas.length; i++) {
      const entry = root.schemas[i] as Record<string, unknown> | null;
      if (entry && typeof entry.path === "string") {
        const schemaPath = resolve(ROOT, entry.path as string);
        if (!existsSync(schemaPath)) {
          errors.push(`${rel}[${i}]: referenced schema file not found: ${entry.path}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------- main ----------

async function main(): Promise<number> {
  let hasErrors = false;

  // Phase 1: validate registry data (index.json, defs.json)
  console.log("\n--- Schema Registry Validation ---");
  for (const rel of SCHEMA_REGISTRY_FILES) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) {
      console.error(`  SKIP  ${rel} (not found)`);
      continue;
    }
    const { valid, errors } = validateRegistryData(abs);
    if (valid) {
      console.log(`  PASS  ${rel}`);
    } else {
      hasErrors = true;
      for (const err of errors) {
        console.error(`  FAIL  ${err}`);
      }
    }
  }

  // Phase 2: AJV meta-schema validation
  console.log("\n--- AJV Meta-Schema Validation ---");
  const allSchemaPaths = [
    ...SCHEMA_REGISTRY_FILES.map((f) => resolve(ROOT, f)),
    ...findSchemaFiles(),
  ].filter((p) => existsSync(p));

  for (const abs of allSchemaPaths) {
    const rel = relative(ROOT, abs);
    const { valid, errors } = validateMetaSchema(abs);
    if (valid) {
      console.log(`  PASS  ${rel}`);
    } else {
      hasErrors = true;
      for (const err of errors) {
        console.error(`  FAIL  ${err}`);
      }
    }
  }

  // Phase 3: Spectral linting
  console.log("\n--- Spectral Linting ---");
  for (const abs of allSchemaPaths) {
    const rel = relative(ROOT, abs);
    const { valid, errors } = await lintSchema(abs);
    if (valid) {
      console.log(`  PASS  ${rel}`);
    } else {
      hasErrors = true;
      for (const err of errors) {
        console.error(`  FAIL  ${err}`);
      }
    }
  }

  console.log(""); // blank line

  if (hasErrors) {
    console.error("Schema validation failed.");
    return 1;
  }

  console.log("All schemas validated successfully.");
  return 0;
}

const exitCode = await main();
process.exit(exitCode);
