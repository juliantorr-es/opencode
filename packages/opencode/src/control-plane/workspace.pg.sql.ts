import { pgTable, text, integer, jsonb, index } from "drizzle-orm/pg-core"
import { ProjectTable } from "../project/project.pg.sql"
import type { ProjectID } from "../project/schema"
import type { WorkspaceID } from "./schema"

export const WorkspaceTable = pgTable("workspace", {
  id: text().$type<WorkspaceID>().primaryKey(),
  type: text().notNull(),
  name: text().notNull().default(""),
  branch: text(),
  directory: text(),
  extra: jsonb(),
  project_id: text()
    .$type<ProjectID>()
    .notNull()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  time_used: integer()
    .notNull()
    .$default(() => Date.now()),
}, (table) => ({
  workspaceProjectIdx: index("workspace_project_idx").on(table.project_id),
}))
