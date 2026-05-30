import { useMutation, useQueryClient } from "@tanstack/solid-query"
import { Component, createMemo, createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { useLanguage } from "@/context/language"
import { useQueryOptions } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import type { McpRemoteConfig } from "@opencode-ai/sdk/v2/client"
import { DialogEditMcp } from "./dialog-edit-mcp"
import type { McpServerEntry } from "@/types/mcp"

const statusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  needs_client_registration: "mcp.status.needs_client_registration",
  disabled: "mcp.status.disabled",
} as const

function McpHealthIndicator(props: { status?: string }) {
  return (
    <div
      classList={{
        "size-1.5 rounded-full shrink-0": true,
        "bg-icon-success-base": props.status === "connected",
        "bg-icon-critical-base": props.status === "failed",
        "bg-icon-warning-base":
          props.status === "needs_auth" || props.status === "needs_client_registration",
        "bg-border-weak-base": !props.status || props.status === "disabled",
      }}
    />
  )
}

type FormMode = "list" | "add"

export const DialogSelectMcp: Component = () => {
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()
  const queryClient = useQueryClient()
  const queryOptions = useQueryOptions()

  const [store, setStore] = createStore({
    mode: "list" as FormMode,
    addForm: {
      name: "",
      url: "",
      error: "",
    },
  })

  const [editingEntry, setEditingEntry] = createSignal<McpServerEntry | undefined>()
  const [confirmDelete, setConfirmDelete] = createSignal<string | undefined>()

  const handleEdit = async (name: string) => {
    try {
      const api = (window as any).api
      const servers = await api?.getMcpServers?.()
      const entry = servers?.find((s: any) => s.name === name)
      if (entry) {
        setEditingEntry(entry)
      }
    } catch (e) {
      console.warn("Failed to load server config for edit:", e)
    }
  }

  const confirmRemove = async () => {
    const name = confirmDelete()
    if (!name) return
    try {
      await sdk.client.mcp.disconnect({ name })
    } catch (e) {
      console.warn("Disconnect failed:", e)
    }
    try {
      await sdk.client.mcp.auth.remove({ name })
    } catch (e) {
      // auth.remove may not exist — that's ok
    }
    try {
      const api = (window as any).api
      const servers = await api?.getMcpServers?.()
      if (servers) {
        await api?.setMcpServers?.(servers.filter((s: any) => s.name !== name))
      }
    } catch (e) {
      console.warn("Failed to remove from store:", e)
    }
    await queryClient.refetchQueries(queryOptions.mcp(pathKey(sync.directory)))
    setConfirmDelete(undefined)
  }

  const cancelDelete = () => {
    setConfirmDelete(undefined)
  }

  const items = createMemo(() =>
    Object.entries(sync.data.mcp ?? {})
      .map(([name, status]) => ({ name, status: status.status }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const toggle = useMutation(() => ({
    mutationFn: async (name: string) => {
      const status = sync.data.mcp[name]
      if (status?.status === "connected") {
        await sdk.client.mcp.disconnect({ name })
        return
      }
      if (status?.status === "needs_auth") {
        await sdk.client.mcp.auth.authenticate({ name })
        return
      }
      await sdk.client.mcp.connect({ name })
    },
    onSuccess: () => queryClient.refetchQueries(queryOptions.mcp(pathKey(sync.directory))),
  }))

  const addMutation = useMutation(() => ({
    mutationFn: async (input: { name: string; url: string }) => {
      const config: McpRemoteConfig = {
        type: "remote",
        url: input.url,
        enabled: true,
      }
      await sdk.client.mcp.add({ name: input.name, config })
    },
    onSuccess: () => {
      setStore("addForm", { name: "", url: "", error: "" })
      setStore("mode", "list")
      queryClient.refetchQueries(queryOptions.mcp(pathKey(sync.directory)))
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      setStore("addForm", "error", message)
    },
  }))

  const disconnectMutation = useMutation(() => ({
    mutationFn: async (name: string) => {
      const status = sync.data.mcp[name]
      if (status?.status === "connected") {
        await sdk.client.mcp.disconnect({ name })
      }
    },
    onSuccess: () => queryClient.refetchQueries(queryOptions.mcp(pathKey(sync.directory))),
  }))

  const enabledCount = createMemo(() => items().filter((i) => i.status === "connected").length)
  const totalCount = createMemo(() => items().length)

  const isFormMode = createMemo(() => store.mode !== "list")

  const startAdd = () => {
    setStore("mode", "add")
    setStore("addForm", { name: "", url: "", error: "" })
  }

  const resetForm = () => {
    setStore("mode", "list")
  }

  const submitAdd = () => {
    if (addMutation.isPending) return
    const name = store.addForm.name.trim()
    if (!name) {
      setStore("addForm", "error", "Server name is required")
      return
    }
    const url = store.addForm.url.trim()
    if (!url) {
      setStore("addForm", "error", "Server URL is required")
      return
    }
    addMutation.mutate({ name, url })
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      resetForm()
      return
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    submitAdd()
  }

  const formTitle = createMemo(() => {
    if (!isFormMode()) return language.t("dialog.mcp.title")
    return (
      <div class="flex items-center gap-2 -ml-2">
        <IconButton
          icon="arrow-left"
          variant="ghost"
          onClick={resetForm}
          aria-label={language.t("common.goBack")}
        />
        <span>Add MCP Server</span>
      </div>
    )
  })

  const handleRemove = (name: string) => {
    setConfirmDelete(name)
  }

  return (
    <Dialog
      title={formTitle()}
      description={
        !isFormMode()
          ? language.t("dialog.mcp.description", { enabled: enabledCount(), total: totalCount() })
          : undefined
      }
    >
      <Show
        when={!isFormMode()}
        fallback={
          <div class="flex flex-col gap-4 px-5">
            <div class="bg-surface-base rounded-md p-5 flex flex-col gap-3">
              <TextField
                autofocus
                type="text"
                label="Server name"
                placeholder="my-mcp-server"
                value={store.addForm.name}
                validationState={store.addForm.error ? "invalid" : "valid"}
                disabled={addMutation.isPending}
                onChange={(v) => setStore("addForm", "name", v)}
                onKeyDown={handleKeyDown}
              />
              <TextField
                type="text"
                label="Server URL"
                placeholder="http://localhost:3000"
                value={store.addForm.url}
                validationState={store.addForm.error ? "invalid" : "valid"}
                disabled={addMutation.isPending}
                onChange={(v) => setStore("addForm", "url", v)}
                onKeyDown={handleKeyDown}
              />
              <Show when={store.addForm.error}>
                <span class="text-12-regular text-text-critical">{store.addForm.error}</span>
              </Show>
            </div>
          </div>
        }
      >
        <List
          search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
          emptyMessage={language.t("dialog.mcp.empty")}
          key={(x) => x?.name ?? ""}
          items={items}
          filterKeys={["name", "status"]}
          sortBy={(a, b) => a.name.localeCompare(b.name)}
          onSelect={(x) => {
            if (!x || toggle.isPending) return
            toggle.mutate(x.name)
          }}
        >
          {(i) => {
            const mcpStatus = () => sync.data.mcp[i.name]
            const status = () => mcpStatus()?.status
            const statusLabel = () => {
              const key = status() ? statusLabels[status() as keyof typeof statusLabels] : undefined
              if (!key) return
              return language.t(key)
            }
            const error = () => {
              const s = mcpStatus()
              if (s?.status === "failed" || s?.status === "needs_client_registration") return s.error
            }
            const enabled = () => status() === "connected"
            return (
              <div class="w-full flex items-center justify-between gap-x-3 group/item">
                <div class="flex items-center gap-3 min-w-0 flex-1">
                  <McpHealthIndicator status={status()} />
                  <div class="flex flex-col gap-0.5 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="truncate">{i.name}</span>
                      <Show when={statusLabel()}>
                        <span class="text-11-regular text-text-weaker">{statusLabel()}</span>
                      </Show>
                    </div>
                    <Show when={error()}>
                      <span class="text-11-regular text-text-weaker truncate">{error()}</span>
                    </Show>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <DropdownMenu>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      class="shrink-0 size-8 hover:bg-surface-base-hover data-[expanded]:bg-surface-base-active opacity-0 group-hover/item:opacity-100 focus:opacity-100"
                      onClick={(e: MouseEvent) => e.stopPropagation()}
                      onPointerDown={(e: PointerEvent) => e.stopPropagation()}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <DropdownMenu.Item
                          onSelect={() => handleEdit(i.name)}
                        >
                          <DropdownMenu.ItemLabel>
                            {language.t("dialog.mcp.action.edit")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          onSelect={() => handleRemove(i.name)}
                          class="text-text-on-critical-base hover:bg-surface-critical-weak"
                        >
                          <DropdownMenu.ItemLabel>
                            {language.t("dialog.server.menu.delete")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                  <div role="presentation" onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={enabled()}
                      disabled={toggle.isPending && toggle.variables === i.name}
                      onChange={() => {
                        if (toggle.isPending) return
                        toggle.mutate(i.name)
                      }}
                    />
                  </div>
                </div>
              </div>
            )
          }}
        </List>
      </Show>

      <Show when={!isFormMode()}>
        <div class="shrink-0 px-5 pb-5 pt-2">
          <Button
            variant="secondary"
            icon="plus-small"
            size="large"
            onClick={startAdd}
            class="py-1.5 pl-1.5 pr-3 flex items-center gap-1.5"
          >
            Add MCP Server
          </Button>
        </div>
      </Show>
      <Show when={store.mode === "add"}>
        <div class="shrink-0 px-5 pb-5 pt-2">
          <Button
            variant="primary"
            size="large"
            onClick={submitAdd}
            disabled={addMutation.isPending}
            class="px-3 py-1.5"
          >
            {addMutation.isPending ? language.t("dialog.server.add.checking") : "Add Server"}
          </Button>
        </div>
      </Show>
      <Show when={editingEntry()}>
        <DialogEditMcp
          entry={editingEntry()}
          onSave={async (entry) => {
            try {
              const api = (window as any).api
              const servers = (await api?.getMcpServers?.()) ?? []
              const existing = servers.findIndex((s: any) => s.name === entry.name)
              if (existing >= 0) {
                servers[existing] = entry
              } else {
                servers.push(entry)
              }
              await api?.setMcpServers?.(servers)
              await sdk.client.mcp.add({ name: entry.name, config: entry.config })
              await queryClient.refetchQueries(queryOptions.mcp(pathKey(sync.directory)))
            } catch (e) {
              console.warn("Failed to persist edited server:", e)
            }
            setEditingEntry(undefined)
          }}
          onCancel={() => setEditingEntry(undefined)}
        />
      </Show>
      <Show when={confirmDelete()}>
        {(name) => (
          <div class="flex items-center gap-2 p-3 bg-surface-stronger-base rounded-lg mx-5 mb-4">
            <span class="text-14-regular text-text-base">Remove "{name()}"?</span>
            <Button size="small" variant="ghost" onClick={cancelDelete}>Cancel</Button>
            <Button size="small" variant="ghost" class="text-text-danger-base" onClick={confirmRemove}>Delete</Button>
          </div>
        )}
      </Show>
    </Dialog>
  )
}
