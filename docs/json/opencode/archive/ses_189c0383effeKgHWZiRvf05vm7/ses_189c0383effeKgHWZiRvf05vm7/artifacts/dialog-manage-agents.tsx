import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { List } from "@opencode-ai/ui/list"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { showToast } from "@opencode-ai/ui/toast"
import type { Component } from "solid-js"
import { createMemo, createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { DialogEditAgent } from "./dialog-edit-agent"

const api = () => (typeof window !== "undefined" ? (window as unknown as Record<string, unknown>).api : undefined) as
  | {
      getCustomAgents?: () => Promise<unknown[]>
      setCustomAgents?: (agents: unknown[]) => Promise<void>
    }
  | undefined

export type AgentDef = {
  id: string
  name: string
  prompt: string
  description?: string
  model?: string
  variant?: string
  temperature?: number
  top_p?: number
  color?: string
  steps?: number
}

type AgentEntry = {
  source: "built-in" | "custom"
  name: string
  description?: string
  model?: string
  color?: string
  agentDef?: AgentDef
  builtinModel?: string
}

export const DialogManageAgents: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const sync = useSync()

  const [customAgents, setCustomAgents] = createSignal<AgentDef[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal<AgentDef | null>(null)

  // Load custom agents from electron-store
  if (!loaded()) {
    const a = api()
    if (a?.getCustomAgents) {
      setLoaded(true)
      a.getCustomAgents().then((agents) => {
        setCustomAgents((agents ?? []) as AgentDef[])
      })
    }
  }

  const builtinAgents = createMemo(() => {
    return (sync.data.agent ?? []).filter((a) => a.mode !== "subagent" && !a.hidden)
  })

  const agentList = createMemo(() => {
    const entries: AgentEntry[] = []
    const builtin = builtinAgents()
    for (const agent of builtin) {
      entries.push({
        source: "built-in",
        name: agent.name,
        description: agent.description,
        color: agent.color,
        builtinModel: agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : undefined,
      })
    }
    for (const agent of customAgents()) {
      entries.push({
        source: "custom",
        name: agent.name,
        description: agent.description,
        color: agent.color,
        model: agent.model,
        agentDef: agent,
      })
    }
    return entries
  })

  const saveCustomAgents = (agents: AgentDef[]) => {
    setCustomAgents(agents)
    api()?.setCustomAgents?.(agents)
  }

  const handleCreateAgent = () => {
    dialog.show(() => (
      <DialogEditAgent
        onSave={(agent) => {
          saveCustomAgents([...customAgents(), agent])
          showToast({
            title: language.t("dialog.agents.create"),
            description: `"${agent.name}" created`,
          })
        }}
      />
    ))
  }

  const handleEditAgent = (agent: AgentDef) => {
    dialog.show(() => (
      <DialogEditAgent
        agent={agent}
        onSave={(updated) => {
          saveCustomAgents(customAgents().map((a) => (a.id === updated.id ? updated : a)))
          showToast({
            title: language.t("dialog.agents.edit"),
            description: `"${updated.name}" saved`,
          })
        }}
      />
    ))
  }

  const handleDeleteAgent = (agent: AgentDef) => {
    setConfirmDelete(agent)
  }

  const handleConfirmDelete = () => {
    const agent = confirmDelete()
    if (!agent) return
    saveCustomAgents(customAgents().filter((a) => a.id !== agent.id))
    showToast({
      title: language.t("dialog.agents.delete"),
      description: `"${agent.name}" deleted`,
    })
    setConfirmDelete(null)
  }

  const handleCancelDelete = () => {
    setConfirmDelete(null)
  }

  const modelLabel = (entry: AgentEntry) => {
    if (entry.source === "built-in" && entry.builtinModel) return entry.builtinModel
    if (entry.source === "custom" && entry.model) return entry.model
    return undefined
  }

  return (
    <Dialog
      title={language.t("dialog.agents.manage")}
      description={language.t("dialog.agents.manage.description")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={handleCreateAgent}>
          {language.t("dialog.agents.create")}
        </Button>
      }
    >
      <List
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage="No agents found"
        key={(x) => `${x?.source}:${x?.name}`}
        items={agentList()}
        filterKeys={["name", "description", "model", "builtinModel"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        groupBy={(x) => x.source}
        groupHeader={(group) => {
          const label =
            group.category === "built-in"
              ? language.t("dialog.agents.source.builtin")
              : language.t("dialog.agents.source.custom")
          return <span>{label}</span>
        }}
        sortGroupsBy={(a) => (a.category === "built-in" ? 0 : 1)}
      >
        {(i) => (
          <div class="w-full flex items-center justify-between gap-x-3 min-h-10">
            <div class="flex items-center gap-3 min-w-0">
              <Show when={i.color}>
                <div class="size-3 shrink-0 rounded-full" style={{ "background-color": i.color }} />
              </Show>
              <Show when={!i.color}>
                <Icon name="brain" class="size-4 shrink-0 icon-strong-base" />
              </Show>
              <div class="flex flex-col min-w-0">
                <span class="text-14-medium text-text-strong truncate">{i.name}</span>
                <Show when={i.description}>
                  <span class="text-12-regular text-text-weak truncate">{i.description}</span>
                </Show>
              </div>
              <Show when={modelLabel(i)}>
                {(label) => (
                  <span class="text-12-regular text-text-weak shrink-0 ml-auto hidden sm:block">{label()}</span>
                )}
              </Show>
            </div>
            <Show when={i.source === "custom" && i.agentDef}>
              <Show when={confirmDelete()?.id === i.agentDef!.id} fallback={
                <div class="flex items-center gap-1 shrink-0">
                  <IconButton
                    icon="edit"
                    variant="ghost"
                    size="small"
                    onClick={() => handleEditAgent(i.agentDef!)}
                    aria-label={language.t("dialog.agents.edit")}
                  />
                  <IconButton
                    icon="trash"
                    variant="ghost"
                    size="small"
                    onClick={() => handleDeleteAgent(i.agentDef!)}
                    aria-label={language.t("dialog.agents.delete")}
                  />
                </div>
              }>
                <div class="flex items-center gap-1 shrink-0">
                  <span class="text-12-medium text-text-weak">{language.t("dialog.agents.delete.confirm")}</span>
                  <Button size="small" variant="ghost" class="text-text-danger-base" onClick={handleConfirmDelete}>
                    {language.t("common.delete")}
                  </Button>
                  <Button size="small" variant="ghost" onClick={handleCancelDelete}>
                    {language.t("common.cancel")}
                  </Button>
                </div>
              </Show>
            </Show>
          </div>
        )}
      </List>
    </Dialog>
  )
}
