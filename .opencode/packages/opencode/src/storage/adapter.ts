/**
 * Drizzle query adapter — safely extracts single rows from query builders.
 *
 * drizzle-orm query builders have overloaded `.then()` signatures that prevent
 * TypeScript from inferring the row type via structural typing (T defaults to
 * `{}`). The query parameter is therefore typed as `unknown` with runtime
 * checks; callers must provide T explicitly via generic:
 *
 *   const row = await one<AccountRow>(db.select().from(accounts).where(...))
 */

// Minimal shape: any promise-like that resolves to an array of rows.
interface RowPromiseLike<T> {
  then<R1 = T[], R2 = never>(
    onfulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null | undefined,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null | undefined,
  ): PromiseLike<R1 | R2>
}

export function one<T>(query: unknown): Promise<T | undefined> {
  if (query != null && typeof query === "object" && "limit" in query) {
    // drizzle query supports .limit(1) chaining before .then()
    const limited = (query as unknown as { limit(n: number): RowPromiseLike<T> }).limit(1)
    return limited.then((rows) => rows[0]) as Promise<T | undefined>
  }
  const thenable = query as unknown as RowPromiseLike<T>
  return thenable.then((rows) => {
    // .then() may resolve T[] (select) or T (value query); normalize
    return Array.isArray(rows) ? rows[0] : rows as unknown as T
  }) as Promise<T | undefined>
}
