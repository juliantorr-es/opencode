

export { Config } from "@/config/config"
export { Server } from "./server/server"
export { bootstrap } from "./cli/bootstrap"
export * as Log from "@tribunus/core/util/log"
// @deprecated use DatabaseAdapter.Service instead — direct Database access
// bypasses the adapter layer. Database is now Postgres-native (PGlite or node-postgres).
export { Database } from "@/storage/db"
export { applyMigrations } from "@/storage/db.pg"
