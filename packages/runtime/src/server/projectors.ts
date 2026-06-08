import sessionProjectors from "../session/projectors"
import { one } from "@/storage/adapter"
import { SyncEvent } from "@/sync"
import { Session } from "@/session/session"
import { SessionTable } from "@/storage/schema"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"

export async function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    convertEvent: async (type, data) => {
      if (type === "session.updated") {
        const id = (data as SyncEvent.Event<typeof Session.Event.Updated>["data"]).sessionID
        const row = await Database.use(async (db) => one(db.select().from(SessionTable).where(eq(SessionTable.id, id))))

        if (!row) return data

        return {
          sessionID: id,
          info: Session.fromRow(row),
        }
      }
      return data
    },
  })
}