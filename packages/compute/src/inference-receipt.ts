// ── Types ─────────────────────────────────────────────────────────────────────

export interface InferenceReceipt {
  readonly receiptId: string
  readonly sessionId: string
  readonly modelId: string
  readonly quantScheme: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalFlops: number // estimated FLOPs consumed
  readonly startTime: string
  readonly endTime: string
  readonly wallTimeMs: number
  readonly checkpointId?: string
}

export interface InferenceReceiptManager {
  /**
   * Open a new receipt for an inference session.
   * The receipt is returned in an in-progress state without endTime/wallTime.
   */
  begin(sessionId: string, modelId: string, quantScheme: string, inputTokens: number): InferenceReceipt

  /**
   * Finalise the receipt with actual output token count and total FLOPs consumed.
   */
  complete(receiptId: string, outputTokens: number, totalFlops: number): InferenceReceipt

  /**
   * Retrieve a receipt by id.
   */
  get(receiptId: string): InferenceReceipt | undefined

  /**
   * List all receipts for a given session, newest first.
   */
  listBySession(sessionId: string): InferenceReceipt[]

  /**
   * List all receipts for a given model, newest first.
   */
  listByModel(modelId: string): InferenceReceipt[]
}

// ── Concrete implementation ───────────────────────────────────────────────────

let receiptIdCounter = 0

export class SimpleInferenceReceiptManager implements InferenceReceiptManager {
  private readonly store = new Map<string, InferenceReceipt>()

  begin(sessionId: string, modelId: string, quantScheme: string, inputTokens: number): InferenceReceipt {
    const receiptId = `receipt-${++receiptIdCounter}-${Date.now()}`
    const now = new Date().toISOString()

    const receipt: InferenceReceipt = {
      receiptId,
      sessionId,
      modelId,
      quantScheme,
      inputTokens,
      outputTokens: 0,
      totalFlops: 0,
      startTime: now,
      endTime: "",
      wallTimeMs: 0,
    }

    this.store.set(receiptId, receipt)
    return receipt
  }

  complete(receiptId: string, outputTokens: number, totalFlops: number): InferenceReceipt {
    const receipt = this.store.get(receiptId)
    if (!receipt) {
      throw new Error(`Receipt not found: ${receiptId}`)
    }

    const endTime = new Date().toISOString()
    const startMs = new Date(receipt.startTime).getTime()
    const endMs = new Date(endTime).getTime()

    const updated: InferenceReceipt = {
      ...receipt,
      outputTokens,
      totalFlops,
      endTime,
      wallTimeMs: endMs - startMs,
    }

    this.store.set(receiptId, updated)
    return updated as InferenceReceipt
  }

  get(receiptId: string): InferenceReceipt | undefined {
    return this.store.get(receiptId)
  }

  listBySession(sessionId: string): InferenceReceipt[] {
    const result: InferenceReceipt[] = []
    for (const receipt of this.store.values()) {
      if (receipt.sessionId === sessionId) {
        result.push(receipt)
      }
    }
    result.sort((a, b) => b.startTime.localeCompare(a.startTime))
    return result
  }

  listByModel(modelId: string): InferenceReceipt[] {
    const result: InferenceReceipt[] = []
    for (const receipt of this.store.values()) {
      if (receipt.modelId === modelId) {
        result.push(receipt)
      }
    }
    result.sort((a, b) => b.startTime.localeCompare(a.startTime))
    return result
  }
}
