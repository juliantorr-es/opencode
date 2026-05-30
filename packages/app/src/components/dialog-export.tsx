import { Component, createSignal } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"

export const DialogExport: Component = () => {
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()

  const [sanitize, setSanitize] = createSignal(true)
  const [exporting, setExporting] = createSignal(false)

  const handleExport = async () => {
    const sessionID = params.id
    if (!sessionID) return

    if (!platform.sessionExportData) {
      showToast({ title: language.t("toast.session.export.failed.title"), variant: "error" })
      return
    }

    setExporting(true)
    try {
      // Fetch session info and messages via SDK
      const infoRes = await sdk.client.session.get({ sessionID })
      if (!infoRes.data) {
        showToast({ title: language.t("toast.session.export.failed.title"), variant: "error" })
        return
      }
      const msgsRes = await sdk.client.session.messages({ sessionID, limit: 500 })
      const messages = msgsRes.data ?? []

      if (messages.length >= 500) {
        showToast({
          title: language.t("toast.session.export.truncated.title"),
          description: language.t("toast.session.export.truncated.description"),
        })
      }

      // Build export payload
      const session = sanitize()
        ? {
            id: infoRes.data.id,
            slug: infoRes.data.slug,
            projectID: infoRes.data.projectID,
            workspaceID: infoRes.data.workspaceID,
            directory: infoRes.data.directory,
            parentID: infoRes.data.parentID,
            title: infoRes.data.title,
            agent: infoRes.data.agent,
            model: infoRes.data.model,
            version: infoRes.data.version,
            summary: infoRes.data.summary,
            cost: infoRes.data.cost,
            tokens: infoRes.data.tokens,
            time: infoRes.data.time,
            revert: infoRes.data.revert,
          }
        : infoRes.data

      const data = {
        version: "1" as const,
        exportedAt: Date.now(),
        sanitized: sanitize(),
        session,
        messages,
      }

      const result = await platform.sessionExportData(JSON.stringify(data, null, 2), {
        title: language.t("dialog.export.title"),
        defaultPath: `${infoRes.data.title ?? "session"}.opencode-session`,
        filters: [{ name: language.t("dialog.export.format"), extensions: ["opencode-session"] }],
      })

      if (result === null) return // cancelled
      if (typeof result === "object" && "error" in result) {
        showToast({ title: language.t("toast.session.export.failed.title"), description: result.error, variant: "error" })
        return
      }

      showToast({
        title: language.t("toast.session.export.success.title"),
        description: language.t("toast.session.export.success.description"),
        variant: "success",
      })
      dialog.close()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("toast.session.export.failed.title"), description: message, variant: "error" })
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog title={language.t("dialog.export.title")}>
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-weak">{language.t("dialog.export.description")}</p>
        <label class="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={sanitize()}
            onChange={(e) => setSanitize(e.currentTarget.checked)}
            class="checkbox"
          />
          <span class="text-sm">{language.t("dialog.export.sanitize")}</span>
        </label>
        <button
          class="btn btn-primary"
          onClick={handleExport}
          disabled={exporting()}
        >
          {exporting() ? language.t("dialog.export.exporting") : language.t("dialog.export.button")}
        </button>
      </div>
    </Dialog>
  )
}
