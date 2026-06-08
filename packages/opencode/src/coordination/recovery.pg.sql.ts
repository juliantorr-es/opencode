import { bigint, boolean, index, jsonb, pgTable, text } from "drizzle-orm/pg-core"
import { TimestampsPg } from "@/storage/schema.pg.sql"
import type { ProjectID } from "@/project/schema"
import type { SessionID } from "@/session/schema"

export const CoordinationRecoveryTable = pgTable(
  "coordination_recovery",
  {
    id: text().primaryKey(),
    session_id: text().notNull().$type<SessionID>(),
    project_id: text().notNull().$type<ProjectID>(),
    old_generation: bigint({ mode: "number" }).notNull(),
    new_generation: bigint({ mode: "number" }).notNull(),
    state: text().notNull(),
    outcome: text().notNull(),
    reasons: jsonb().notNull().$type<string[]>(),
    unsafe_work: boolean().notNull(),
    durable_receipt: boolean().notNull(),
    ...TimestampsPg,
  },
  (table) => [
    index("coordination_recovery_session_idx").on(table.session_id),
    index("coordination_recovery_project_idx").on(table.project_id),
  ],
)
