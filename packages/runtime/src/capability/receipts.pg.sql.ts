import { pgTable, text, bigint, jsonb } from "drizzle-orm/pg-core"
import { SessionTable } from "../session/session.pg.sql"

export const CapabilityAuthorityReceiptTable = pgTable("capability_authority_receipt", {
  id: text("id").primaryKey(),
  timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  capability_id: text("capability_id").notNull(),
  action_name: text("action_name").notNull(),
  session_id: text("session_id").references(() => SessionTable.id, { onDelete: "cascade" }),
  project_id: text("project_id"),
  authority_outcome: text("authority_outcome").notNull(), // 'allowed' or 'refused'
  refusal_reasons: jsonb("refusal_reasons").$type<string[]>(),
  authority_chain: jsonb("authority_chain").$type<any[]>(),
  missing_authority: jsonb("missing_authority").$type<string[]>(),
  recovery_state: text("recovery_state").notNull(),
  approval_level: text("approval_level").notNull(),
  privilege_boundaries: jsonb("privilege_boundaries").$type<string[]>(),
  consent_class: text("consent_class").notNull(),
})
