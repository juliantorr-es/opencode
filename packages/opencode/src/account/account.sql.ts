import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"

import { type AccessToken, type AccountID, type OrgID, type RefreshToken } from "./schema"
import { TimestampsPg } from "../storage/schema.pg.sql"

export const AccountTable = sqliteTable("account", {
  id: text().$type<AccountID>().primaryKey(),
  email: text().notNull(),
  url: text().notNull(),
  access_token: text().$type<AccessToken>().notNull(),
  refresh_token: text().$type<RefreshToken>().notNull(),
  token_expiry: integer(),
  ...TimestampsPg,
})

export const AccountStateTable = sqliteTable("account_state", {
  id: integer().primaryKey(),
  active_account_id: text()
    .$type<AccountID>()
    .references(() => AccountTable.id, { onDelete: "set null" }),
  active_org_id: text().$type<OrgID>(),
})

// LEGACY
export const ControlAccountTable = sqliteTable(
  "control_account",
  {
    email: text().notNull(),
    url: text().notNull(),
    access_token: text().$type<AccessToken>().notNull(),
    refresh_token: text().$type<RefreshToken>().notNull(),
    token_expiry: integer(),
    active: integer({ mode: "boolean" })
      .notNull()
      .$default(() => false),
    ...TimestampsPg,
  },
  (table) => [primaryKey({ columns: [table.email, table.url] })],
)
