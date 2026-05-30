import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { McpServerEntry } from "@/types/mcp"

type Props = {
  entry?: McpServerEntry
  onSave: (entry: McpServerEntry) => Promise<void>
  onCancel?: () => void
}

export function DialogEditMcp(props: Props) {
  const language = useLanguage()

  const isEditing = createMemo(() => !!props.entry)

  const [name, setName] = createSignal(props.entry?.name ?? "")
  const [type, setType] = createSignal<"local" | "remote">(
    props.entry?.config.type === "remote" ? "remote" : "local",
  )
  const [command, setCommand] = createSignal(
    props.entry?.config.type === "local" ? (props.entry?.config.command ?? []).join(" ") : "",
  )
  const [url, setUrl] = createSignal(
    props.entry?.config.type === "remote" ? props.entry?.config.url ?? "" : "",
  )
  const [timeoutValue, setTimeoutValue] = createSignal(
    props.entry?.config.type === "local" && props.entry?.config.timeout
      ? props.entry.config.timeout.toString()
      : "",
  )

  // Reset form signals when editing a different entry
  createEffect(() => {
    const entry = props.entry
    setName(entry?.name ?? "")
    setType(entry?.config.type === "remote" ? "remote" : "local")
    setCommand(
      entry?.config.type === "local" ? (entry?.config.command ?? []).join(" ") : "",
    )
    setUrl(
      entry?.config.type === "remote" ? entry?.config.url ?? "" : "",
    )
    setTimeoutValue(
      entry?.config.type === "local" && entry?.config.timeout
        ? entry.config.timeout.toString()
        : "",
    )
  })

  const handleSave = async () => {
    const timeoutVal = timeoutValue() !== "" ? Number(timeoutValue()) : undefined

    if (type() === "local") {
      const cmdStr = command().trim()
      if (!cmdStr || cmdStr.split(/\s+/).filter(Boolean).length === 0) return
    }

    if (type() === "remote" && !URL.canParse(url())) return

    const entry: McpServerEntry = {
      name: name(),
      config:
        type() === "local"
          ? {
              type: "local",
              command: command()
                .split(/\s+/)
                .filter(Boolean),
              ...(timeoutVal !== undefined && !Number.isNaN(timeoutVal) ? { timeout: timeoutVal } : {}),
              enabled: true,
            }
          : {
              type: "remote",
              url: url(),
              enabled: true,
            },
    }
    await props.onSave(entry)
  }

  return (
    <div class="flex flex-col gap-5 p-5 bg-surface-base rounded-md border border-border-weak-base">
        <TextField
          autofocus
          type="text"
          label={language.t("dialog.mcp.form.name")}
          placeholder="my-mcp-server"
          value={name()}
          onChange={setName}
          disabled={isEditing()}
        />

        <div class="flex flex-col gap-2">
          <label class="text-12-medium text-text-weak">{language.t("dialog.mcp.form.type")}</label>
          <div class="flex gap-2">
            <Button
              type="button"
              variant={type() === "local" ? "primary" : "secondary"}
              size="small"
              onClick={() => setType("local")}
            >
              {language.t("dialog.mcp.form.local")}
            </Button>
            <Button
              type="button"
              variant={type() === "remote" ? "primary" : "secondary"}
              size="small"
              onClick={() => setType("remote")}
            >
              {language.t("dialog.mcp.form.remote")}
            </Button>
          </div>
        </div>

        <Show when={type() === "local"}>
          <TextField
            type="text"
            label={language.t("dialog.mcp.form.command")}
            placeholder={language.t("dialog.mcp.form.commandPlaceholder")}
            value={command()}
            onChange={setCommand}
          />
          <TextField
            type="number"
            label={language.t("dialog.mcp.form.timeout")}
            placeholder={language.t("dialog.mcp.form.timeoutPlaceholder")}
            value={timeoutValue()}
            onChange={setTimeoutValue}
            min={0}
          />
        </Show>

        <Show when={type() === "remote"}>
          <TextField
            type="text"
            label={language.t("dialog.mcp.form.url")}
            placeholder={language.t("dialog.mcp.form.urlPlaceholder")}
            value={url()}
            onChange={setUrl}
          />
        </Show>

        <div class="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="large" onClick={() => { props.onCancel?.(); }}>
            {language.t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="large"
            disabled={!name() || (type() === "local" ? !command() : !url())}
            onClick={handleSave}
          >
            {language.t("common.save")}
          </Button>
        </div>
    </div>
  )
}
