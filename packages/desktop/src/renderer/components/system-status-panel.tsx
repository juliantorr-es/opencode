import { For, Show, createResource } from "solid-js"
import { useDesktopRuntime } from "../desktop-runtime-context"

export function SystemStatusPanel() {
  const { state } = useDesktopRuntime()

  return (
    <div class="flex flex-col gap-4 p-6">
      <h2 class="text-16-semibold text-text-strong">System Status</h2>

      {/* Sidecar */}
      <Section title="Sidecar">
        <StatusBadge ok={state.sidecar.status === "ready"} label={state.sidecar.status} />
        <Detail label="URL">{state.sidecar.url ?? "—"}</Detail>
        <Detail label="PID">{state.sidecar.pid ?? "—"}</Detail>
        <Detail label="Restarts">{state.sidecar.restartCount}</Detail>
        <Show when={state.sidecar.lastError}>
          <Detail label="Error">{state.sidecar.lastError}</Detail>
        </Show>
      </Section>

      {/* IPC */}
      <Section title="IPC Protocol">
        <Detail label="Version">v{state.ipc.protocolVersion}</Detail>
        <Detail label="Connected">{state.ipc.connected ? "Yes" : "No"}</Detail>
      </Section>

      {/* Update */}
      <Section title="Update">
        <StatusBadge ok={state.update.status === "idle"} label={state.update.status} />
        <Show when={state.update.version}>
          <Detail label="Version">{state.update.version}</Detail>
        </Show>
      </Section>

      {/* Actions */}
      <div class="flex gap-2 mt-4">
        <button class="btn btn-secondary" onClick={() => window.api.killSidecar()}>
          Kill Sidecar
        </button>
        <button class="btn btn-secondary" onClick={() => window.api.exportDebugLogs()}>
          Export Diagnostics
        </button>
      </div>
    </div>
  )
}

function Section(props: { title: string; children: any }) {
  return (
    <div class="flex flex-col gap-1 p-3 rounded bg-surface-weak">
      <h3 class="text-12-semibold text-text-weak mb-1">{props.title}</h3>
      {props.children}
    </div>
  )
}

function StatusBadge(props: { ok: boolean; label: string }) {
  return (
    <span class={`text-12-medium px-2 py-0.5 rounded ${props.ok ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
      {props.label}
    </span>
  )
}

function Detail(props: { label: string; children: any }) {
  return (
    <div class="flex justify-between text-12">
      <span class="text-text-weak">{props.label}</span>
      <span class="text-text-strong">{props.children}</span>
    </div>
  )
}
