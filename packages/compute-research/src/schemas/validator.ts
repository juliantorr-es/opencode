import { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Schema cache ────────────────────────────────────────────────────────────
let _ajv: Ajv2020 | null = null;
let _validateProvenance: ReturnType<Ajv2020["compile"]> | null = null;
let _validateRunManifest: ReturnType<Ajv2020["compile"]> | null = null;

function getAjv(): Ajv2020 {
  if (!_ajv) {
    _ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(_ajv);
  }
  return _ajv;
}

function loadSchema(path: string): ValidateFunction {
  const absPath = resolve(path);
  const schemaJson = JSON.parse(readFileSync(absPath, "utf-8"));
  // Ajv can't resolve $schema meta-refs at runtime and caches by $id.
  // Strip both so the same schema can be compiled more than once if needed.
  delete schemaJson.$schema;
  delete schemaJson.$id;
  return getAjv().compile(schemaJson);
}

/** Validate an object against research/schemas/provenance.v1.json. */
export function validateProvenanceShape(data: unknown): string[] {
  if (!_validateProvenance) {
    _validateProvenance = loadSchema(
      resolve(import.meta.dir, "../../../../research/schemas/provenance.v1.json")
    );
  }
  const v = _validateProvenance!;
  const valid = v(data);
  if (valid) return [];
  return (v.errors ?? []).map(
    (e) => `${e.instancePath || "/"}: ${e.message}`
  );
}

/** Validate an object against research/schemas/run-manifest.v1.json. */
export function validateRunManifestShape(data: unknown): string[] {
  if (!_validateRunManifest) {
    _validateRunManifest = loadSchema(
      resolve(import.meta.dir, "../../../../research/schemas/run-manifest.v1.json")
    );
  }
  const v = _validateRunManifest!;
  const valid = v(data);
  if (valid) return [];
  return (v.errors ?? []).map(
    (e) => `${e.instancePath || "/"}: ${e.message}`
  );
}

export { validateProvenanceShape as validateProvenanceRecord };
