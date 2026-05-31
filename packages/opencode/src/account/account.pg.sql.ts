import { pgTable, text, integer, primaryKey, boolean, index } from "drizzle-orm/pg-core"

import { type AccessToken, type AccountID, type OrgID, type RefreshToken } from "./schema"
import { TimestampsPg } from "../storage/schema.pg.sql"

export const AccountTable = pgTable("account", {
  id: text().$type<AccountID>().primaryKey(),
  email: text().notNull(),
  url: text().notNull(),
  access_token: text().$type<AccessToken>().notNull(),
  refresh_token: text().$type<RefreshToken>().notNull(),
  token_expiry: integer(),
  ...TimestampsPg,
})

export const AccountStateTable = pgTable("account_state", {
  id: integer().primaryKey(),
  active_account_id: text()
    .$type<AccountID>()
    .references(() => AccountTable.id, { onDelete: "set null" }),
  active_org_id: text().$type<OrgID>(),
}, (table) => ({
  accountStateActiveAccountIdx: index("account_state_active_account_idx").on(table.active_account_id),
}))

// LEGACY
export const ControlAccountTable = pgTable(
  "control_account",
  {
    email: text().notNull(),
    url: text().notNull(),
    access_token: text().$type<AccessToken>().notNull(),
    refresh_token: text().$type<RefreshToken>().notNull(),
    token_expiry: integer(),
    active: boolean()
      .notNull()
      .$default(() => false),
    ...TimestampsPg,
  },
  (table) => [primaryKey({ columns: [table.email, table.url] })],
)
