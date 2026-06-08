// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A token stream that yields tokens one at a time.
 *
 * Conforms to the async iterator protocol so it can be used with
 * `for await (const token of stream)`.
 */
export interface TokenStream {
  readonly sessionId: string

  /** Advance the stream and produce the next token. */
  next(): Promise<IteratorResult<string>>

  /** Cancel the stream mid-flight.  Subsequent `next()` calls resolve with `done: true`. */
  cancel(): void

  /** Register a completion handler.  Called once when the stream finishes. */
  onComplete(handler: (reason: string) => void): void
}

// ── Sentinels ─────────────────────────────────────────────────────────────────

/** Internal reason issued when cancel() is called. */
const CANCELLED = "cancelled"

// ── Concrete implementation ───────────────────────────────────────────────────

let streamSessionCounter = 0

/**
 * A simple token stream backed by a pre-computed array of tokens.
 * Useful for testing and for replaying cached generations.
 */
export class ArrayTokenStream implements TokenStream {
  readonly sessionId: string

  private tokens: string[]
  private index = 0
  private _cancelled = false
  private _done = false
  private completeHandlers: Array<(reason: string) => void> = []

  constructor(tokens: string[], sessionId?: string) {
    this.tokens = tokens
    this.sessionId = sessionId ?? `stream-${++streamSessionCounter}`
  }

  async next(): Promise<IteratorResult<string>> {
    if (this._cancelled) {
      this.finish(CANCELLED)
      return { value: undefined as unknown as string, done: true }
    }
    if (this._done) {
      return { value: undefined as unknown as string, done: true }
    }
    if (this.index >= this.tokens.length) {
      this.finish("completed")
      return { value: undefined as unknown as string, done: true }
    }
    const value = this.tokens[this.index++]!
    return { value, done: false }
  }

  cancel(): void {
    if (!this._cancelled && !this._done) {
      this._cancelled = true
      this.finish(CANCELLED)
    }
  }

  onComplete(handler: (reason: string) => void): void {
    this.completeHandlers.push(handler)
    // If already finished, fire immediately.
    if (this._done) {
      handler(this._doneReason)
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private _doneReason = ""

  private finish(reason: string): void {
    if (this._done) return
    this._done = true
    this._doneReason = reason
    const handlers = this.completeHandlers
    this.completeHandlers = []
    for (const h of handlers) {
      h(reason)
    }
  }
}

/**
 * A token stream backed by an async generator function.
 * Useful for streaming from a model inference loop.
 */
export class GeneratorTokenStream implements TokenStream {
  readonly sessionId: string

  private generator: AsyncGenerator<string>
  private _nextResult: Promise<IteratorResult<string>> | null = null
  private _cancelled = false
  private _done = false
  private completeHandlers: Array<(reason: string) => void> = []
  private _doneReason = ""

  constructor(generator: AsyncGenerator<string>, sessionId?: string) {
    this.generator = generator
    this.sessionId = sessionId ?? `stream-${++streamSessionCounter}`
  }

  async next(): Promise<IteratorResult<string>> {
    if (this._cancelled) {
      this.finish(CANCELLED)
      return { value: undefined as unknown as string, done: true }
    }
    if (this._done) {
      return { value: undefined as unknown as string, done: true }
    }

    // Guard against overlapping next() calls.
    if (this._nextResult) {
      return this._nextResult
    }

    const promise = this.generator.next()
    this._nextResult = promise

    try {
      const result = await promise
      if (result.done) {
        this.finish("completed")
      }
      return result
    } catch (err) {
      this.finish(`error: ${(err as Error).message ?? String(err)}`)
      return { value: undefined as unknown as string, done: true }
    } finally {
      this._nextResult = null
    }
  }

  cancel(): void {
    if (!this._cancelled && !this._done) {
      this._cancelled = true
      this.generator.return(undefined as unknown as string).catch(() => {})
      this.finish(CANCELLED)
    }
  }

  onComplete(handler: (reason: string) => void): void {
    this.completeHandlers.push(handler)
    if (this._done) {
      handler(this._doneReason)
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private finish(reason: string): void {
    if (this._done) return
    this._done = true
    this._doneReason = reason
    const handlers = this.completeHandlers
    this.completeHandlers = []
    for (const h of handlers) {
      h(reason)
    }
  }
}
