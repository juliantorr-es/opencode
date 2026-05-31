import { Effect, Ref } from "effect"
import { randomBytes } from "crypto"

const prefixes = {
  job: "job",
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
} as const

const LENGTH = 26

// Atomic state for monotonic ID generation
// Shared across Effect fibers; Ref.modify guarantees atomic increment
const stateRef: Ref.Ref<{ lastTimestamp: number; counter: number }> = Effect.runSync(
  Ref.make({ lastTimestamp: 0, counter: 0 }),
)

function nextCounter(timestamp: number): Effect.Effect<number> {
  return Ref.modify(stateRef, (state) => {
    if (timestamp !== state.lastTimestamp) {
      // New millisecond, reset counter
      return [1, { lastTimestamp: timestamp, counter: 1 }] as const
    }
    const next = state.counter + 1
    return [next, { ...state, counter: next }] as const
  })
}

export function ascending(prefix: keyof typeof prefixes, given?: string): Effect.Effect<string> {
  return generateID(prefix, "ascending", given)
}

export function descending(prefix: keyof typeof prefixes, given?: string): Effect.Effect<string> {
  return generateID(prefix, "descending", given)
}

function generateID(
  prefix: keyof typeof prefixes,
  direction: "descending" | "ascending",
  given?: string,
): Effect.Effect<string> {
  if (!given) {
    return create(prefixes[prefix], direction)
  }

  if (!given.startsWith(prefixes[prefix])) {
    return Effect.dieSync(new Error(`ID ${given} does not start with ${prefixes[prefix]}`))
  }
  return Effect.succeed(given)
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let result = ""
  const bytes = randomBytes(length)
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % 62]
  }
  return result
}

export function create(
  prefix: string,
  direction: "descending" | "ascending",
  timestamp?: number,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    const currentTimestamp = timestamp ?? Date.now()
    const counter = yield* nextCounter(currentTimestamp)

    let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

    now = direction === "descending" ? ~now : now

    const timeBytes = Buffer.alloc(6)
    for (let i = 0; i < 6; i++) {
      timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
    }

    return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
  })
}

/** Extract timestamp from an ascending ID. Does not work with descending IDs. */
export function timestamp(id: string): number {
  const prefix = id.split("_")[0]
  const hex = id.slice(prefix.length + 1, prefix.length + 13)
  const encoded = BigInt("0x" + hex)
  return Number(encoded / BigInt(0x1000))
}

export * as Identifier from "./id"
