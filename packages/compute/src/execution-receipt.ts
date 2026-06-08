import type { AcceleratorBackend } from "./backend-router.js"

export interface ExecutionReceipt {
  readonly receiptId: string
  readonly opId: string
  readonly backend: AcceleratorBackend
  readonly startTime: string
  readonly endTime: string
  readonly durationMs: number
  readonly status: "completed" | "failed" | "cancelled"
  readonly error?: string
}

let nextReceiptId = 0

export function createExecutionReceipt(
  params: Omit<
    ExecutionReceipt,
    "receiptId" | "startTime" | "endTime" | "durationMs"
  > &
    Partial<Pick<ExecutionReceipt, "startTime" | "endTime" | "durationMs">>,
): ExecutionReceipt {
  const startTime = params.startTime ?? new Date().toISOString()
  const endTime = params.endTime ?? new Date().toISOString()
  const durationMs =
    params.durationMs ??
    (() => {
      const s = new Date(startTime).getTime()
      const e = new Date(endTime).getTime()
      return isNaN(s) || isNaN(e) ? 0 : Math.max(0, e - s)
    })()

  return {
    receiptId: `receipt_${nextReceiptId++}`,
    opId: params.opId,
    backend: params.backend,
    startTime,
    endTime,
    durationMs,
    status: params.status,
    error: params.error,
  }
}

export function completeReceipt(
  params: Omit<ExecutionReceipt, "receiptId" | "status">,
): ExecutionReceipt {
  return createExecutionReceipt({ ...params, status: "completed" })
}

export function failReceipt(
  params: Omit<ExecutionReceipt, "receiptId" | "status" | "error"> & {
    readonly error?: string
  },
): ExecutionReceipt {
  return createExecutionReceipt({ ...params, status: "failed" })
}

export function cancelReceipt(
  params: Omit<ExecutionReceipt, "receiptId" | "status">,
): ExecutionReceipt {
  return createExecutionReceipt({ ...params, status: "cancelled" })
}
