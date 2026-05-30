import { pgTable, text } from "drizzle-orm/pg-core"
import { SessionTable } from "../session/session.pg.sql"
import { TimestampsPg } from "../storage/schema.pg.sql"

export const SessionShareTable = pgTable("session_share", {
  session_id: text()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  id: text().notNull(),
  secret: text().notNull(),
  url: text().notNull(),
  ...TimestampsPg,
})
