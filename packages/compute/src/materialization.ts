/** Whether a materialization involved copying data or sharing storage via a view. */
export type MaterializationKind = "copy" | "zero_copy_view"

/** A receipt recording a materialization event — copy or zero-copy view creation. */
export interface MaterializationReceipt {
  /** Globally-unique receipt identifier. */
  readonly receiptId: string

  /** Id of the source storage handle being materialized from. */
  readonly sourceHandleId: string

  /** Id of the target storage handle produced by materialization. */
  readonly targetHandleId: string

  /** How materialization was achieved. */
  readonly kind: MaterializationKind

  /** Number of bytes that were copied (0 for zero-copy). */
  readonly bytesCopied: number

  /** ISO-8601 timestamp of the materialization event. */
  readonly timestamp: string

  /** Operation id that triggered this materialization (for tracing). */
  readonly operationId: string
}
