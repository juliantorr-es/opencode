import { createSignal } from "solid-js"

interface IpcError {
  requestId: string
  code: string
  message: string
  recoverability: string
  timestamp: number
}

const [ipcErrors, setIpcErrors] = createSignal<IpcError[]>([])

export function useIpcErrors() {
  return { errors: ipcErrors, addError: (e: IpcError) => setIpcErrors((prev) => [e, ...prev].slice(0, 10)) }
}
