/**
 * Shared helpers for serialized writes across IPC handler modules.
 *
 * writeQueues is a shared Map<string, Promise> — each namespace gets
 * a serialized promise chain so that concurrent writes to the same
 * store key are sequenced, not interleaved.
 */

const writeQueues = new Map<string, Promise<unknown>>()

export function serializedWrite<T = void>(namespace: string, fn: () => T): Promise<T> {
  const prev = writeQueues.get(namespace) ?? Promise.resolve(undefined as unknown as T)
  const next = prev
    .then(() => fn())
    .catch((err) => {
      console.error(`serializedWrite(${namespace}) failed:`, err)
      throw err
    })
  writeQueues.set(namespace, next)
  return next
}
