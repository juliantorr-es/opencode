import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import type { Component } from "solid-js"
import { createMemo, createSignal, onMount, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { DialogEditAgent } from "./dialog-edit-agent"
import type { AgentDef } from "@/types/agent"

const api = () => (typeof window !== "undefined" ? (window as unknown as Record<string, unknown>).api : undefined) as
  | {
      getCustomAgents?: () => Promise<unknown[]>
      setCustomAgents?: (agents: unknown[]) => Promise<void>
      deleteCustomAgent?: (id: string) => Promise<void>
    }
  | undefined

let writeQueue: Promise<void> = Promise.resolve()

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

  const [customAgents, setCustomAgents] = createSignal<AgentDef[]>([])
  const [query, setQuery] = createSignal("")
  const [confirmDelete, setConfirmDelete] = createSignal<AgentDef | null>(null)
  const [isSaving, setIsSaving] = createSignal(false)
  const [isDeleting, setIsDeleting] = createSignal(false)

  onMount(() => {
    const a = api()
    if (a?.getCustomAgents) {
      a
        .getCustomAgents()
        .then((agents) => {
          setCustomAgents((agents ?? []) as AgentDef[])
        })
        .catch((err) => console.error("Failed to load custom agents:", err))
    }
  })

  const matchesQuery = (entry: AgentEntry) => {
    const q = query().trim().toLowerCase()
    if (!q) return true
    return [entry.name, entry.description, entry.model, entry.builtinModel].some((value) =>
      value?.toLowerCase().includes(q),
    )
  }

  const builtinEntries = createMemo(() => [] as AgentEntry[])

  const customEntries = createMemo(() =>
    customAgents()
      .map((agent) => ({
        source: "custom" as const,
        name: agent.name,
        description: agent.description,
        color: agent.color,
        model: agent.model,
        agentDef: agent,
      }))
      .filter(matchesQuery)
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const saveCustomAgents = async (agents: AgentDef[]) => {
    setIsSaving(true)
    const prev = customAgents()
    setCustomAgents(agents)
    const task = writeQueue.then(async () => {
      const a = api()
      if (a?.setCustomAgents) {
        await a.setCustomAgents(agents)
      }
    })
    writeQueue = task.catch(() => {})
    try {
      await task
    } catch (err) {
      setCustomAgents(prev)
      showToast({
        title: language.t("dialog.agents.save.failed"),
        description: "Failed to save custom agents — changes not persisted",
      })
      console.error("Failed to save custom agents:", err)
    } finally {
      setIsSaving(false)
    }
  }

  const handleCreateAgent = () => {
    dialog.show(() => (
      <DialogEditAgent
        onSave={async (agent) => {
          await saveCustomAgents([...customAgents(), agent])
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
        onSave={async (updated) => {
          await saveCustomAgents(customAgents().map((a) => (a.id === updated.id ? updated : a)))
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

  const handleConfirmDelete = async () => {
    const agent = confirmDelete()
    if (!agent) return
    setIsDeleting(true)
    setConfirmDelete(null)
    try {
      const a = api()
      if (a?.deleteCustomAgent) {
        await a.deleteCustomAgent(agent.id)
        setCustomAgents(customAgents().filter((a) => a.id !== agent.id))
      } else {
        await saveCustomAgents(customAgents().filter((a) => a.id !== agent.id))
      }
      showToast({
        title: language.t("dialog.agents.delete"),
        description: `"${agent.name}" deleted`,
      })
    } catch (err) {
      showToast({
        title: language.t("dialog.agents.delete.failed"),
        description: "Failed to delete custom agent — changes not persisted",
      })
      console.error("Failed to delete custom agent:", err)
    } finally {
      setIsDeleting(false)
    }
  }

  const handleCancelDelete = () => {
    setConfirmDelete(null)
  }

  const modelLabel = (entry: AgentEntry) => {
    if (entry.source === "custom" && entry.model) return entry.model
    return undefined
  }

  return (
    <Dialog
      title={language.t("dialog.agents.manage")}
      description={language.t("dialog.agents.manage.description")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={handleCreateAgent} disabled={isSaving()}>
          {language.t("dialog.agents.create")}
        </Button>
      }
    >
      <div class="px-5 pb-3">
        <TextField
          type="text"
          value={query()}
          onChange={setQuery}
          placeholder={language.t("common.search.placeholder")}
          autofocus
        />
      </div>
      <div class="px-5 pb-5 flex flex-col gap-5">
        <AgentSection
          label={language.t("dialog.agents.source.custom")}
          entries={customEntries()}
          modelLabel={modelLabel}
          confirmDelete={confirmDelete}
          isDeleting={isDeleting}
          onEdit={handleEditAgent}
          onDelete={handleDeleteAgent}
          onConfirmDelete={handleConfirmDelete}
          onCancelDelete={handleCancelDelete}
        />
        <Show when={builtinEntries().length === 0 && customEntries().length === 0}>
          <div class="text-12-regular text-text-weak">No agents found</div>
        </Show>
      </div>
    </Dialog>
  )
}

type AgentSectionProps = {
  label: string
  entries: AgentEntry[]
  modelLabel: (entry: AgentEntry) => string | undefined
  confirmDelete?: () => AgentDef | null
  isDeleting?: () => boolean
  onEdit?: (agent: AgentDef) => void
  onDelete?: (agent: AgentDef) => void
  onConfirmDelete?: () => Promise<void>
  onCancelDelete?: () => void
}

function AgentSection(props: AgentSectionProps) {
  const deletingAgent = props.confirmDelete?.()

  return (
    <div class="flex flex-col gap-2">
      <div class="text-12-medium uppercase tracking-wide text-text-weak">{props.label}</div>
      <div class="flex flex-col gap-2">
        <Show
          when={props.entries.length > 0}
          fallback={<div class="text-12-regular text-text-weak">No agents found</div>}
        >
          <For each={props.entries}>
            {(i) => (
              <div class="w-full flex items-center justify-between gap-x-3 min-h-10 rounded-md border border-border-weak-base px-3 py-2">
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
                  <Show when={props.modelLabel(i)}>
                    {(label) => (
                      <span class="text-12-regular text-text-weak shrink-0 ml-auto hidden sm:block">{label()}</span>
                    )}
                  </Show>
                </div>
                <Show when={i.source === "custom" && i.agentDef}>
                  <Show
                    when={deletingAgent?.id === i.agentDef!.id}
                    fallback={
                      <div class="flex items-center gap-1 shrink-0">
                        <IconButton
                          icon="edit"
                          variant="ghost"
                          size="small"
                          onClick={() => props.onEdit?.(i.agentDef!)}
                          aria-label="Edit"
                        />
                        <IconButton
                          icon="trash"
                          variant="ghost"
                          size="small"
                          onClick={() => props.onDelete?.(i.agentDef!)}
                          aria-label="Delete"
                        />
                      </div>
                    }
                  >
                    <div class="flex items-center gap-1 shrink-0">
                      <span class="text-12-medium text-text-weak">Delete?</span>
                      <Button
                        size="small"
                        variant="ghost"
                        class="text-text-danger-base"
                        onClick={() => void props.onConfirmDelete?.()}
                        disabled={props.isDeleting?.()}
                      >
                        Delete
                      </Button>
                      <Button size="small" variant="ghost" onClick={props.onCancelDelete}>
                        Cancel
                      </Button>
                    </div>
                  </Show>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}

function isAgentDef(value: unknown): value is AgentDef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const agent = value as Record<string, unknown>
  return typeof agent.id === "string" && typeof agent.name === "string" && typeof agent.prompt === "string"
}
