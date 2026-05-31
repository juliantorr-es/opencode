import { pgTable, text, integer, jsonb, primaryKey } from "drizzle-orm/pg-core"

export const CoordinationClaimTable = pgTable("coordination_claim", {
  task_id: text().primaryKey(),
  session_id: text().notNull(),
  wave: integer().notNull().default(0),
  wave_type: text().notNull().default(""),
  subagent_type: text().notNull(),
  description: text().notNull(),
  status: text().notNull().$type<"claimed" | "released" | "failed">(),
  result: text(),
  error: text(),
  created_at: integer().notNull(),
  expires_at: integer(),
  released_at: integer(),
})

export const CoordinationReservationTable = pgTable("coordination_reservation", {
  path: text().primaryKey(),
  task_id: text().notNull(),
  session_id: text().notNull(),
  status: text().notNull().$type<"reserved" | "released" | "conflicted">(),
  created_at: integer().notNull(),
})

export const CoordinationFanOutTable = pgTable(
  "coordination_fan_out",
  {
    session_id: text().notNull(),
    wave: integer().notNull(),
    wave_type: text().notNull(),
    task_ids: jsonb().notNull().$type<string[]>(),
    complete_count: integer().notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.wave, table.wave_type] }),
  ],
)
