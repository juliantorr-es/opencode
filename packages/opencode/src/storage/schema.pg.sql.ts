import { integer } from "drizzle-orm/sqlite-core"

export const TimestampsPg = {
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
  time_updated: integer()
    .notNull()
    .$onUpdate(() => Date.now()),
}
