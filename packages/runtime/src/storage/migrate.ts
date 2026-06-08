import { init as initPg, applyMigrations } from "#db"

function resolveConnectionString(): string {
  const args = process.argv.slice(2)
  const connStrIndex = args.indexOf("--connection-string")
  if (connStrIndex !== -1 && args[connStrIndex + 1]) {
    return args[connStrIndex + 1]
  }
  return process.env["OPENCODE_DATABASE_URL"] ?? ":memory:"
}

export async function runMigrations(connectionString?: string): Promise<void> {
  const url = connectionString ?? resolveConnectionString()
  if (url === ":memory:") {
    console.warn("[migrate] No connection string provided; defaulting to :memory: (PGlite)")
  }
  const ssl = process.env["OPENCODE_DATABASE_SSL"] !== "false"
  const client = initPg(url, ssl)
  try {
    await applyMigrations(client)
  } finally {
    const underlying = (client as any).$client
    if (underlying && typeof underlying.end === "function") {
      await underlying.end()
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const connStrIndex = args.indexOf("--connection-string")
  const connectionString = connStrIndex !== -1 ? args[connStrIndex + 1] : undefined

  runMigrations(connectionString)
    .then(() => {
      console.log("Migrations applied successfully")
      process.exit(0)
    })
    .catch((err) => {
      console.error("Migration failed:", err)
      process.exit(1)
    })
}
