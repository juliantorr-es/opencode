export type Fence = { readonly fenceId: string; readonly signaled: boolean }
export type ComputeEvent = { readonly eventId: string; readonly timestamp: string }

export interface CommandBuffer {
  submit(opId: string): Fence
  waitFor(fence: Fence): Promise<void>
  signalEvent(): ComputeEvent
  flush(): Promise<void>
}

let nextFenceId = 0
let nextEventId = 0

interface PendingFence {
  readonly promise: Promise<void>
  resolve: () => void
  reject: (reason: unknown) => void
}

export function createCommandBuffer(): CommandBuffer {
  const pending = new Map<string, PendingFence>()

  return {
    submit(opId: string): Fence {
      const fenceId = `fence_${nextFenceId++}`

      let resolve!: () => void
      let reject!: (reason: unknown) => void
      const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })

      pending.set(fenceId, { promise, resolve, reject })

      globalThis.queueMicrotask(() => {
        resolve()
        pending.delete(fenceId)
      })

      return { fenceId, signaled: true }
    },

    async waitFor(fence: Fence): Promise<void> {
      if (fence.signaled) return
      const entry = pending.get(fence.fenceId)
      if (!entry) return
      return entry.promise
    },

    signalEvent(): ComputeEvent {
      return {
        eventId: `evt_${nextEventId++}`,
        timestamp: new Date().toISOString(),
      }
    },

    async flush(): Promise<void> {
      if (pending.size === 0) return
      const fences = Array.from(pending.entries())
      await Promise.all(
        fences.map(([, entry]) => entry.promise.catch(() => {})),
      )
      pending.clear()
    },
  }
}
