type Definition = {
  [method: string]: (input: any) => any
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    const parsed = safeJsonParse(evt.data) as Record<string, unknown> | undefined
    if (!parsed) return
    if (parsed.type === "rpc.request") {
      const result = await rpc[parsed.method as string](parsed.input)
      postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
    }
  }
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
}) {
  const pending = new Map<number, (result: any) => void>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  target.onmessage = async (evt) => {
    const parsed = safeJsonParse(evt.data) as Record<string, unknown> | undefined
    if (!parsed) return
    if (parsed.type === "rpc.result") {
      const resolve = pending.get(parsed.id as number)
      if (resolve) {
        resolve(parsed.result)
        pending.delete(parsed.id as number)
      }
    }
    if (parsed.type === "rpc.event") {
      const handlers = listeners.get(parsed.event as string)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      return new Promise((resolve) => {
        pending.set(requestId, resolve)
        target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}

export * as Rpc from "./rpc"
