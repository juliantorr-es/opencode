import { pgTable, text, integer, jsonb } from "drizzle-orm/pg-core"
import { TimestampsPg } from "../storage/schema.pg.sql"
import type { ProjectID } from "./schema"

export const ProjectTable = pgTable("project", {
  id: text().$type<ProjectID>().primaryKey(),
  worktree: text().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_url_override: text(),
  icon_color: text(),
  ...TimestampsPg,
  time_initialized: integer(),
  sandboxes: jsonb().notNull().$type<string[]>(),
  commands: jsonb().$type<{ start?: string }>(),
})
