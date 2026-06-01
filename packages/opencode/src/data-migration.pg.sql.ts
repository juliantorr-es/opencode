import { bigint, pgTable, text } from "drizzle-orm/pg-core"

export const DataMigrationTable = pgTable("data_migration", {
  name: text().primaryKey(),
  time_completed: bigint("time_completed", { mode: "number" }).notNull(),
})
