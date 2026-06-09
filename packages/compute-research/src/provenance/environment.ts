import { realpathSync } from "fs";
import { homedir } from "os";
import { resolve, sep } from "path";

// ── Constants ────────────────────────────────────────────────────────────────

/** Compute-related environment variable name fragments to separate out. */
const COMPUTE_KEYWORDS = [
  "TRIBUNUS", "MLX", "METAL", "COREML", "ANE", "MPS", "OMP",
  "RUST", "CARGO", "DYLD", "MALLOC", "OPENBLAS", "ACCELERATE",
  "PYTHON", "CUDA", "ROCM",
] as const;

/** Regex that looks like an API key, token, or secret. */
const SECRET_PATTERN = /(?:api[_-]?key|token|secret|password|passwd|private[_-]?key)/i;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EnvironmentProvenance {
  /** All captured environment variables (values redacted of secrets). */
  variables: Record<string, string>;
  /** Subset of env vars matching known compute-related keywords. */
  compute_variables: Record<string, string>;
  /** Working directory at capture time. */
  cwd: string;
  /** Repository root (normalized via realpath). */
  repo_path: string;
  /** Path to model storage. */
  model_path: string;
  /** Output directory for run artifacts. */
  output_path: string;
  /** Whether any variable value looked like a secret. */
  secrets_detected: boolean;
  /** Original paths that were redacted. */
  redacted_paths: string[];
  /** Metadata about what was redacted and why. */
  redaction_metadata: Record<string, string>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const HOME = homedir();

/**
 * Replace the real home directory in `value` with `$HOME`.
 * Returns the redacted string and whether any replacement was made.
 */
function redactHome(value: string): { value: string; redacted: boolean } {
  if (!HOME || value.length === 0) return { value, redacted: false };
  const escaped = HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|${sep})${escaped}(${sep}|$)`, "g");
  const replaced = value.replace(re, (m) => m.replace(HOME, "$HOME"));
  return { value: replaced, redacted: replaced !== value };
}

/** Heuristic check — does the key or value look like a secret? */
function looksLikeSecret(key: string, value: string): boolean {
  if (SECRET_PATTERN.test(key)) return true;
  // Values >= 20 chars mixing letters, digits, and non-alphanumerics
  if (value.length >= 20 && /[a-zA-Z]/.test(value) && /\d/.test(value) && /[^a-zA-Z0-9]/.test(value)) {
    return true;
  }
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Capture a snapshot of all environment variables for provenance recording.
 *
 * - Separates compute-related variables into their own field.
 * - Redacts home-directory paths by replacing with `$HOME`.
 * - Flags values that look like secrets and replaces them with `[REDACTED]`.
 */
export function captureEnvironmentProvenance(): EnvironmentProvenance {
  const variables: Record<string, string> = {};
  const computeVariables: Record<string, string> = {};
  const redactedPaths: string[] = [];
  const redactionMeta: Record<string, string> = {};
  let secretsDetected = false;

  const env = process.env as Record<string, string | undefined>;

  for (const [key, rawVal] of Object.entries(env)) {
    if (rawVal === undefined) continue;
    let val = rawVal;

    // Home-directory redaction (record original before mutation)
    const { value: homeRedacted, redacted: wasRedacted } = redactHome(val);
    if (wasRedacted) {
      redactedPaths.push(val);
      redactionMeta[key] = `home directory redacted in value (original length ${val.length})`;
      val = homeRedacted;
    }

    // Secret detection
    if (looksLikeSecret(key, rawVal)) {
      secretsDetected = true;
      val = "[REDACTED]";
      redactionMeta[`${key}_secret`] = "value replaced with [REDACTED]";
    }

    variables[key] = val;

    // Classify compute-related
    const upperKey = key.toUpperCase();
    for (const kw of COMPUTE_KEYWORDS) {
      if (upperKey.includes(kw)) {
        computeVariables[key] = val;
        break;
      }
    }
  }

  // Resolve paths
  const cwd = resolve(process.cwd());
  let repoPath: string;
  try {
    repoPath = realpathSync(cwd);
  } catch {
    repoPath = cwd;
  }

  const modelPath =
    variables.MODEL_PATH ?? variables.TRIBUNUS_MODEL_PATH ?? variables.MLX_MODEL_PATH ?? resolve(cwd, "models");
  const outputPath =
    variables.OUTPUT_PATH ?? variables.TRIBUNUS_OUTPUT_PATH ?? resolve(cwd, "output");

  return {
    variables,
    compute_variables: computeVariables,
    cwd,
    repo_path: repoPath,
    model_path: modelPath,
    output_path: outputPath,
    secrets_detected: secretsDetected,
    redacted_paths: redactedPaths,
    redaction_metadata: redactionMeta,
  };
}
