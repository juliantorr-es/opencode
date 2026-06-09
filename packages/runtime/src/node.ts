
// ── Sidecar IPC handler — uses Electron's utilityProcess parentPort ──
// The desktop spawns this as a utilityProcess (Electron's child process API).
// Messages arrive via process.parentPort.on("message"), NOT process.on("message").
// The parent sends { type: "start", hostname, port, password, userDataPath, needsMigration }.
if (process.parentPort) {
  process.parentPort.on("message", (e: unknown) => {
    const msg = (e as { data?: unknown }).data ?? e
    const m = msg as Record<string, unknown>
    if (m?.type === "start") {
      import("./cli/bootstrap").then(({ bootstrap }) => {
        return bootstrap({
          hostname: m.hostname as string,
          port: m.port as number,
          password: m.password as string,
          userDataPath: m.userDataPath as string,
          needsMigration: !!m.needsMigration,
        })
      }).catch((err: unknown) => {
        console.error("[sidecar] bootstrap failed:", err instanceof Error ? err.message : String(err))
        process.exit(1)
      })
    }
  })
}

export { Config } from "@/config/config"
export { Server } from "./server/server"
export * as Log from "@tribunus/core/util/log"
export { Database } from "@/storage/db"
export { applyMigrations } from "@/storage/db.pg"
