import { Component, createSignal } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"

export const DialogImport: Component = () => {
  const navigate = useNavigate()
  const sdk = useSDK()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()

  const [fileContent, setFileContent] = createSignal<{
    title: string
    messageCount: number
    sanitized: boolean
    exportedAt: number
  } | null>(null)
  const [rawData, setRawData] = createSignal<unknown>(null)
  const [importing, setImporting] = createSignal(false)

  const handleSelectFile = async () => {
    if (!platform.sessionImportFile) {
      showToast({ title: language.t("toast.session.import.failed.title"), variant: "error" })
      return
    }

    try {
      const content = await platform.sessionImportFile({
        title: language.t("dialog.import.title"),
        filters: [{ name: language.t("dialog.export.format"), extensions: ["opencode-session"] }],
      })

      // C6: null guard — cancelled by user, no-op
      if (content === null) return

      // Handle structured error from IPC
      if (typeof content === "object" && "error" in content) {
        showToast({
          title: language.t("toast.session.import.failed.title"),
          description: content.error,
          variant: "error",
        })
        return
      }

      const data = JSON.parse(content as string)
      if (!data || !data.session || !data.messages) {
        showToast({ title: language.t("toast.session.import.invalid.title"), variant: "error" })
        return
      }

      setFileContent({
        title: data.session.title ?? "Untitled",
        messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
        sanitized: data.sanitized ?? false,
        exportedAt: data.exportedAt ?? Date.now(),
      })
      setRawData(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({
        title: language.t("toast.session.import.invalid.title"),
        description: message,
        variant: "error",
      })
    }
  }

  const handleImport = async () => {
    const data = rawData()
    if (!data) return

    setImporting(true)
    try {
      const res = await fetch(`${sdk.url}/session/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        showToast({
          title: language.t("toast.session.import.failed.title"),
          description: (errBody as { message?: string }).message ?? `HTTP ${res.status}`,
          variant: "error",
        })
        return
      }

      const imported = await res.json()
      showToast({
        title: language.t("toast.session.import.success.title"),
        description: language.t("toast.session.import.success.description"),
        variant: "success",
      })
      dialog.close()
      navigate(`/${sdk.directory}/session/${imported.id}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({
        title: language.t("toast.session.import.failed.title"),
        description: message,
        variant: "error",
      })
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog title={language.t("dialog.import.title")}>
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-weak">{language.t("dialog.import.description")}</p>

        {!fileContent() ? (
          <button class="btn btn-secondary" onClick={handleSelectFile}>
            {language.t("dialog.import.selectFile")}
          </button>
        ) : (
          <div class="flex flex-col gap-2">
            <p class="text-sm">
              {language.t("dialog.import.selected", { filename: fileContent()!.title })}
            </p>
            <p class="text-xs text-text-weak">
              {fileContent()!.messageCount} messages
              {fileContent()!.sanitized ? " (sanitized)" : ""}
            </p>
            <div class="flex gap-2">
              <button
                class="btn btn-secondary"
                onClick={() => {
                  setFileContent(null)
                  setRawData(null)
                }}
              >
                {language.t("dialog.import.selectFile")}
              </button>
              <button
                class="btn btn-primary"
                onClick={handleImport}
                disabled={importing()}
              >
                {importing() ? language.t("dialog.import.importing") : language.t("dialog.import.button")}
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}
