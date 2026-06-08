import type { TokenStream } from "./streaming.js"
import { ArrayTokenStream } from "./streaming.js"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CheckpointState {
  readonly checkpointId: string
  readonly sessionId: string
  readonly modelId: string
  readonly step: number
  readonly kvCacheState: Map<string, { key: string; kShape: number[]; vShape: number[] }>
  readonly tokenBuffer: number[]
  readonly timestamp: string
}

export interface CheckpointManager {
  save(sessionId: string, state: Omit<CheckpointState, "checkpointId" | "timestamp">): Promise<CheckpointState>
  load(checkpointId: string): Promise<CheckpointState>
  resume(checkpointId: string): Promise<TokenStream>
  list(sessionId: string): CheckpointState[]
}

// ── Concrete implementation ───────────────────────────────────────────────────

let checkpointIdCounter = 0

/**
 * In-memory checkpoint manager.
 *
 * Checkpoints are stored in a Map keyed by checkpoint id.
 * The `resume()` method replays the buffered tokens from a checkpoint as a
 * new TokenStream so the caller can continue generation from where it left off.
 */
export class SimpleCheckpointManager implements CheckpointManager {
  private readonly store = new Map<string, CheckpointState>()

  /** Callback invoked after every save. Mainly useful for external persistence integration. */
  onSave?: (state: CheckpointState) => void

  async save(
    sessionId: string,
    state: Omit<CheckpointState, "checkpointId" | "timestamp">,
  ): Promise<CheckpointState> {
    const checkpointId = `ckpt-${++checkpointIdCounter}-${Date.now()}`
    const timestamp = new Date().toISOString()

    const full: CheckpointState = {
      checkpointId,
      sessionId,
      modelId: state.modelId,
      step: state.step,
      kvCacheState: new Map(state.kvCacheState),
      tokenBuffer: [...state.tokenBuffer],
      timestamp,
    }

    this.store.set(checkpointId, full)
    this.onSave?.(full)
    return full
  }

  async load(checkpointId: string): Promise<CheckpointState> {
    const state = this.store.get(checkpointId)
    if (!state) {
      throw new Error(`Checkpoint not found: ${checkpointId}`)
    }
    return this.cloneState(state)
  }

  async resume(checkpointId: string): Promise<TokenStream> {
    const state = await this.load(checkpointId)

    // Convert the buffered tokens into a stream so the caller can replay them
    // and continue from the point the checkpoint was taken.
    const tokens = state.tokenBuffer.map(String)

    const stream = new ArrayTokenStream(tokens, state.sessionId)
    return stream
  }

  list(sessionId: string): CheckpointState[] {
    const result: CheckpointState[] = []
    for (const state of this.store.values()) {
      if (state.sessionId === sessionId) {
        result.push(this.cloneState(state))
      }
    }
    return result
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private cloneState(state: CheckpointState): CheckpointState {
    return {
      checkpointId: state.checkpointId,
      sessionId: state.sessionId,
      modelId: state.modelId,
      step: state.step,
      kvCacheState: new Map(state.kvCacheState),
      tokenBuffer: [...state.tokenBuffer],
      timestamp: state.timestamp,
    }
  }
}
