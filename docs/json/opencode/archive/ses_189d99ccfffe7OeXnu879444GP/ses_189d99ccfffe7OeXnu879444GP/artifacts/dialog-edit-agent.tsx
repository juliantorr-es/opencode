import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { Select } from "@opencode-ai/ui/select"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import type { AgentDef } from "./dialog-manage-agents"

type ModelOption = { label: string; value: string }

type Props = {
  agent?: AgentDef
  onSave: (agent: AgentDef) => void
}

const AGENT_COLORS = [
  "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899",
  "#f43f5e", "#ef4444", "#f97316", "#eab308", "#84cc16",
  "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
] as const

export function DialogEditAgent(props: Props) {
  const dialog = useDialog()
  const language = useLanguage()
  const providers = useProviders()

  const [name, setName] = createSignal(props.agent?.name ?? "")
  const [prompt, setPrompt] = createSignal(props.agent?.prompt ?? "")
  const [description, setDescription] = createSignal(props.agent?.description ?? "")
  const [model, setModel] = createSignal(props.agent?.model ?? "")
  const [variant, setVariant] = createSignal(props.agent?.variant ?? "")
  const [temperature, setTemperature] = createSignal(props.agent?.temperature?.toString() ?? "")
  const [topP, setTopP] = createSignal(props.agent?.top_p?.toString() ?? "")
  const [color, setColor] = createSignal(props.agent?.color ?? "")

  const connectedProviders = createMemo(() => providers.connected())

  const modelOptions = createMemo<ModelOption[]>(() => {
    const options: ModelOption[] = []
    for (const provider of connectedProviders()) {
      for (const model of Object.values(provider.models)) {
        options.push({
          label: `${provider.name} / ${model.name || model.id}`,
          value: `${provider.id}/${model.id}`,
        })
      }
    }
    return options
  })

  const currentModel = createMemo(() => {
    const val = model()
    if (!val) return undefined
    return modelOptions().find((o) => o.value === val)
  })

  const handleSave = () => {
    const id = props.agent?.id ?? crypto.randomUUID()
    const temp = temperature() ? Number.parseFloat(temperature()) : undefined
    const tp = topP() ? Number.parseFloat(topP()) : undefined
    props.onSave({
      id,
      name: name(),
      prompt: prompt(),
      description: description() || undefined,
      model: model() || undefined,
      variant: variant() || undefined,
      temperature: temp && !Number.isNaN(temp) ? temp : undefined,
      top_p: tp && !Number.isNaN(tp) ? tp : undefined,
      color: color() || undefined,
    })
    dialog.close()
  }

  return (
    <Dialog
      title={props.agent ? language.t("dialog.agents.edit") : language.t("dialog.agents.create")}
      class="w-full max-w-[480px] mx-auto"
    >
      <div class="flex flex-col gap-5 p-6 pt-0">
        <TextField
          autofocus
          type="text"
          label={language.t("dialog.agents.name")}
          placeholder="My Agent"
          value={name()}
          onChange={setName}
        />

        <TextField
          multiline
          label={language.t("dialog.agents.prompt")}
          placeholder="You are a helpful assistant..."
          value={prompt()}
          onChange={setPrompt}
          class="max-h-32 w-full overflow-y-auto font-mono text-xs"
          spellcheck={false}
        />

        <div class="flex flex-col gap-2">
          <label class="text-12-medium text-text-weak">{language.t("dialog.agents.description")}</label>
          <TextField
            type="text"
            placeholder="A brief description"
            value={description()}
            onChange={setDescription}
          />
        </div>

        <Show when={modelOptions().length > 0}>
          <div class="flex flex-col gap-2">
            <label class="text-12-medium text-text-weak">{language.t("dialog.agents.model")}</label>
            <Select<ModelOption>
              options={modelOptions()}
              current={currentModel()}
              value={(o) => o.value}
              label={(o) => o.label}
              onSelect={(o) => setModel(o?.value ?? "")}
              placeholder="Select a model"
              triggerVariant="settings"
            />
          </div>
        </Show>

        <TextField
          type="text"
          label={language.t("dialog.agents.variant")}
          placeholder="default"
          value={variant()}
          onChange={setVariant}
        />

        <div class="flex gap-3">
          <div class="flex-1">
            <TextField
              type="number"
              label={language.t("dialog.agents.temperature")}
              placeholder="0.7"
              value={temperature()}
              onChange={setTemperature}
              min={0}
              max={2}
              step={0.1}
            />
          </div>
          <div class="flex-1">
            <TextField
              type="number"
              label={language.t("dialog.agents.top_p")}
              placeholder="1.0"
              value={topP()}
              onChange={setTopP}
              min={0}
              max={1}
              step={0.05}
            />
          </div>
        </div>

        <div class="flex flex-col gap-2">
          <label class="text-12-medium text-text-weak">{language.t("dialog.agents.color")}</label>
          <div class="flex gap-1.5 flex-wrap">
            <For each={AGENT_COLORS}>
              {(c) => (
                <button
                  type="button"
                  aria-label={c}
                  class="size-7 rounded-full border-2 transition-all"
                  classList={{
                    "border-icon-strong-base scale-110": color() === c,
                    "border-transparent hover:border-border-weak-base": color() !== c,
                  }}
                  style={{ "background-color": c }}
                  onClick={() => setColor(color() === c ? "" : c)}
                />
              )}
            </For>
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="button" variant="primary" size="large" disabled={!name()} onClick={handleSave}>
            {language.t("common.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
