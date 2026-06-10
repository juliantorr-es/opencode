/**
 * Compile fixture: proves ioredis 5.11.1 command shapes.
 * This file MUST compile with `tsgo --noEmit`.
 *
 * CRITICAL: ioredis stream commands (xadd, xreadgroup, etc.) exist as typed
 * methods on the Redis class. The codebase's errors come from using `send_command`
 * (snake_case, non-existent) instead of `sendCommand` (camelCase, takes Command
 * object), and from treating xreadgroup/xpending/xautoclaim results as typed
 * tuples when they return `unknown` or `Result<unknown, Context>` from RedisCommander.
 */
import Redis from "ioredis"

const redis = new Redis({ lazyConnect: true })

// ============================================================
// xadd: (key, id, ...fieldValues) → Result<string | null, Context>
// The Result utility type strips promise wrapping: Promise<string | null>
// ============================================================
async function xaddOp() {
  const entryId: string | null = await redis.xadd("stream", "*", "field1", "val1")
  void entryId
}

// ============================================================
// xreadgroup: typed overloads exist on Redis
// Returns: Promise<[string, [string, string[]][]][] | null>
// Each entry: [id: string, fields: string[]]
// ============================================================
async function xreadgroupOp() {
  const result = await redis.xreadgroup(
    "GROUP", "mygroup", "consumer1",
    "COUNT", 10,
    "BLOCK", 5000,
    "STREAMS", "mystream",
    ">"
  )
  // Narrow null first, then destructure
  if (result) {
    for (const [streamName, entries] of result) {
      void streamName
      if (entries) {
        for (const [id, fields] of entries) {
          void id
          void fields
        }
      }
    }
  }
}

// ============================================================
// xpending: (key, group, start, end, count, consumer?)
// ============================================================
async function xpendingOp() {
  const pending = await redis.xpending("stream", "mygroup", "-", "+", 10)
  void pending
}

// ============================================================
// xautoclaim: (key, group, consumer, minIdleMs, start, ...options)
// ============================================================
async function xautoclaimOp() {
  const claimed = await redis.xautoclaim(
    "stream", "mygroup", "consumer1",
    60000, "0-0",
    "COUNT", 10
  )
  void claimed
}

// ============================================================
// xgroup CREATE: (subcommand, key, group, id, ...options)
// ============================================================
async function xgroupOp() {
  await redis.xgroup("CREATE", "stream", "mygroup", "$", "MKSTREAM")
}

// ============================================================
// xinfo STREAM / GROUPS
// ============================================================
async function xinfoOp() {
  const streamInfo = await redis.xinfo("STREAM", "stream")
  void streamInfo
  const groupInfo = await redis.xinfo("GROUPS", "stream")
  void groupInfo
}

// ============================================================
// Pipeline
// ============================================================
async function pipelined() {
  const pipe = redis.pipeline()
  pipe.xadd("stream", "*", "k", "v")
  pipe.xreadgroup("GROUP", "g", "c", "STREAMS", "s", ">")
  const results = await pipe.exec()
  void results
}
