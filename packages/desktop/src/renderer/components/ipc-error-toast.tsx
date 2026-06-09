import { Show, For, createSignal, onCleanup } from "solid-js"
import { useDesktopRuntime } from "../desktop-runtime-context"

interface IpcError {
  requestId: string
  code: string
  message: string
  recoverability: string
  timestamp: number
}

/** Map IPC error code to user-facing label */
function errorLabel(code: string): string {
  const labels: Record<string, string> = {
    unavailable: "Service Unavailable",
    invalid_request: "Request Failed",
    permission_denied: "Access Denied",
    timeout: "Request Timed Out",
    not_found: "Not Found",
    conflict: "Conflict",
    cancelled: "Cancelled",
    rate_limited: "Rate Limited",
    unsupported: "Unsupported Operation",
    internal: "Unexpected Error",
  }
  return labels[code] ?? code
}

/** Whether to auto-dismiss */
function autoDismiss(code: string): boolean {
  // Dismissable: transient errors. Persistent: permission, auth, internal
  return ["timeout", "cancelled", "rate_limited", "invalid_request"].includes(code)
}

export function IpcErrorToast() {
  const [errors, setErrors] = createSignal<IpcError[]>([])
  const [dismissed, setDismissed] = createSignal<Set<string>>(new Set())

  // Listen for IPC failures from the preload
  const cleanup = window.api.onIpcFailure?.((error: IpcError) => {
    setErrors((prev) => [error, ...prev].slice(0, 5))
    if (autoDismiss(error.code)) {
      setTimeout(() => {
        setDismissed((prev) => new Set([...prev, error.requestId]))
      }, 5000)
    }
  })
  onCleanup(() => cleanup?.())

  const visible = () => errors().filter((e) => !dismissed().has(e.requestId))

  return (
    <div class="fixed bottom-4 right-4 flex flex-col gap-2 z-50 max-w-sm">
      <For each={visible()}>
        {(error) => (
          <div class={`p-3 rounded shadow-lg text-12 border ${error.code === "internal" ? "bg-red-900/40 border-red-700" : "bg-surface-base border-surface-weak"}`}>
            <div class="flex justify-between items-start">
              <span class="text-12-semibold">{errorLabel(error.code)}</span>
              <button class="text-text-weak hover:text-text-strong" onClick={() => setDismissed((prev) => new Set([...prev, error.requestId]))}>
                x
              </button>
            </div>
            <p class="text-text-weak mt-1">{error.message}</p>
            <Show when={error.code === "internal"}>
              <p class="text-text-weak text-10 mt-1 opacity-50">ID: {error.requestId}</p>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}
