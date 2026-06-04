import { createSignal, Show } from "solid-js"
import { WebContainer } from "@webcontainer/api"

export function WebcontainerDiagnostic() {
  const [visible, setVisible] = createSignal(import.meta.env.VITE_WEBCONTAINER_ISOLATION === "true" || localStorage.getItem("wc_diagnostic") === "true")

  if (!visible()) return null

  const [booting, setBooting] = createSignal(false)
  const [bootResult, setBootResult] = createSignal<string | undefined>(undefined)

  const checkBoot = async () => {
    setBooting(true)
    setBootResult("Booting...")
    try {
      const wc = await WebContainer.boot()
      setBootResult("Success!")
      wc.teardown()
    } catch (err: any) {
      setBootResult("Error: " + err.message)
    } finally {
      setBooting(false)
    }
  }

  return (
    <div class="fixed bottom-4 right-4 bg-background-stronger border border-border-base rounded-md p-4 flex flex-col gap-2 z-[9999] shadow-lg max-w-sm pointer-events-auto">
      <h3 class="text-14-medium text-text-strong">WebContainer Diagnostic</h3>
      <div class="flex flex-col gap-1 text-12-regular text-text-base">
        <div class="flex justify-between gap-4">
          <span>crossOriginIsolated:</span>
          <span class={window.crossOriginIsolated ? "text-green-500" : "text-red-500"}>
            {window.crossOriginIsolated ? "true" : "false"}
          </span>
        </div>
        <div class="flex justify-between gap-4">
          <span>SharedArrayBuffer:</span>
          <span class={typeof SharedArrayBuffer !== "undefined" ? "text-green-500" : "text-red-500"}>
            {typeof SharedArrayBuffer !== "undefined" ? "available" : "missing"}
          </span>
        </div>
      </div>
      <button
        class="mt-2 bg-surface-hover hover:bg-surface-active px-3 py-1 rounded text-12-medium text-text-strong border border-border-weaker-base cursor-pointer"
        onClick={checkBoot}
        disabled={booting()}
      >
        {booting() ? "Booting..." : "Test WebContainer.boot()"}
      </button>
      <Show when={bootResult()}>
        <div class="text-12-regular text-text-weaker mt-1 break-words">{bootResult()}</div>
      </Show>
    </div>
  )
}
