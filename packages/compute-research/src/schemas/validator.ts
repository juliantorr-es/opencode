import { readFileSync } from "fs";

/** Validate provenance.json shape against the v1 schema contract. */
export function validateProvenanceShape(data: unknown): string[] {
  const errors: string[] = [];
  if (!data || typeof data !== "object") {
    errors.push("provenance must be a JSON object");
    return errors;
  }
  const p = data as Record<string, unknown>;
  // Required top-level sections
  for (const section of ["source", "toolchain", "model", "machine", "environment"]) {
    if (!p[section] || typeof p[section] !== "object") {
      errors.push(`provenance missing required section: ${section}`);
    }
  }
  // source must have commit_sha and dirty
  const src = p.source as Record<string, unknown> | undefined;
  if (src) {
    if (!src.commit_sha || typeof src.commit_sha !== "string") errors.push("source.commit_sha required (string)");
    if (typeof src.dirty !== "boolean") errors.push("source.dirty required (boolean)");
    if (!src.dependencies || typeof src.dependencies !== "object") errors.push("source.dependencies required (object)");
  }
  // model must have image_hash
  const mdl = p.model as Record<string, unknown> | undefined;
  if (mdl) {
    if (!mdl.image_hash || typeof mdl.image_hash !== "string") errors.push("model.image_hash required (string)");
  }
  // machine must have anon_id
  const mch = p.machine as Record<string, unknown> | undefined;
  if (mch) {
    if (!mch.anon_id || typeof mch.anon_id !== "string") errors.push("machine.anon_id required (string)");
  }
  return errors;
}

/** Validate run-manifest.json shape against the v1 schema contract. */
export function validateRunManifestShape(data: unknown): string[] {
  const errors: string[] = [];
  if (!data || typeof data !== "object") {
    errors.push("run-manifest must be a JSON object");
    return errors;
  }
  const m = data as Record<string, unknown>;
  // Required top-level fields
  if (!m.run_id || typeof m.run_id !== "string") errors.push("run_id required (string)");
  if (!m.run_grade || typeof m.run_grade !== "string") errors.push("run_grade required (string)");
  if (!m.status || typeof m.status !== "string") errors.push("status required (string)");
  // Validate run_grade against canonical enum
  const validGrades = ["exploratory", "controlled", "claim_candidate", "archival", "legacy_provisional"];
  if (typeof m.run_grade === "string" && !validGrades.includes(m.run_grade as string)) {
    errors.push(`run_grade "${m.run_grade}" is not a valid grade. Must be one of: ${validGrades.join(", ")}`);
  }
  // model_identity required
  if (!m.model_identity || typeof m.model_identity !== "object") errors.push("model_identity required (object)");
  else {
    const mi = m.model_identity as Record<string, unknown>;
    if (!mi.image_hash || typeof mi.image_hash !== "string") errors.push("model_identity.image_hash required (string)");
  }
  // machine_profile required
  if (!m.machine_profile || typeof m.machine_profile !== "object") errors.push("machine_profile required (object)");
  return errors;
}

export { validateProvenanceShape as validateProvenanceRecord };
