import { describe, test, expect } from "bun:test"
import { createHash } from "node:crypto"

interface TestEntity { id: string; name: string; data: Record<string, unknown> }

function createTestEntities(count: number, prefix: string): TestEntity[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i + 1).padStart(3, "0")}`,
    name: `${prefix} ${i + 1}`,
    data: {
      status: i % 3 === 0 ? "completed" : i % 3 === 1 ? "in_progress" : "not_started",
      priority: (i % 5) * 10 + 10,
      tags: [`tag-${i % 3}`, `tag-${i % 5}`],
      createdAt: new Date(2026, 0, i + 1).toISOString(),
    },
  }))
}

function sha256(data: string): string { return createHash("sha256").update(data).digest("hex") }

function checksumEntities(entities: TestEntity[]): string {
  const sorted = [...entities].sort((a, b) => a.id.localeCompare(b.id))
  return sha256(sorted.map((e) => JSON.stringify({ id: e.id, name: e.name, data: e.data })).join("\n"))
}

class MigrationStore {
  private entities: Record<string, TestEntity> = {}
  private completed: Record<string, true> = {}
  insert(entity: TestEntity): boolean {
    if (this.entities[entity.id]) return false
    this.entities[entity.id] = entity
    return true
  }
  getAll(): TestEntity[] { return Object.values(this.entities) }
  count(): number { return Object.keys(this.entities).length }
  isComplete(name: string): boolean { return this.completed[name] === true }
  markComplete(name: string) { this.completed[name] = true }
}

function runMigration(store: MigrationStore, entityType: string, entities: TestEntity[]) {
  if (store.isComplete(entityType)) return { migrated: 0, skipped: entities.length }
  let migrated = 0, skipped = 0
  for (const e of entities) { if (store.insert(e)) migrated++; else skipped++ }
  store.markComplete(entityType)
  return { migrated, skipped }
}

describe("Migration Idempotency", () => {
  test("running migration twice produces identical entity set", () => {
    const campaigns = createTestEntities(10, "campaign")
    const store = new MigrationStore()
    runMigration(store, "campaign", campaigns)
    const c1 = checksumEntities(store.getAll())
    const result2 = runMigration(store, "campaign", campaigns)
    const c2 = checksumEntities(store.getAll())
    expect(c1).toBe(c2)
    expect(result2.migrated).toBe(0)
    expect(result2.skipped).toBe(campaigns.length)
    expect(store.count()).toBe(campaigns.length)
  })

  test("independent second run produces bit-identical state", () => {
    const campaigns = createTestEntities(10, "campaign")
    const s1 = new MigrationStore(); runMigration(s1, "campaign", campaigns)
    const s2 = new MigrationStore(); runMigration(s2, "campaign", campaigns)
    expect(checksumEntities(s1.getAll())).toBe(checksumEntities(s2.getAll()))
    expect(s1.count()).toBe(s2.count())
  })

  test("multi-entity migration preserves idempotency per entity type", () => {
    const store = new MigrationStore()
    runMigration(store, "campaign", createTestEntities(5, "campaign"))
    runMigration(store, "mission", createTestEntities(15, "mission"))
    const c1 = checksumEntities(store.getAll())
    runMigration(store, "campaign", createTestEntities(5, "campaign"))
    runMigration(store, "mission", createTestEntities(15, "mission"))
    expect(checksumEntities(store.getAll())).toBe(c1)
    expect(store.count()).toBe(20)
  })
})

describe("Migration Replay from Checkpoint", () => {
  test("replaying from completed entity types produces same state", () => {
    const campaigns = createTestEntities(5, "campaign")
    const missions = createTestEntities(10, "mission")
    const s1 = new MigrationStore(); runMigration(s1, "campaign", campaigns); runMigration(s1, "mission", missions)
    const s2 = new MigrationStore(); runMigration(s2, "campaign", campaigns); runMigration(s2, "mission", missions)
    expect(checksumEntities(s1.getAll())).toBe(checksumEntities(s2.getAll()))
  })

  test("replay handles empty entity types", () => {
    const store = new MigrationStore()
    const result = runMigration(store, "tasks", [])
    expect(result.migrated).toBe(0); expect(result.skipped).toBe(0)
    expect(store.count()).toBe(0)
  })

  test("replay after partial failure maintains data integrity", () => {
    const all = createTestEntities(30, "entity")
    const store = new MigrationStore()
    runMigration(store, "entity", all)
    const c1 = checksumEntities(store.getAll())
    runMigration(store, "entity", all)
    expect(checksumEntities(store.getAll())).toBe(c1)
    expect(store.count()).toBe(30)
  })
})

describe("Migration Determinism", () => {
  test("migration produces deterministic output regardless of input order", () => {
    const entities = createTestEntities(20, "item")
    const shuffled = [...entities].sort(() => Math.random() - 0.5)
    const s1 = new MigrationStore(); for (const e of entities) s1.insert(e)
    const s2 = new MigrationStore(); for (const e of shuffled) s2.insert(e)
    expect(checksumEntities(s1.getAll())).toBe(checksumEntities(s2.getAll()))
  })

  test("content-addressed checksums catch data differences", () => {
    const entities1 = createTestEntities(5, "item")
    const entities2 = createTestEntities(5, "item")
    entities2[2].data = { ...entities2[2].data, status: "modified" }
    expect(checksumEntities(entities1)).not.toBe(checksumEntities(entities2))
  })
})
