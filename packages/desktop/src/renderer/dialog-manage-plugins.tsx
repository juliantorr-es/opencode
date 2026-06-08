import { Component, createSignal, For, Show } from "solid-js"
import { t } from "./i18n"
import { Dialog } from "@tribunus/ui/dialog"
import { Button } from "@tribunus/ui/button"
import { Switch } from "@tribunus/ui/switch"
import { TextField } from "@tribunus/ui/text-field"
import type { PluginConfigEntry } from "../preload/types"

type ViewMode = "list" | "install"

function isValidNpmName(name: string): boolean {
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)
}

function isValidFilePath(path: string): boolean {
  return path.length > 0
}

export const DialogManagePlugins: Component = () => {
  const [configs, setConfigs] = createSignal<PluginConfigEntry[]>([])
  const [dropped, setDropped] = createSignal(0)
  const [loading, setLoading] = createSignal(true)
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null)
  const [mode, setMode] = createSignal<ViewMode>("list")

  // Install form state
  const [installNpmName, setInstallNpmName] = createSignal("")
  const [installFilePath, setInstallFilePath] = createSignal("")
  const [installMode, setInstallMode] = createSignal<"npm" | "file">("npm")
  const [installError, setInstallError] = createSignal<string | null>(null)
  const [installing, setInstalling] = createSignal(false)

  const loadConfigs = async () => {
    setLoading(true)
    try {
      const result = await window.api.getDesktopPluginConfig?.()
      setConfigs(result.configs)
      setDropped(result.dropped)
    } catch (e) {
      console.warn("Failed to load plugin configs:", e)
      setConfigs([])
      setDropped(0)
    } finally {
      setLoading(false)
    }
  }

  const toggleEnabled = async (name: string, current: boolean) => {
    try {
      const fresh = await window.api.getDesktopPluginConfig?.()
      if (!fresh) return
      const updated = fresh.configs.map((c) => (c.name === name ? { ...c, enabled: !current } : c))
      const result = await window.api.setDesktopPluginConfig?.(updated)
      if (result) {
        setConfigs(result.configs)
        setDropped(result.dropped)
      }
    } catch {
      await loadConfigs()
    }
  }

  const removePlugin = async (name: string) => {
    try {
      const fresh = await window.api.getDesktopPluginConfig?.()
      if (!fresh) return
      const filtered = fresh.configs.filter((c) => c.name !== name)
      const result = await window.api.setDesktopPluginConfig?.(filtered)
      if (result) {
        setConfigs(result.configs)
        setDropped(result.dropped)
      }
    } catch {
      await loadConfigs()
    }
    setConfirmRemove(null)
  }

  const openInstallForm = () => {
    setInstallNpmName("")
    setInstallFilePath("")
    setInstallError(null)
    setInstalling(false)
    setMode("install")
  }

  const cancelInstall = () => {
    setMode("list")
    setInstallError(null)
  }

  const submitInstall = async () => {
    setInstallError(null)

    const name = installMode() === "npm" ? installNpmName().trim() : installFilePath().trim()
    if (!name) {
      setInstallError(t("desktop.plugin.install.invalidNpmName"))
      return
    }

    if (installMode() === "npm" && !isValidNpmName(name)) {
      setInstallError(t("desktop.plugin.install.invalidNpmName"))
      return
    }

    if (installMode() === "file" && !isValidFilePath(name)) {
      setInstallError(t("desktop.plugin.install.invalidFilePath"))
      return
    }

    setInstalling(true)
    try {
      const fresh = await window.api.getDesktopPluginConfig?.()
      if (!fresh) {
        setInstallError("Failed to load plugin config")
        setInstalling(false)
        return
      }

      // Check for duplicate using fresh state
      if (fresh.configs.some((c) => c.name === name)) {
        setInstallError(t("desktop.plugin.install.duplicateName"))
        setInstalling(false)
        return
      }

      const newEntry: PluginConfigEntry = {
        name,
        path: installMode() === "npm" ? name : name,
        enabled: true,
      }
      const updated = [...fresh.configs, newEntry]
      const result = await window.api.setDesktopPluginConfig?.(updated)
      if (!result) {
        setInstallError("Failed to install plugin")
        return
      }
      setConfigs(result.configs)
      setDropped(result.dropped)
      setMode("list")
    } catch {
      setInstallError("Failed to install plugin")
    } finally {
      setInstalling(false)
    }
  }

  const openFilePicker = async () => {
    try {
      const result = await window.api.openDirectoryPicker?.()
      if (result && typeof result === "string") {
        setInstallFilePath(result)
        setInstallMode("file")
      }
    } catch {
      // ignore
    }
  }

  // Load configs on mount
  ;(async () => await loadConfigs())()

  return (
    <>
    <Show when={mode() === "list"}>
      <Dialog title={t("desktop.plugin.manage.title")} description={t("desktop.plugin.manage.description")}>
        <Show when={dropped() > 0}>
          <div class="px-4 py-2 mb-2 text-sm text-amber-11 bg-amber-3 rounded-md border border-amber-6" role="alert">
            <span>{t("desktop.plugin.config.dataLossWarning")}</span>
          </div>
        </Show>

        <Show when={loading()}>
          <div class="flex items-center justify-center py-8">
            <span class="text-sm text-gray-11">Loading...</span>
          </div>
        </Show>

        <Show when={!loading() && configs().length === 0}>
          <div class="flex flex-col items-center justify-center py-8 gap-3">
            <span class="text-sm text-gray-11">{t("desktop.plugin.list.empty")}</span>
            <Button onClick={openInstallForm}>{t("desktop.plugin.install.install")}</Button>
          </div>
        </Show>

        <Show when={!loading() && configs().length > 0}>
          <div class="px-4 py-2 border-b border-gray-6 flex justify-end">
            <Button size="small" onClick={openInstallForm}>
              {t("desktop.plugin.install.install")}
            </Button>
          </div>
          <div class="divide-y divide-gray-6">
            <For each={configs()}>
              {(entry) => (
                <div class="flex items-center justify-between px-4 py-3">
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium truncate">{entry.name}</div>
                    <div class="text-xs text-gray-11 truncate">{entry.path}</div>
                  </div>
                  <div class="flex items-center gap-2 ml-3">
                    <Switch
                      checked={entry.enabled}
                      onChange={() => toggleEnabled(entry.name, entry.enabled)}
                      label={entry.enabled ? t("desktop.plugin.list.enabled") : t("desktop.plugin.list.disabled")}
                    />
                    <Show when={confirmRemove() === entry.name}>
                      <div class="flex items-center gap-1">
                        <Button size="small" variant="secondary" onClick={() => removePlugin(entry.name)}>
                          Confirm
                        </Button>
                        <Button size="small" variant="ghost" onClick={() => setConfirmRemove(null)}>
                          ✕
                        </Button>
                      </div>
                    </Show>
                    <Show when={confirmRemove() !== entry.name}>
                      <Button
                        size="small"
                        variant="ghost"
                        title={t("desktop.plugin.list.remove")}
                        onClick={() => setConfirmRemove(entry.name)}
                      >
                        ✕
                      </Button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Dialog>
    </Show>

    <Show when={mode() === "install"}>
      <Dialog title={t("desktop.plugin.install.title")}>
        <div class="p-4 space-y-4">
          <Show when={installError()}>
            <div class="text-sm text-red-11 bg-red-3 px-3 py-2 rounded-md border border-red-6" role="alert">
              {installError()}
            </div>
          </Show>

          <div class="flex gap-2">
            <Button
              size="small"
              variant={installMode() === "npm" ? "primary" : "ghost"}
              onClick={() => setInstallMode("npm")}
            >
              npm
            </Button>
            <Button
              size="small"
              variant={installMode() === "file" ? "primary" : "ghost"}
              onClick={() => setInstallMode("file")}
            >
              File
            </Button>
          </div>

          <Show when={installMode() === "npm"}>
            <TextField
              label={t("desktop.plugin.install.npmLabel")}
              placeholder={t("desktop.plugin.install.npmPlaceholder")}
              value={installNpmName()}
              onInput={(e: any) => setInstallNpmName(e.target.value)}
            />
          </Show>

          <Show when={installMode() === "file"}>
            <div class="flex gap-2 items-end">
              <TextField
                label={t("desktop.plugin.install.fileLabel")}
                placeholder="/path/to/plugin"
                value={installFilePath()}
                onInput={(e: any) => setInstallFilePath(e.target.value)}
                class="flex-1"
              />
              <Button size="small" variant="secondary" onClick={openFilePicker}>
                {t("desktop.plugin.install.browse")}
              </Button>
            </div>
          </Show>

          <div class="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={cancelInstall} disabled={installing()}>
              {t("desktop.plugin.install.cancel")}
            </Button>
            <Button onClick={submitInstall} disabled={installing()}>
              {installing() ? "Installing..." : t("desktop.plugin.install.install")}
            </Button>
          </div>
        </div>
      </Dialog>
    </Show>
    </>
  )
}
