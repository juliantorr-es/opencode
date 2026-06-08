import { For, Show } from "solid-js"
import type { PermissionRequest } from "@tribunus/sdk/v2"
import { Button } from "@tribunus/ui/button"
import { DockPrompt } from "@tribunus/ui/dock-prompt"
import { Icon } from "@tribunus/ui/icon"
import { useLanguage } from "@/context/language"
import { useSessionCapabilities, useSessionAuthorityReceipts } from "@/context/capability"


export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()
  const capabilities = useSessionCapabilities(() => props.request.sessionID)
  const receipts = useSessionAuthorityReceipts(() => props.request.sessionID)

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  const isRecoveryBlocked = () => {
    const caps = capabilities.data()
    return caps?.tool?.available === false && caps?.tool?.reason?.startsWith("coordination_state_blocks_")
  }


  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Button
              variant="secondary"
              size="normal"
              onClick={() => props.onDecide("always")}
              disabled={props.responding || isRecoveryBlocked()}
            >
              {language.t("ui.permission.allowAlways")}
            </Button>
            <Button
              variant="primary"
              size="normal"
              onClick={() => props.onDecide("once")}
              disabled={props.responding || isRecoveryBlocked()}
            >
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>

      }
    >
      <Show when={isRecoveryBlocked()}>
        <div data-slot="permission-row" class="text-text-danger">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint" class="font-medium text-red-600">
            {capabilities.data()?.tool?.message}
          </div>
        </div>
      </Show>

      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.patterns}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>

      <Show when={receipts.data() && receipts.data()!.length > 0}>
        <div data-slot="permission-row" class="mt-4 pt-4 border-t border-border-dim">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div class="flex flex-col gap-2 w-full">
            <div class="text-xs font-semibold text-text-muted">
              {language.t("ui.permission.recentDecisions") || "Recent authority decisions"}
            </div>
            <For each={receipts.data() ?? []}>
              {(receipt) => {
                const severity = () => {
                  if (receipt.outcome === "allowed") return "success";
                  if (receipt.reasons.includes("coordination_state_blocks_side_effect") ||
                      receipt.reasons.includes("coordination_state_blocks_mutation") ||
                      receipt.reasons.includes("recovery-blocked") ||
                      receipt.reasons.includes("refused")) {
                    return "danger";
                  }
                  return "warning";
                };

                const colorClass = () => {
                  const s = severity();
                  if (s === "success") return "text-green-600 dark:text-green-400";
                  if (s === "danger") return "text-red-600 dark:text-red-400";
                  return "text-amber-600 dark:text-amber-400";
                };

                return (
                  <div class="text-xs flex items-center justify-between py-1 px-2 bg-bg-surface-dim rounded">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <span class={`w-1.5 h-1.5 rounded-full ${severity() === "success" ? "bg-green-500" : severity() === "danger" ? "bg-red-500" : "bg-amber-500"}`} />
                      <span class="font-medium truncate">{receipt.actionName}</span>
                    </div>
                    <span class={`text-[10px] ${colorClass()} font-medium uppercase px-1 rounded`}>
                      {receipt.message || (receipt.outcome === "allowed" ? "Allowed" : "Refused")}
                    </span>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
