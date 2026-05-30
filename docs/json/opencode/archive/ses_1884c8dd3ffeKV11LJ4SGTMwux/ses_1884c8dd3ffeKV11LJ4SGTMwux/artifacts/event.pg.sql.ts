import { pgTable, text, integer, jsonb } from "drizzle-orm/pg-core"

export const EventSequenceTable = pgTable("event_sequence", {
  aggregate_id: text().notNull().primaryKey(),
  seq: integer().notNull(),
  owner_id: text(),
})

export const EventTable = pgTable("event", {
  id: text().primaryKey(),
  aggregate_id: text()
    .notNull()
    .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
  seq: integer().notNull(),
  type: text().notNull(),
  data: jsonb().$type<Record<string, unknown>>().notNull(),
})
