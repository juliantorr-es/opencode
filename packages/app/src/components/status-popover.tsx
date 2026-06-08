import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/components/icon-button-v2.jsx"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/components/icon.jsx"
import { Popover } from "@opencode-ai/ui/popover"
import { Suspense, createMemo, createSignal, lazy, Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useServers } from "@/context/servers"
import { useLifecycle, type LifecycleState } from "@/context/lifecycle"
import {
  formatSessionChromeStatusLabel,
  isSessionRecoveryStatus,
  type SessionStatusLike,
} from "@/utils/cockpit-truth"

const Body = lazy(() => import("./status-popover-body").then((x) => ({ default: x.StatusPopoverBody })))
const ServerBody = lazy(() => import("./status-popover-body").then((x) => ({ default: x.StatusPopoverServerBody })))

export function StatusPopover() {
  const language = useLanguage()
  const server = useServer()
  const servers = useServers()
  const sync = useSync()
  const [shown, setShown] = createSignal(false)
  const ready = createMemo(() => servers.health[server.key]?.healthy === false || sync.data.mcp_ready)
  const mcpIssue = createMemo(() => {
    const mcp = Object.values(sync.data.mcp ?? {})
    const failed = mcp.some((item) => item.status === "failed" || item.status === "needs_client_registration")
    const warn = mcp.some((item) => item.status === "needs_auth")
    if (failed) return "critical" as const
    if (warn) return "warning" as const
  })
  const serverHealthy = () => servers.health[server.key]?.healthy === true
  const healthy = createMemo(() => servers.health[server.key]?.healthy === true && !mcpIssue())

  return (
    <Popover
      open={shown()}
      onOpenChange={setShown}
      triggerAs={Button}
      triggerProps={{
        variant: "ghost",
        class: "titlebar-icon w-8 h-6 p-0 box-border",
        "aria-label": language.t("status.popover.trigger"),
        style: { scale: 1 },
      }}
      trigger={
        <div class="relative size-4">
          <div class="badge-mask-tight size-4 flex items-center justify-center">
            <Icon name={shown() ? "status-active" : "status"} size="small" />
          </div>
          <div
            classList={{
              "absolute -top-px -right-px size-1.5 rounded-full": true,
              "bg-icon-success-base": ready() && healthy(),
              "bg-icon-warning-base": ready() && serverHealthy() && mcpIssue() === "warning",
              "bg-icon-critical-base": serverHealthy() || (ready() && serverHealthy() && mcpIssue() === "critical"),
              "bg-border-weak-base": serverHealthy() || !ready(),
            }}
          />
        </div>
      }
      class="[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-xl"
      gutter={4}
      placement="bottom-end"
      shift={-168}
    >
      <Show when={shown()}>
        <Suspense
          fallback={
            <div class="w-[360px] h-14 rounded-xl bg-background-strong shadow-[var(--shadow-lg-border-base)]" />
          }
        >
          <Body shown={shown} />
        </Suspense>
      </Show>
    </Popover>
  )
}

export function StatusPopoverV2(props: { scope?: "server"; sessionID?: string }) {
  if (props.scope === "server") return <ServerStatusPopover />
  return <DirectoryStatusPopover sessionID={props.sessionID} />
}

function DirectoryStatusPopover(props: { sessionID?: string }) {
  const language = useLanguage()
  const server = useServer()
  const servers = useServers()
  const sync = useSync()
  const [shown, setShown] = createSignal(false)
  const serverHealth = () => servers.health[server.key]?.healthy
  const ready = createMemo(() => serverHealth() === false || sync.data.mcp_ready)
  const sessionStatus = createMemo(() => (props.sessionID ? sync.data.session_status[props.sessionID] : undefined))
  const mcpIssue = createMemo(() => {
    const mcp = Object.values(sync.data.mcp ?? {})
    const failed = mcp.some((item) => item.status === "failed" || item.status === "needs_client_registration")
    const warn = mcp.some((item) => item.status === "needs_auth")
    if (failed) return "critical" as const
    if (warn) return "warning" as const
  })
  const healthy = createMemo(() => serverHealth() === true && !mcpIssue())
  
  const lifecycleContext = useLifecycle()
  const lifecycleState = createMemo<LifecycleState>(() => {
    if (!props.sessionID) return "unavailable"
    return lifecycleContext.getLifecycle(props.sessionID).state
  })

  const state = createMemo<StatusPopoverState>(() => ({
    shown: shown(),
    ready: ready(),
    healthy: healthy(),
    serverHealth: serverHealth(),
    issue: mcpIssue(),
    sessionStatus: sessionStatus(),
    lifecycleState: lifecycleState(),
    label: formatSessionChromeStatusLabel({
      sessionStatus: sessionStatus(),
      lifecycleState: lifecycleState(),
      fallbackLabel: language.t("status.popover.trigger"),
    }),
    onOpenChange: setShown,
    body: () => (
      <StatusPopoverBody shown={shown()}>
        <Body shown={shown} sessionID={props.sessionID} />
      </StatusPopoverBody>
    ),
  }))

  return <StatusPopoverView state={state()} />
}

function ServerStatusPopover() {
  const language = useLanguage()
  const server = useServer()
  const servers = useServers()
  const [shown, setShown] = createSignal(false)
  const serverHealth = () => servers.health[server.key]?.healthy
  const state = createMemo<StatusPopoverState>(() => ({
    shown: shown(),
    ready: serverHealth() !== undefined,
    healthy: serverHealth() === true,
    serverHealth: serverHealth(),
    sessionStatus: undefined,
    label: language.t("status.popover.trigger"),
    onOpenChange: setShown,
    body: () => (
      <StatusPopoverBody shown={shown()}>
        <ServerBody />
      </StatusPopoverBody>
    ),
  }))

  return <StatusPopoverView state={state()} />
}

type StatusPopoverState = {
  shown: boolean
  ready: boolean
  healthy: boolean
  serverHealth: boolean | undefined
  sessionStatus?: SessionStatusLike
  issue?: "critical" | "warning"
  lifecycleState?: LifecycleState
  label: string
  onOpenChange: (value: boolean) => void
  body: () => JSX.Element
}

function StatusPopoverBody(props: { shown: boolean; children: JSX.Element }) {
  return (
    <Show when={props.shown}>
      <Suspense
        fallback={<div class="w-[360px] h-14 rounded-xl bg-background-strong shadow-[var(--shadow-lg-border-base)]" />}
      >
        {props.children}
      </Suspense>
    </Show>
  )
}

function StatusPopoverView(props: { state: StatusPopoverState }) {
  const isHealthy = () => props.state.ready && props.state.healthy
  const sessionRecovery = createMemo(() => {
    const value = props.state.sessionStatus
    if (!isSessionRecoveryStatus(value)) return undefined
    return value
  })

  const statusDotClass = () => {
    const recovery = sessionRecovery()
    if (recovery) {
      return {
        "absolute rounded-full": true,
        "bg-icon-success-base": recovery.type === "coordination_recovered",
        "bg-icon-brand-base": recovery.type === "coordination_rebuilding",
        "bg-icon-warning-base": recovery.type === "coordination_degraded",
        "bg-icon-critical-base":
          recovery.type === "coordination_unavailable" || recovery.type === "coordination_refused",
      }
    }

    return {
      "absolute rounded-full": true,
      "bg-icon-success-base": isHealthy() && props.state.lifecycleState === "completed",
      "bg-icon-brand-base": isHealthy() && (props.state.lifecycleState === "executing" || props.state.lifecycleState === "verifying"),
      "bg-icon-warning-base":
        (props.state.ready && props.state.serverHealth === true && props.state.issue === "warning") ||
        (isHealthy() && props.state.lifecycleState === "waiting_for_permission"),
      "bg-icon-critical-base":
        props.state.serverHealth === false ||
        (props.state.ready && props.state.serverHealth === true && props.state.issue === "critical") ||
        (isHealthy() && props.state.lifecycleState === "failed"),
      "bg-border-weak-base":
        props.state.serverHealth === undefined ||
        !props.state.ready ||
        (isHealthy() &&
          (props.state.lifecycleState === "idle" ||
            props.state.lifecycleState === "unavailable" ||
            props.state.lifecycleState === "planning")),
    }
  }

  const popoverProps = {
    class:
      "[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-xl",
    gutter: 4,
    placement: "bottom-end" as const,
    shift: -168,
  }

  return (
    <Popover
      open={props.state.shown}
      onOpenChange={props.state.onOpenChange}
      triggerAs={IconButtonV2}
      triggerProps={{
        variant: "ghost-muted",
        size: "large",
        class: "!w-9 shrink-0",
        state: props.state.shown ? "pressed" : undefined,
        "aria-label": props.state.label,
      }}
      trigger={
        <div class="relative size-4">
          <IconV2 name={props.state.shown ? "status-active" : "status"} />
          <div
            classList={statusDotClass()}
            class="-top-1 -right-1 size-2 border border-[var(--v2-background-bg-deep)]"
          />
        </div>
      }
      {...popoverProps}
    >
      {props.state.body()}
    </Popover>
  )
}
