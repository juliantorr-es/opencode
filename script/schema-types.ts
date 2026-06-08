#!/usr/bin/env bun
// Schema type generation — reads all JSON schemas and generates TypeScript types.
// Lightweight inline converter; no external dependency beyond Bun.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";

// ---------------------------------------------------------------------------
// JSON Schema type definitions
// ---------------------------------------------------------------------------

interface SchemaNode {
  type?: string | string[];
  $ref?: string;
  description?: string;
  title?: string;
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
  required?: string[];
  items?: SchemaNode;
  enum?: (string | number)[];
  $defs?: Record<string, SchemaNode>;
  definitions?: Record<string, SchemaNode>;
  format?: string;
  pattern?: string;
  const?: string | number | boolean;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
}

interface SchemaDoc extends SchemaNode {
  $schema: string;
  $id: string;
  title?: string;
  description?: string;
  $defs?: Record<string, SchemaNode>;
  definitions?: Record<string, SchemaNode>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SCHEMA_DIRS = ["docs/schemas", "schemas", "packages/ui/src/theme"];
const OUTPUT_PATH = "schemas/generated/types.ts";
const DEFS_PATH = "schemas/defs.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPascalCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/(?:^|_)([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function findSchemaFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCHEMA_DIRS) {
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (full.endsWith(".schema.json") && statSync(full).isFile()) {
          files.push(full);
        }
      }
    } catch {
      /* directory may not exist */
    }
  }
  return files.sort();
}

type RefMap = Record<string, SchemaNode>;

/** Resolve a JSON Schema $ref string to a stable TypeScript type name. */
function refToTypeName(ref: string): string {
  // #/$defs/Foo or #/definitions/Foo
  if (ref.startsWith("#/$defs/")) return ref.slice(8);
  if (ref.startsWith("#/definitions/")) return ref.slice(15);
  // https://opencode.ai/schemas/defs.json#/$defs/Foo
  if (ref.match(/https:\/\/.*defs\.json#\/(\$)?defs\//)) {
    const m = ref.split(/#\/(\$)?defs\//);
    return m[m.length - 1] ?? "";
  }
  // https://tribunus.dev/schemas/... with hash part
  if (ref.startsWith("https://") && ref.includes("#")) {
    const hash = ref.split("#").pop() ?? "";
    const stripped = hash.replace(/^(\$)?defs\//, "");
    return toPascalCase(stripped);
  }
  // Plain external ref
  if (ref.startsWith("https://")) {
    return toPascalCase((ref.split("/").pop() ?? "").replace(/\.schema\.json$/, ""));
  }
  return toPascalCase(ref);
}

/** Resolve a schema node to its TypeScript type string. */
function nodeType(node: SchemaNode, knownTypes: Set<string>, defsDefs: RefMap): string {
  if (node.$ref) {
    knownTypes.add(refToTypeName(node.$ref));
    return refToTypeName(node.$ref);
  }
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum && node.enum.length > 0) return node.enum.map((v) => JSON.stringify(v)).join(" | ");

  const composites = node.anyOf ?? node.oneOf ?? [];
  if (composites.length > 0) return composites.map((c) => nodeType(c, knownTypes, defsDefs)).join(" | ");

  if (node.type === "array" && node.items) return `${nodeType(node.items, knownTypes, defsDefs)}[]`;

  if (Array.isArray(node.type)) {
    return node.type
      .map((t) => {
        if (t === "object" && node.properties) return inlineObj(node, knownTypes, defsDefs);
        switch (t) {
          case "string": return "string";
          case "integer": case "number": return "number";
          case "boolean": return "boolean";
          case "null": return "null";
          default: return "unknown";
        }
      })
      .join(" | ");
  }

  if (node.type === "object") {
    if (node.properties) return inlineObj(node, knownTypes, defsDefs);
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      return `Record<string, ${nodeType(node.additionalProperties, knownTypes, defsDefs)}>`;
    }
    return "Record<string, unknown>";
  }

  switch (node.type) {
    case "string": return "string";
    case "integer": case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    default: return "unknown";
  }
}

function inlineObj(node: SchemaNode, knownTypes: Set<string>, defsDefs: RefMap): string {
  const props = node.properties;
  if (!props) return "Record<string, unknown>";
  const req = new Set(node.required ?? []);
  const lines: string[] = ["{"];
  for (const [key, prop] of Object.entries(props)) {
    const opt = req.has(key) ? "" : "?";
    const desc = prop.description ? `  /** ${prop.description} */\n` : "";
    lines.push(`${desc}  "${key}"${opt}: ${nodeType(prop, knownTypes, defsDefs)};`);
  }
  if (node.additionalProperties && typeof node.additionalProperties === "object") {
    lines.push(`  [key: string]: ${nodeType(node.additionalProperties, knownTypes, defsDefs)};`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** Emit a full TypeScript interface or type alias for a schema node. */
function emitInterface(name: string, node: SchemaNode, knownTypes: Set<string>, defsDefs: RefMap): string[] {
  const lines: string[] = [];
  if (node.description) lines.push(`/** ${node.description} */`);

  if (node.type === "object" && node.properties) {
    const req = new Set(node.required ?? []);
    lines.push(`export interface ${name} {`);
    for (const [key, prop] of Object.entries(node.properties)) {
      const opt = req.has(key) ? "" : "?";
      if (prop.description) lines.push(`  /** ${prop.description} */`);
      lines.push(`  "${key}"${opt}: ${nodeType(prop, knownTypes, defsDefs)};`);
    }
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      lines.push(`  [key: string]: ${nodeType(node.additionalProperties, knownTypes, defsDefs)};`);
    }
    lines.push("}");
  } else {
    lines.push(`export type ${name} = ${nodeType(node, knownTypes, defsDefs)};`);
  }
  return lines;
}

/** Generate all types from a schema document (its $defs + root). */
function emitSchemaTypes(doc: SchemaDoc, knownTypes: Set<string>, defsDefs: RefMap): string[] {
  const lines: string[] = [];
  const title = doc.title ?? "";

  const primaryName = title
    ? toPascalCase(title.replace(/[^a-zA-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim())
    : "UnknownSchema";

  // Emit $defs first (hoisted so they are defined before the main type)
  const defs = doc.$defs ?? doc.definitions;
  if (defs) {
    for (const [defName, defNode] of Object.entries(defs)) {
      if (knownTypes.has(defName)) continue;
      // Skip defs that just re-export a defs.json reference — those are emitted once globally
      if (defNode.$ref?.includes("defs.json")) continue;
      knownTypes.add(defName);
      lines.push("", ...emitInterface(defName, defNode, knownTypes, defsDefs));
    }
  }

  // Emit root schema
  if (!knownTypes.has(primaryName) && doc.type && doc.properties) {
    knownTypes.add(primaryName);
    lines.push("", ...emitInterface(primaryName, doc, knownTypes, defsDefs));
  }

  return lines;
}

/** Try to parse a JSON file; return null on failure. */
function tryParseJson(file: string): SchemaDoc | null {
  try {
    const raw = readFileSync(file, "utf-8");
    return JSON.parse(raw) as SchemaDoc;
  } catch (err: unknown) {
    console.warn(`  ⚠  Skipping unparseable JSON: ${file} — ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  // 1. Read shared definitions (defs.json)
  const defsDefs: RefMap = {};
  const defsDoc = tryParseJson(DEFS_PATH);
  if (defsDoc) {
    const shared = defsDoc.$defs ?? defsDoc.definitions ?? {};
    Object.assign(defsDefs, shared);
  }
  const defsKnown: Set<string> = new Set(Object.keys(defsDefs));

  // 2. Find schema files
  const schemaFiles = findSchemaFiles();
  if (schemaFiles.length === 0) {
    console.error("No schema files found!");
    process.exit(1);
  }
  console.log(`Found ${schemaFiles.length} schema files`);

  // 3. Parse schemas
  const schemas: { doc: SchemaDoc; file: string }[] = [];
  for (const file of schemaFiles) {
    if (file.endsWith("defs.json") || file.endsWith("index.json")) continue;
    const doc = tryParseJson(file);
    if (doc) schemas.push({ doc, file });
  }

  // 4. Build output
  const outputLines: string[] = [
    "// AUTO-GENERATED from JSON Schema — DO NOT EDIT",
    "// Generated by: bun run script/schema-types.ts",
    "//",
    `// Generated from ${schemas.length} schema file(s):`,
    ...schemas.map((s) => `//   - ${s.file}`),
    "",
  ];

  // Shared defs first
  for (const [defName, defNode] of Object.entries(defsDefs)) {
    outputLines.push("", ...emitInterface(defName, defNode, defsKnown, defsDefs));
  }

  // Per-schema types
  for (const { doc, file } of schemas) {
    outputLines.push(`\n// --- ${file} ---`);
    outputLines.push(...emitSchemaTypes(doc, defsKnown, defsDefs));
  }

  // 5. Write
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, outputLines.join("\n") + "\n", "utf-8");

  const nonInternal = [...defsKnown].filter((n) => !n.startsWith("_")).length;
  console.log(`Wrote ${OUTPUT_PATH} (${outputLines.length} lines, ${nonInternal} type definitions)`);
}

main();
