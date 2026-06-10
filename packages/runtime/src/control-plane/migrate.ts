/**
 * Control-Plane Migration Tool
 *
 * Migrates control-plane entities from filesystem JSON files to PGlite tables.
 * Idempotent: running twice produces identical PGlite state.
 * Resumable: tracks progress via DataMigrationTable, can resume from last completed entity type.
 *
 * Usage: bun run packages/opencode/src/control-plane/migrate.ts [--dry-run]
 */
import { Effect, Layer, Context } from "effect"
import { DatabaseAdapter } from "@/storage/adapter"
import { DataMigrationTable } from "@/data-migration.pg.sql"
import {
  CampaignTable,
  MissionTable,
  LaneTable,
  TaskTable,
  CheckpointTable,
  ResearchPacketTable,
} from "./entity.pg.sql"
import { eq, sql } from "drizzle-orm"
import * as fs from "node:fs"
import * as path from "node:path"

// ── Types ────────────────────────────────────────────────────────────────────

interface MigrationProgress {
  entity_type: string
  total: number
  migrated: number
  skipped: number
  failed: number
  errors: string[]
  started_at: number
  completed_at?: number
}

interface MigrationReport {
  dry_run: boolean
  entities: MigrationProgress[]
  total_rows_migrated: number
  total_rows_skipped: number
  total_errors: number
  duration_ms: number
}

// ── Entity Readers ───────────────────────────────────────────────────────────

const ENTITY_DIRS: Record<string, string> = {
  campaign: "docs/json/omp/campaigns",
  mission: "docs/json/omp/missions",
  lane: "docs/json/omp/lanes",
  task: "docs/json/omp/tasks",
  checkpoint: "docs/json/omp/checkpoints",
  research_packet: "docs/json/omp/research",
}

function readEntityFiles(entityType: string): Record<string, any>[] {
  const dir = ENTITY_DIRS[entityType]
  if (!dir || !fs.existsSync(dir)) return []

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".v1.json") || f.endsWith(".json"))
    .map((f) => {
      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf-8")
        return JSON.parse(raw)
      } catch (err) {
        return null
      }
    })
    .filter(Boolean) as Record<string, any>[]
}

// ── Migration Functions ──────────────────────────────────────────────────────

function migrateCampaigns(
  adapter: DatabaseAdapter.Interface,
  dryRun: boolean
): Effect.Effect<MigrationProgress, Error> {
  return Effect.gen(function* () {
    const entities = readEntityFiles("campaign")
    const progress: MigrationProgress = {
      entity_type: "campaign",
      total: entities.length,
      migrated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      started_at: Date.now(),
    }

    if (dryRun) {
      progress.migrated = entities.length
      progress.completed_at = Date.now()
      return progress
    }

    for (const entity of entities) {
      try {
        const existing = yield* adapter.query((db) =>
          db
            .select({ id: CampaignTable.id })
            .from(CampaignTable)
            .where(eq(CampaignTable.id, entity.id))
            .execute()
        )

        if (existing.length > 0) {
          progress.skipped++
          continue
        }

        yield* adapter.query((db) =>
          db
            .insert(CampaignTable)
            .values({
              id: entity.id || entity.slug || `campaign-${progress.migrated}`,
              name: entity.name || entity.title || "",
              slug: entity.slug || "",
              description: entity.description || "",
              objective: entity.objective || "",
              status: entity.status || "not_started",
              maturity: entity.maturity || "modeled",
              horizon: entity.horizon || "strategic",
              priority: entity.priority ?? 50,
              start_date: entity.startDate || entity.start_date || null,
              end_date: entity.endDate || entity.end_date || null,
              memory_bank: entity.memoryBank || "tribunus-core",
              follow_on_campaigns: entity.follow_on_campaigns || [],
              tags: entity.tags || [],
              authors: entity.authors || [],
              time_created: entity.created_at
                ? new Date(entity.created_at).getTime()
                : Date.now(),
              time_updated: entity.updated_at
                ? new Date(entity.updated_at).getTime()
                : Date.now(),
            })
            .execute()
        )

        progress.migrated++
      } catch (err: any) {
        progress.failed++
        progress.errors.push(`${entity.id || "unknown"}: ${err.message}`)
      }
    }

    progress.completed_at = Date.now()
    return progress
  })
}

function migrateMissions(
  adapter: DatabaseAdapter.Interface,
  dryRun: boolean
): Effect.Effect<MigrationProgress, Error> {
  return Effect.gen(function* () {
    const entities = readEntityFiles("mission")
    const progress: MigrationProgress = {
      entity_type: "mission",
      total: entities.length,
      migrated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      started_at: Date.now(),
    }

    if (dryRun) {
      progress.migrated = entities.length
      progress.completed_at = Date.now()
      return progress
    }

    for (const entity of entities) {
      try {
        const existing = yield* adapter.query((db) =>
          db
            .select({ id: MissionTable.id })
            .from(MissionTable)
            .where(eq(MissionTable.id, entity.id))
            .execute()
        )

        if (existing.length > 0) {
          progress.skipped++
          continue
        }

        yield* adapter.query((db) =>
          db
            .insert(MissionTable)
            .values({
              id: entity.id || entity.slug || `mission-${progress.migrated}`,
              campaign_id: entity.campaignId || "",
              name: entity.name || entity.title || "",
              slug: entity.slug || "",
              description: entity.description || "",
              purpose: entity.purpose || "",
              status: entity.status || "not_started",
              maturity: entity.maturity || "modeled",
              horizon: entity.horizon || "planned",
              priority: entity.priority ?? 50,
              depends_on: entity.depends_on || [],
              unlocks: entity.unlocks || [],
              authority_scope: entity.authority_scope || "",
              allowed_paths: entity.allowed_paths || [],
              required_evidence: entity.required_evidence || [],
              acceptance_gates: entity.acceptance_gates || [],
              acceptance_criteria: entity.acceptanceCriteria || [],
              rollback_strategy: entity.rollback_strategy || "",
              recovery_strategy: entity.recovery_strategy || "",
              automation_mode: entity.automation_mode || "manual",
              maximum_attempts: entity.maximum_attempts ?? 3,
              escalation_policy: entity.escalation_policy || "",
              maturity_target: entity.maturity_target || "bootstrap_complete",
              tags: entity.tags || [],
              authors: entity.authors || [],
              time_created: entity.created_at
                ? new Date(entity.created_at).getTime()
                : Date.now(),
              time_updated: entity.updated_at
                ? new Date(entity.updated_at).getTime()
                : Date.now(),
            })
            .execute()
        )

        progress.migrated++
      } catch (err: any) {
        progress.failed++
        progress.errors.push(`${entity.id || "unknown"}: ${err.message}`)
      }
    }

    progress.completed_at = Date.now()
    return progress
  })
}

// ── Migration Orchestrator ───────────────────────────────────────────────────

export function migrateAll(
  adapter: DatabaseAdapter.Interface,
  dryRun = false
): Effect.Effect<MigrationReport, Error> {
  return Effect.gen(function* () {
    const startedAt = Date.now()

    // Check which migrations are already complete (idempotency)
    const completedMigrations = yield* adapter.query((db) =>
      db.select({ name: DataMigrationTable.name }).from(DataMigrationTable).execute()
    )
    const completed = new Set(completedMigrations.map((r) => r.name))

    const progress: MigrationProgress[] = []

    // Migrate in dependency order
    if (!completed.has("campaign")) {
      const p = yield* migrateCampaigns(adapter, dryRun)
      progress.push(p)
      if (!dryRun) {
        yield* adapter.query((db) =>
          db
            .insert(DataMigrationTable)
            .values({ name: "campaign", time_completed: Date.now() })
            .execute()
        )
      }
    }

    if (!completed.has("mission")) {
      const p = yield* migrateMissions(adapter, dryRun)
      progress.push(p)
      if (!dryRun) {
        yield* adapter.query((db) =>
          db
            .insert(DataMigrationTable)
            .values({ name: "mission", time_completed: Date.now() })
            .execute()
        )
      }
    }

    // Summary
    const report: MigrationReport = {
      dry_run: dryRun,
      entities: progress,
      total_rows_migrated: progress.reduce((sum, p) => sum + p.migrated, 0),
      total_rows_skipped: progress.reduce((sum, p) => sum + p.skipped, 0),
      total_errors: progress.reduce((sum, p) => sum + p.failed, 0),
      duration_ms: Date.now() - startedAt,
    }

    return report
  })
}

// ── CLI Entry Point ──────────────────────────────────────────────────────────

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run")

  console.log(
    dryRun
      ? "DRY RUN — no data will be written"
      : "LIVE MIGRATION — data will be written to PGlite"
  )
  console.log("")

  // TODO: Wire DatabaseAdapter layer and run migration
  console.log("Migration tool scaffolded. Wire DatabaseAdapter to run.")
  console.log("Entity directories configured:")
  for (const [type, dir] of Object.entries(ENTITY_DIRS)) {
    const exists = fs.existsSync(dir)
    const count = exists
      ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length
      : 0
    console.log(`  ${type}: ${dir} (${count} files) ${exists ? "" : "[MISSING]"}`)
  }
}
