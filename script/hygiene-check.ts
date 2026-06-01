#!/usr/bin/env bun
/**
 * Hygiene Check — validates that the repository is clean of operational exhaust.
 *
 * Checks that no tracked files exist under forbidden paths (matching the
 * patterns added to .gitignore by artifact-migration.ts).
 *
 * Usage: bun run script/hygiene-check.ts [--strict]
 *   --strict: exit with non-zero code if violations found
 *
 * Exit codes:
 *   0 — clean, no violations
 *   1 — violations found
 *   2 — unrelated error
 */

import { $ } from "bun"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..")
process.chdir(REPO_ROOT)

const args = Bun.argv.slice(2)
const strict = args.includes("--strict")

// Forbidden path patterns — these must match .gitignore
const FORBIDDEN_PATTERNS: { pattern: string; description: string }[] = [
  { pattern: ".build/", description: "Build artifacts and rig relay" },
  { pattern: "docs/json/", description: "Operational JSON archives" },
  { pattern: ".rig/", description: "Rig lessons (runtime state)" },
  { pattern: "docs/findings/", description: "Out-of-scope findings log" },
]

const FORBIDDEN_GLOBS: { glob: string; description: string }[] = [
  { glob: "opencode-debug-*.zip", description: "Debug export zips" },
  { glob: "pi-session-*.html", description: "Session HTML exports" },
  { glob: "tool_usage_guidelines-*.md", description: "Generated tool usage guides" },
  { glob: "context.md", description: "Generated code context analysis" },
  { glob: "TOOL_GUIDE.md", description: "Generated tool guide index" },
  { glob: "profile-*.md", description: "Superseded/empty profile stubs" },
  { glob: "tsconfig.tsbuildinfo", description: "TypeScript build info" },
  { glob: "extract_i18n_keys_temp.*", description: "Temporary extraction scripts" },
  { glob: "run_7_cmds.sh", description: "Temporary run scripts" },
  { glob: ".opencode/state/**", description: "OpenCode runtime state" },
  { glob: ".opencode/docs/**", description: "OpenCode generated docs" },
  { glob: ".opencode/plan_content.txt", description: "OpenCode runtime plan cache" },
]

interface Violation {
  path: string
  description: string
}

async function main() {
  console.log("═".repeat(64))
  console.log("  Hygiene Check")
  console.log("═".repeat(64))
  console.log()

  const violations: Violation[] = []

  // Check directory patterns (git ls-files under those dirs)
  for (const { pattern, description } of FORBIDDEN_PATTERNS) {
    try {
      const { stdout } = await $`git ls-files ${pattern}`.quiet()
      const files = stdout.toString().trim().split("\n").filter(Boolean)
      for (const f of files) {
        violations.push({ path: f, description })
      }
    } catch {
      // No files under this pattern — good
    }
  }

  // Check glob patterns (git ls-files with glob)
  for (const { glob, description } of FORBIDDEN_GLOBS) {
    try {
      const { stdout } = await $`git ls-files ${glob}`.quiet()
      const files = stdout.toString().trim().split("\n").filter(Boolean)
      for (const f of files) {
        violations.push({ path: f, description })
      }
    } catch {
      // No files matching — good
    }
  }

  // Also check for untracked files that shouldn't exist (noise check)
  const noisePatterns = [
    { glob: ".opencode/state.db*", description: "OpenCode runtime database (should be gitignored)" },
    { glob: ".opencode/node_modules/", description: "OpenCode node_modules (should be gitignored)" },
  ]

  console.log("  Checking forbidden paths...")
  console.log()

  if (violations.length === 0) {
    console.log("  ✓ No violations found. Repo is clean.")
    console.log()
    console.log("  Checked patterns:")
    for (const p of FORBIDDEN_PATTERNS) console.log(`    ${p.pattern}  (${p.description})`)
    for (const g of FORBIDDEN_GLOBS) console.log(`    ${g.glob}  (${g.description})`)
    console.log()
    console.log("═".repeat(64))
    process.exit(0)
  }

  // Group violations by description
  const byDesc = new Map<string, string[]>()
  for (const v of violations) {
    const paths = byDesc.get(v.description) ?? []
    paths.push(v.path)
    byDesc.set(v.description, paths)
  }

  console.log(`  ✗ ${violations.length} violation(s) found:`)
  console.log()
  for (const [desc, paths] of byDesc) {
    console.log(`  ${desc}:`)
    for (const p of paths.slice(0, 10)) console.log(`    ${p}`)
    if (paths.length > 10) console.log(`    ... and ${paths.length - 10} more`)
    console.log()
  }

  console.log("  Fix:")
  console.log("    Run: bun run script/artifact-migration.ts")
  console.log("    This will classify, ingest, and remove exhaust files from Git.")
  console.log()

  console.log("═".repeat(64))
  process.exit(strict ? 1 : 0)
}

main().catch((err) => {
  console.error("FATAL:", err)
  process.exit(2)
})
