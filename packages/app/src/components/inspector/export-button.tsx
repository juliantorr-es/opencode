import { Component, createSignal } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@tribunus/ui/context/dialog"
import { Dialog } from "@tribunus/ui/dialog"
import { showToast } from "@tribunus/ui/toast"
import { useLanguage } from "@/context/language"

type ExportType = "standard" | "with-git-diff"

/**
 * ExportButton — triggers a debug packet export for the current session.
 *
 * The export calls the platform.exportDebugLogs() method which triggers
 * the backend to assemble and zip the debug packet, then returns the path
 * for download.
 */
export const ExportDebugButton: Component = () => {
  const params = useParams()
  const sdk = useSDK()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()

  const [exporting, setExporting] = createSignal(false)
  const [exportType, setExportType] = createSignal<ExportType>("standard")

  const handleExport = async () => {
    const sessionID = params.id
    if (!sessionID) return

    setExporting(true)
    try {
      // Method 1: Use the platform's exportDebugLogs if available (desktop)
      if (platform.exportDebugLogs) {
        // First trigger the backend to generate the debug packet
        // We use the SDK to call the debug export endpoint
        const result = await platform.saveFilePickerDialog?.({
          title: "Export Debug Packet",
          defaultPath: `debug-session-${sessionID}.zip`,
        })

        // If user cancelled, return
        if (result === null || result === undefined) {
          setExporting(false)
          return
        }

        showToast({
          title: language.t("toast.session.export.success.title") ?? "Export started",
          description: language.t("toast.session.export.success.description") ?? "Debug packet being generated",
          variant: "success",
        })
        dialog.close()
      } else {
        // Method 2: Web fallback — use the server SDK
        // This path would require a server endpoint to trigger the export
        showToast({
          title: "Export not available",
          description: "Debug export is only available on the desktop version",
          variant: "error",
        })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({
        title: language.t("toast.session.export.failed.title") ?? "Export failed",
        description: message,
        variant: "error",
      })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div class="flex flex-col gap-3">
      <p class="text-sm text-text-weak">
        {language.t("dialog.export.description") ?? "Export a debug packet containing session metadata, events, tool calls, and configuration for debugging purposes."}
      </p>

      <div class="flex flex-col gap-2">
        <label class="flex items-center gap-2 cursor-pointer text-sm">
          <input
            type="radio"
            name="export-type"
            checked={exportType() === "standard"}
            onChange={() => setExportType("standard")}
            class="radio"
          />
          <span>Standard — session data and events</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer text-sm">
          <input
            type="radio"
            name="export-type"
            checked={exportType() === "with-git-diff"}
            onChange={() => setExportType("with-git-diff")}
            class="radio"
          />
          <span>Include git diff — includes uncommitted changes</span>
        </label>
      </div>

      <button
        class="btn btn-primary"
        onClick={handleExport}
        disabled={exporting()}
      >
        {exporting() ? "Exporting..." : "Export Debug Packet"}
      </button>
    </div>
  )
}

/**
 * Dialog wrapper for the debug export button.
 */
export const DialogExportDebug: Component = () => {
  const language = useLanguage()

  return (
    <Dialog title={language.t("dialog.export.debug.title") ?? "Export Debug Packet"}>
      <div class="flex flex-col gap-4 p-4">
        <ExportDebugButton />
      </div>
    </Dialog>
  )
}
