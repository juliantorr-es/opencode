import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/**/*.pg.sql.ts",
  out: "./migration-pg",
})
