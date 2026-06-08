import { rm } from "fs/promises"
import { Database } from "@/storage/db"

export async function resetDatabase() {
  await Promise.resolve(Database.close()).catch(() => undefined)
  const dbPath = Database.getPath()
  await rm(dbPath, { force: true }).catch(() => undefined)
}
