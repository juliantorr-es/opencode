import { MetaProvider } from "@solidjs/meta"
import { render } from "solid-js/web"
import "@opencode-ai/app/index.css"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import "./styles.css"
import { createSignal, onMount, For } from "solid-js"
import { SafeModeCard } from "./components/safe-mode-card"
import type { SafeModeAction, SafeModeDiagnostics } from "../preload/types"

const root = document.getElementById("root")!

interface ActionDef {
  title: string
  description: string
  action: SafeModeAction
}

const ACTIONS: ActionDef[] = [
  { title: "Export Debug Logs", description: "Save diagnostic logs to a file", action: "export_debug_logs" },
  { title: "Open Logs Directory", description: "Open the logs folder in Finder", action: "open_logs" },
  { title: "Repair Database", description: "Attempt to repair or reset the database", action: "repair_database" },
  { title: "Disable Plugins", description: "Disable all plugins on next startup", action: "disable_plugins" },
  { title: "Disable MCP Servers", description: "Disable all MCP servers on next startup", action: "disable_mcp" },
  { title: "Clear Stale Locks", description: "Remove stale session lock files", action: "clear_stale_locks" },
  { title: "Reset Configuration", description: "Reset config to factory defaults", action: "reset_config" },
  { title: "Copy Diagnostics", description: "Copy diagnostic summary to clipboard", action: "copy_diagnostic_summary" },
]

render(() => {
  const [diagnostics, setDiagnostics] = createSignal<SafeModeDiagnostics | null>(null)

  onMount(() => {
    window.api.getSafeModeDiagnostics().then(setDiagnostics).catch(() => {
      // Failed to get diagnostics, show minimal UI
    })
  })

  const handleRetry = () => {
    window.api.safeModeAction("retry_normal_startup").catch(() => {
      // Relaunch failed — user may need to restart manually
    })
  }

  const diag = diagnostics()

  return (
    <MetaProvider>
      <div class="w-screen h-screen bg-background-base flex flex-col">
        <Font />
        <div class="flex flex-col items-center justify-center px-8 py-12 gap-8 overflow-y-auto">
          <Splash class="w-20 h-25 opacity-15" />
          <div class="flex flex-col items-center gap-2">
            <h1 class="text-20-semibold text-text-strong">Safe Mode</h1>
            <p class="text-14-regular text-text-weak text-center max-w-md">
              OpenCode could not start normally. Use the options below to diagnose and fix the issue.
            </p>
          </div>

          {diag && (
            <div class="flex flex-col gap-2 w-full max-w-md rounded-lg border border-critical-base bg-critical-weak p-4">
              <span class="text-12-semibold text-text-strong">Error Details</span>
              <span class="text-12-regular text-text-weak font-mono break-all">
                {diag.error.message}
              </span>
              <span class="text-12-regular text-text-weak">
                Component: {diag.error.component}
              </span>
              <span class="text-12-regular text-text-weak mt-2">
                Platform: {diag.systemInfo.platform} {diag.systemInfo.arch} &middot; Version: {diag.systemInfo.version}
              </span>
            </div>
          )}

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg">
            <For each={ACTIONS}>
              {(card) => (
                <SafeModeCard
                  title={card.title}
                  description={card.description}
                  action={card.action}
                />
              )}
            </For>
          </div>

          <button
            class="mt-4 rounded-lg bg-accent-base px-6 py-3 text-14-semibold text-white hover:bg-accent-strong transition-colors"
            onClick={handleRetry}
          >
            Retry Normal Startup
          </button>
        </div>
      </div>
    </MetaProvider>
  )
}, root)
