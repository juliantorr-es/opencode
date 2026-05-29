import { Effect, Semaphore } from "effect"

const locks = new Map<string, Semaphore.Semaphore>()

/**
 * Acquire a per-file semaphore to serialize concurrent edits/writes to the same file.
 * Uses the same pattern as edit.ts's private `lock()` function.
 */
export const lock = Effect.fn("FileLock.lock")(function* (filePath: string) {
  const key = filePath.toLowerCase()
  let semaphore = locks.get(key)
  if (!semaphore) {
    semaphore = yield* Semaphore.make(1)
    locks.set(key, semaphore)
  }
  return semaphore
})

export * as FileLock from "./file-lock"
