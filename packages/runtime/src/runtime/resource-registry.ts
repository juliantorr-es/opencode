/**
 * Resource Ownership and Deterministic Teardown
 *
 * Every resource (db connection, file handle, network socket, child process)
 * has an owner. Teardown follows reverse acquisition order (stack semantics).
 * Force-teardown after timeout never hangs the shutdown sequence.
 */
import { Effect } from "effect"

// ── Types ────────────────────────────────────────────────────────────────────

interface ResourceIDBrand { readonly ResourceID: unique symbol }
type ResourceID = string & ResourceIDBrand

interface ResourceRecord {
  id: ResourceID
  type: string
  owner: string
  scope: string
  acquiredAt: number
  metadata: Record<string, unknown>
  teardown: () => Effect.Effect<void, Error>
}

// ── Resource Registry ────────────────────────────────────────────────────────

const registry = new Map<ResourceID, ResourceRecord>()
const acquisitionOrder: ResourceID[] = []

function register(
  type: string,
  owner: string,
  scope: string,
  teardown: () => Effect.Effect<void, Error>,
  metadata?: Record<string, unknown>
): Effect.Effect<ResourceID, Error> {
  return Effect.gen(function* () {
    const id = `res-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` as ResourceID
    const record: ResourceRecord = {
      id, type, owner, scope,
      acquiredAt: Date.now(),
      metadata: metadata ?? {},
      teardown,
    }
    registry.set(id, record)
    acquisitionOrder.push(id)
    return id
  })
}

/**
 * Teardown all resources in reverse acquisition order.
 * Force-teardown after configurable timeout — never hangs shutdown.
 */
function teardownAll(timeoutMs: number = 10_000): Effect.Effect<{ tornDown: number; timeouts: number }, Error> {
  return Effect.gen(function* () {
    let tornDown = 0
    let timeouts = 0

    // Reverse order (stack semantics)
    const order = [...acquisitionOrder].reverse()

    for (const id of order) {
      const record = registry.get(id)
      if (!record) continue

      const result = yield* record.teardown().pipe(
        Effect.timeout(timeoutMs),
        Effect.match({
          onSuccess: () => ({ timedOut: false }),
          onFailure: () => ({ timedOut: true }),
        })
      )

      if (result.timedOut) {
        timeouts++
      } else {
        tornDown++
      }
      registry.delete(id)
    }

    acquisitionOrder.length = 0
    return { tornDown, timeouts }
  })
}

/**
 * Teardown resources in a specific scope without affecting other scopes.
 */
function teardownScope(scope: string, timeoutMs: number = 5_000): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    let count = 0
    for (const [id, record] of [...registry.entries()]) {
      if (record.scope === scope) {
        yield* record.teardown().pipe(Effect.timeout(timeoutMs))
        registry.delete(id)
        count++
      }
    }
    return count
  })
}

function dumpLiveResources(): ResourceRecord[] {
  return [...registry.values()]
}

function leakReport(): { total: number; byType: Record<string, number>; byScope: Record<string, number> } {
  const byType: Record<string, number> = {}
  const byScope: Record<string, number> = {}
  for (const r of registry.values()) {
    byType[r.type] = (byType[r.type] ?? 0) + 1
    byScope[r.scope] = (byScope[r.scope] ?? 0) + 1
  }
  return { total: registry.size, byType, byScope }
}

export type { ResourceID, ResourceRecord }
export { register, teardownAll, teardownScope, dumpLiveResources, leakReport, registry, acquisitionOrder }
