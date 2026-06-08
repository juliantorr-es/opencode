import { Effect } from "effect"
import { DatabaseAdapter } from "@/storage/adapter"
import { ensureCoordinationTables } from "@/tool/coordination"
import { testEffect } from "../lib/effect"

const it = testEffect(DatabaseAdapter.defaultLayer)

it.live("ensureCoordinationTables tolerates a preexisting coordination schema", () =>
  Effect.gen(function* () {
    const adapter = yield* DatabaseAdapter.Service
    yield* adapter.query((db: any) =>
      db.run(`
        CREATE TABLE IF NOT EXISTS coordination_claim (
          task_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          wave INTEGER NOT NULL DEFAULT 0,
          wave_type TEXT NOT NULL DEFAULT '',
          subagent_type TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL,
          result TEXT,
          error TEXT,
          created_at BIGINT NOT NULL,
          expires_at BIGINT,
          released_at BIGINT
        )
      `),
    )
    yield* adapter.query((db: any) =>
      db.run(`
        CREATE TABLE IF NOT EXISTS coordination_reservation (
          path TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          expires_at BIGINT,
          base_digest TEXT
        )
      `),
    )
    yield* adapter.query((db: any) =>
      db.run(`
        CREATE TABLE IF NOT EXISTS coordination_fan_out (
          session_id TEXT NOT NULL,
          wave INTEGER NOT NULL,
          wave_type TEXT NOT NULL,
          task_ids TEXT NOT NULL,
          complete_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (session_id, wave, wave_type)
        )
      `),
    )

    yield* ensureCoordinationTables().pipe(Effect.orDie)
  }),
)
