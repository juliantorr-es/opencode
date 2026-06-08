// === OMP Path Policy v1 ===
// Security-critical path resolution: validates reads and writes against repo boundary
// and allowed/denied pattern lists. No Tribunus imports.
// Only dependency: node:path

import { resolve, isAbsolute } from "node:path"
import type { OmpToolContextV1, PathPolicyDecisionV1 } from "./types"

// ── Normalization ──

/** Normalize separators to forward slashes, collapse trailing slashes */
function norm(p: string): string {
  if (!p) return ""
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "")
  return n || "/"
}

// ── Segment matcher helpers ──

type SegMatcher = (segments: string[]) => boolean

const segExact = (name: string): SegMatcher =>
  (segs) => segs.some((s) => s === name)

const segEnds = (suffix: string): SegMatcher =>
  (segs) => segs.some((s) => s.endsWith(suffix))

const segStarts = (prefix: string): SegMatcher =>
  (segs) => segs.some((s) => s.startsWith(prefix))

/** Check if path segments contain a specific consecutive sequence */
function containsSeq(segs: string[], ...target: string[]): boolean {
  for (let i = 0; i <= segs.length - target.length; i++) {
    let match = true
    for (let j = 0; j < target.length; j++) {
      if (segs[i + j] !== target[j]) { match = false; break }
    }
    if (match) return true
  }
  return false
}

const segSeq = (...seq: string[]): SegMatcher =>
  (segs) => containsSeq(segs, ...seq)

// ── Pattern definitions ──

interface Pattern {
  name: string
  match: SegMatcher
}

const WRITE_DENIED: Pattern[] = [
  // Directory ancestry
  { name: ".git/",         match: segExact(".git") },
  { name: "node_modules/", match: segExact("node_modules") },
  { name: "dist/",         match: segExact("dist") },
  { name: "build/",        match: segExact("build") },
  { name: "coverage/",     match: segExact("coverage") },
  // Exact filenames
  { name: ".DS_Store",     match: segExact(".DS_Store") },
  { name: ".env",          match: segExact(".env") },
  // Glob-like patterns
  { name: ".env.*",        match: segStarts(".env.") },
  { name: "*.pem",         match: segEnds(".pem") },
  { name: "*.key",         match: segEnds(".key") },
  { name: "*.p12",         match: segEnds(".p12") },
  { name: "*.pfx",         match: segEnds(".pfx") },
  { name: "*.crt",         match: segEnds(".crt") },
  { name: "*.sqlite",      match: segEnds(".sqlite") },
  { name: "*.db",          match: segEnds(".db") },
  { name: "*.wal",         match: segEnds(".wal") },
  { name: "*.log",         match: segEnds(".log") },
  // OMP artifact directories — only writable through dedicated helpers
  { name: ".omp/evidence/receipts/", match: segSeq(".omp", "evidence", "receipts") },
  { name: ".omp/evidence/diffs/",    match: segSeq(".omp", "evidence", "diffs") },
  { name: ".omp/evidence/events/",   match: segSeq(".omp", "evidence", "events") },
  { name: ".omp/evidence/journals/", match: segSeq(".omp", "evidence", "journals") },
]

const READ_DENIED: Pattern[] = [
  { name: ".env",    match: segExact(".env") },
  { name: ".env.*",  match: segStarts(".env.") },
  { name: "*.pem",   match: segEnds(".pem") },
  { name: "*.key",   match: segEnds(".key") },
]

// ── Core resolver ──

function resolvePathPolicy(
  inputPath: string,
  ctx: OmpToolContextV1,
  patterns: Pattern[],
): PathPolicyDecisionV1 {
  // 1. Reject absolute paths
  if (isAbsolute(inputPath)) {
    return { ok: false, reason: "absolute path denied", denied_pattern: "<absolute>" }
  }

  // 2. Resolve against repo_root
  const absRaw = resolve(ctx.repo_root, inputPath)
  const abs = norm(absRaw)
  const root = norm(ctx.repo_root)

  // 3. Verify path doesn't escape repo_root via parent traversal
  if (!abs.startsWith(root)) {
    return { ok: false, reason: "path resolves outside repo root", denied_pattern: "<escape>" }
  }

  // 4. Compute repo-relative path
  let rel = abs.slice(root.length).replace(/^\//, "")

  // 5. Check patterns against path segments
  const segs = rel ? rel.split("/") : []
  for (const p of patterns) {
    if (p.match(segs)) {
      return { ok: false, reason: `denied by pattern: ${p.name}`, denied_pattern: p.name }
    }
  }

  // 6. Success
  return {
    ok: true,
    normalized_path: rel,
    absolute_path: abs,
  }
}

// ── Public API ──

export function resolveReadPath(inputPath: string, ctx: OmpToolContextV1): PathPolicyDecisionV1 {
  return resolvePathPolicy(inputPath, ctx, READ_DENIED)
}

export function resolveWritePath(inputPath: string, ctx: OmpToolContextV1): PathPolicyDecisionV1 {
  return resolvePathPolicy(inputPath, ctx, WRITE_DENIED)
}
