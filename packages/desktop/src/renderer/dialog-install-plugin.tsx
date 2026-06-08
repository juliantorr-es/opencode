import { Component, createSignal, Show } from "solid-js"
import { t } from "./i18n"
import { Dialog } from "@tribunus/ui/dialog"
import { Button } from "@tribunus/ui/button"
import { TextField } from "@tribunus/ui/text-field"
import type { PluginConfigEntry } from "../preload/types"

function isValidNpmName(name: string): boolean {
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)
}

export type DialogInstallPluginProps = {
  onInstalled?: () => void
}

export const DialogInstallPlugin: Component<DialogInstallPluginProps> = (props) => {
  const [mode, setMode] = createSignal<"npm" | "file">("npm")
  const [npmName, setNpmName] = createSignal("")
  const [filePath, setFilePath] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)
  const [installing, setInstalling] = createSignal(false)

  const reset = () => {
    setNpmName("")
    setFilePath("")
    setError(null)
    setInstalling(false)
    setMode("npm")
  }

  const openFilePicker = async () => {
    try {
      const result = await window.api.openDirectoryPicker?.()
      if (result && typeof result === "string") {
        setFilePath(result)
        setMode("file")
      }
    } catch {
      // ignore
    }
  }

  const submit = async () => {
    setError(null)

    const name = mode() === "npm" ? npmName().trim() : filePath().trim()
    if (!name) {
      setError(
        mode() === "npm"
          ? t("desktop.plugin.install.invalidNpmName")
          : t("desktop.plugin.install.invalidFilePath"),
      )
      return
    }

    if (mode() === "npm" && !isValidNpmName(name)) {
      setError(t("desktop.plugin.install.invalidNpmName"))
      return
    }

    if (mode() === "file" && !name) {
      setError(t("desktop.plugin.install.invalidFilePath"))
      return
    }

    setInstalling(true)
    try {
      const current = await window.api.getDesktopPluginConfig?.()

      // Check for duplicate name
      if (current.configs.some((c) => c.name === name)) {
        setError(t("desktop.plugin.install.duplicateName"))
        setInstalling(false)
        return
      }

      const newEntry: PluginConfigEntry = {
        name,
        path: name,
        enabled: true,
      }

      const updated = [...current.configs, newEntry]
      await window.api.setDesktopPluginConfig?.(updated)
      props.onInstalled?.()
    } catch {
      setError("Failed to install plugin")
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Dialog title={t("desktop.plugin.install.title")}>
      <div class="p-4 space-y-4">
        <Show when={error()}>
          <div class="text-sm text-red-11 bg-red-3 px-3 py-2 rounded-md border border-red-6" role="alert">
            {error()}
          </div>
        </Show>

        <div class="flex gap-2">
          <Button
            size="small"
            variant={mode() === "npm" ? "primary" : "ghost"}
            onClick={() => setMode("npm")}
          >
            npm
          </Button>
          <Button
            size="small"
            variant={mode() === "file" ? "primary" : "ghost"}
            onClick={() => setMode("file")}
          >
            File
          </Button>
        </div>

        <Show when={mode() === "npm"}>
          <TextField
            label={t("desktop.plugin.install.npmLabel")}
            placeholder={t("desktop.plugin.install.npmPlaceholder")}
            value={npmName()}
            onInput={(e: any) => setNpmName(e.target.value)}
          />
        </Show>

        <Show when={mode() === "file"}>
          <div class="flex gap-2 items-end">
            <TextField
              label={t("desktop.plugin.install.fileLabel")}
              placeholder="/path/to/plugin"
              value={filePath()}
              onInput={(e: any) => setFilePath(e.target.value)}
              class="flex-1"
            />
            <Button size="small" variant="secondary" onClick={openFilePicker}>
              {t("desktop.plugin.install.browse")}
            </Button>
          </div>
        </Show>

        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={reset} disabled={installing()}>
            {t("desktop.plugin.install.cancel")}
          </Button>
          <Button onClick={submit} disabled={installing()}>
            {installing() ? "Installing..." : t("desktop.plugin.install.install")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
