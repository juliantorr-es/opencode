import { bigint } from "drizzle-orm/pg-core"

export const TimestampsPg = {
  time_created: bigint({ mode: "number" })
    .notNull()
    .$default(() => Date.now()),
  time_updated: bigint({ mode: "number" })
    .notNull()
    .$onUpdate(() => Date.now()),
}
