#!/usr/bin/env bun
/**
 * Review Compression System (IN-002) — Bisect Verification Script
 *
 * Usage: cd packages/opencode && bun run scripts/review-compression-bisect.ts
 *
 * Validates each deliverable checkpoint in order. Exits code 1 on first failure.
 * Each step prints PASS/FAIL with details.
 *
 * Checkpoints:
 *   1. Schema files exist and are valid JSON
 *   2. Schema files have required metadata fields
 *   3. No Python syntax contamination
 *   4. Weight rubric test suite passes
 *   5. Comparison engine test suite passes
 *   6. Schema validation test suite passes
 *   7. Integration test suite passes
 *   8. Existing snapshot regression tests still pass
 */

import { $ } from "bun"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const SCHEMAS = [
  path.join(ROOT, "..", "docs/schemas/rig.relay.review_manifest.v1.schema.json"),
  path.join(ROOT, "..", "docs/schemas/rig.relay.builder_publication_record.v1.schema.json"),
  path.join(ROOT, "..", "docs/schemas/rig.relay.verification_record.v1.schema.json"),
  path.join(ROOT, "..", "docs/schemas/rig.relay.prepublication_review_cycle.v1.schema.json"),
]

const PYTHON_PATTERNS = ["from __future__", "import ", "def ", "class ", "# ruff:", "# noqa"]

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  PASS: ${label}`)
    passed++
  } catch (e) {
    console.log(`  FAIL: ${label}`)
    console.log(`        ${(e as Error).message}`)
    failed++
  }
}

// ---------- Step 1: Schema files exist and are valid JSON ----------
console.log("\n=== Step 1: Schema files exist and are valid JSON ===\n")

for (const f of SCHEMAS) {
  await check(`File exists: ${path.basename(f)}`, async () => {
    const exists = await Bun.file(f).exists()
    if (!exists) throw new Error(`File not found: ${f}`)
  })
  await check(`Valid JSON: ${path.basename(f)}`, async () => {
    const content = await Bun.file(f).text()
    JSON.parse(content)
  })
}

// ---------- Step 2: Schema files have required metadata ----------
console.log("\n=== Step 2: Schema files have required metadata fields ===\n")

const SCHEMA_DRAFT_RE = /^https:\/\/json-schema\.org\/draft\/2020-12\/schema$/

for (const f of SCHEMAS) {
  const name = path.basename(f)
  const content = JSON.parse(await Bun.file(f).text())

  await check(`${name}.$schema is present`, async () => {
    if (!content.$schema) throw new Error("Missing $schema")
  })
  await check(`${name}.$schema is draft-2020-12`, async () => {
    if (!SCHEMA_DRAFT_RE.test(content.$schema)) {
      throw new Error(`Expected draft-2020-12, got: ${content.$schema}`)
    }
  })
  await check(`${name}.$id is present`, async () => {
    if (!content.$id) throw new Error("Missing $id")
  })
  await check(`${name}.title is present`, async () => {
    if (!content.title) throw new Error("Missing title")
  })
  await check(`${name}.type is "object"`, async () => {
    if (content.type !== "object") throw new Error(`type must be 'object', got: ${content.type}`)
  })
  await check(`${name}.properties is present`, async () => {
    if (!content.properties || typeof content.properties !== "object") throw new Error("Missing or invalid properties")
  })
  await check(`${name}.required is non-empty array`, async () => {
    if (!Array.isArray(content.required)) throw new Error("required must be an array")
    if (content.required.length === 0) throw new Error("required must not be empty")
  })
}

// ---------- Step 3: No Python syntax contamination ----------
console.log("\n=== Step 3: No Python syntax contamination ===\n")

for (const f of SCHEMAS) {
  const name = path.basename(f)
  const content = await Bun.file(f).text()
  for (const pat of PYTHON_PATTERNS) {
    await check(`${name} - no '${pat}'`, async () => {
      if (content.includes(pat)) {
        throw new Error(`File contains Python syntax pattern: '${pat}'`)
      }
    })
  }
}

// ---------- Step 4: Weight rubric test suite ----------
console.log("\n=== Step 4: Weight rubric test suite ===\n")

await check("bun test weight-rubric.test.ts", async () => {
  const result = await $`bun test test/review-compression/weight-rubric.test.ts`
    .cwd(ROOT)
    .nothrow()
    .quiet()
  if (result.exitCode !== 0) {
    const stderr = await new Response(result.stderr).text()
    throw new Error(`Weight rubric tests failed (exit ${result.exitCode}):\n${stderr.slice(0, 500)}`)
  }
})

// ---------- Step 5: Comparison engine test suite ----------
console.log("\n=== Step 5: Comparison engine test suite ===\n")

await check("bun test comparison-engine.test.ts", async () => {
  const result = await $`bun test test/review-compression/comparison-engine.test.ts`
    .cwd(ROOT)
    .nothrow()
    .quiet()
  if (result.exitCode !== 0) {
    const stderr = await new Response(result.stderr).text()
    throw new Error(`Comparison engine tests failed (exit ${result.exitCode}):\n${stderr.slice(0, 500)}`)
  }
})

// ---------- Step 6: Schema validation test suite ----------
console.log("\n=== Step 6: Schema validation test suite ===\n")

await check("bun test schema-validate.test.ts", async () => {
  const result = await $`bun test test/review-compression/schema-validate.test.ts`
    .cwd(ROOT)
    .nothrow()
    .quiet()
  if (result.exitCode !== 0) {
    const stderr = await new Response(result.stderr).text()
    throw new Error(`Schema validation tests failed (exit ${result.exitCode}):\n${stderr.slice(0, 500)}`)
  }
})

// ---------- Step 7: Integration test suite ----------
console.log("\n=== Step 7: Integration test suite ===\n")

await check("bun test manifest-integration.test.ts", async () => {
  const result = await $`bun test test/review-compression/manifest-integration.test.ts`
    .cwd(ROOT)
    .nothrow()
    .quiet()
  if (result.exitCode !== 0) {
    const stderr = await new Response(result.stderr).text()
    throw new Error(`Integration tests failed (exit ${result.exitCode}):\n${stderr.slice(0, 500)}`)
  }
})

// ---------- Step 8: Existing snapshot regression ----------
console.log("\n=== Step 8: Existing snapshot regression tests ===\n")

await check("bun test snapshot/snapshot.test.ts", async () => {
  const result = await $`bun test test/snapshot/snapshot.test.ts`
    .cwd(ROOT)
    .nothrow()
    .quiet()
  if (result.exitCode !== 0) {
    const stderr = await new Response(result.stderr).text()
    throw new Error(`Snapshot tests regressed (exit ${result.exitCode}):\n${stderr.slice(0, 500)}`)
  }
})

// ---------- Summary ----------
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`)
process.exit(failed > 0 ? 1 : 0)
