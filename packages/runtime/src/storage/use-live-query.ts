/**
 * SolidJS hook for PGlite live query subscriptions.
 *
 * Bridges Effect Streams into reactive SolidJS signals with automatic
 * cleanup on component disposal.
 */

import { createSignal, onCleanup } from "solid-js"
import { Effect, Stream } from "effect"

/**
 * Subscribe to an Effect Stream of query results as a SolidJS signal.
 *
 * Returns a reactive `data` signal and an optional `error` signal.
 * The stream is forked on mount and interrupted on component cleanup.
 *
 * @example
 * ```ts
 * function TodoList() {
 *   const stream = pgliteLiveQuery.subscribe("SELECT * FROM todos")
 *   const { data, error } = createLiveQuery(stream)
 *   return <For each={data()}>{row => <div>{row.title}</div>}</For>
 * }
 * ```
 */
export function createLiveQuery<R extends Record<string, unknown>>(
  stream: Stream.Stream<R[], never>,
) {
  const [data, setData] = createSignal<R[]>([])
  const [error, setError] = createSignal<Error | null>(null)

  const fiber = Effect.runFork(
    stream.pipe(
      Stream.runForEach((rows) =>
        Effect.sync(() => {
          setData(rows)
        }),
      ),
    ),
  )
  onCleanup(() => { // @ts-expect-error SolidJS onCleanup type import
    Effect.runFork(Effect.interrupt(fiber))
  })

  return { data, error } as const
}
