import { Match, Show, Switch, createMemo, createSignal } from "solid-js"
import { Tooltip, type TooltipProps } from "@opencode-ai/ui/tooltip"
import { ProgressCircle } from "@opencode-ai/ui/progress-circle"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"

import { useFile } from "@/context/file"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"

interface SessionContextUsageProps {
  variant?: "button" | "indicator"
  placement?: TooltipProps["placement"]
}

function openSessionContext(args: {
  view: ReturnType<ReturnType<typeof useLayout>["view"]>
  layout: ReturnType<typeof useLayout>
  tabs: ReturnType<ReturnType<typeof useLayout>["tabs"]>
}) {
  if (!args.view.reviewPanel.opened()) args.view.reviewPanel.open()
  if (args.layout.fileTree.opened() && args.layout.fileTree.tab() !== "all") args.layout.fileTree.setTab("all")
  void args.tabs.open("context")
  args.tabs.setActive("context")
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const sync = useSync()
  const file = useFile()
  const layout = useLayout()
  const language = useLanguage()
  const providers = useProviders()
  const { params, tabs, view } = useSessionLayout()

  const variant = createMemo(() => props.variant ?? "button")
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  })
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const metrics = createMemo(() => getSessionContextMetrics(messages(), [...providers.all().values()]))
  const context = createMemo(() => metrics().context)
  const cost = createMemo(() => {
    return usd().format(metrics().totalCost)
  })

  const usage = createMemo(() => context()?.usage ?? 0)

  const hasCompaction = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return false
    const parts = sync.data?.part ?? {}
    for (const msg of messages()) {
      const msgParts = parts[msg.id]
      if (msgParts?.some((p) => p.type === "compaction")) return true
    }
    return false
  })

  const usageColor = createMemo(() => {
    const pct = usage()
    if (pct >= 95) return "var(--state-fg-danger)"
    if (pct >= 80) return "var(--state-fg-warning)"
    return undefined
  })

  const openContext = () => {
    if (!params.id) return

    if (tabState.activeTab() === "context") {
      tabs().close("context")
      return
    }
    openSessionContext({
      view: view(),
      layout,
      tabs: tabs(),
    })
  }

  const circle = () => (
    <div
      class="flex items-center justify-center"
      style={usageColor() ? ({ "--border-active": usageColor() } as Record<string, string>) : undefined}
    >
      <ProgressCircle size={16} strokeWidth={2} percentage={usage()} />
    </div>
  )

  const tooltipValue = () => (
    <div>
      <Show when={context()}>
        {(ctx) => (
          <>
            <div class="flex items-center gap-2">
              <span class="text-text-invert-strong">{ctx().total.toLocaleString(language.intl())}</span>
              <span class="text-text-invert-base">{language.t("context.usage.tokens")}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-text-invert-strong">{ctx().usage ?? 0}% of context window</span>
              <span class="text-text-invert-base">{language.t("context.usage.usage")}</span>
            </div>
          </>
        )}
      </Show>
      <div class="flex items-center gap-2">
        <span class="text-text-invert-strong">{cost()}</span>
        <span class="text-text-invert-base">{language.t("context.usage.cost")}</span>
      </div>
      <Show when={hasCompaction()}>
        <div class="flex items-center gap-2 pt-1">
          <Icon name="collapse" class="text-text-invert-base size-3" />
          <span class="text-text-invert-base">Compacted</span>
        </div>
      </Show>
    </div>
  )

  return (
    <Show when={params.id}>
      <Tooltip value={tooltipValue()} placement={props.placement ?? "top"}>
        <div class="relative">
          <Switch>
            <Match when={variant() === "indicator"}>{circle()}</Match>
            <Match when={true}>
              <Button
                type="button"
                variant="ghost"
                class="size-6"
                onClick={openContext}
                aria-label={language.t("context.usage.view")}
              >
                {circle()}
              </Button>
            </Match>
          </Switch>
          <Show when={hasCompaction()}>
            <div class="absolute -top-0.5 -right-0.5 size-2.5 flex items-center justify-center">
              <div class="size-2 rounded-full bg-[var(--state-fg-warning)]" />
            </div>
          </Show>
        </div>
      </Tooltip>
    </Show>
  )
}
