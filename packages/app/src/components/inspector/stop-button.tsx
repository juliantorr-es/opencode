import { createMemo, createSignal, For, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useServerSDK } from "@/context/server-sdk"
import { useInspector, type RuntimeEvent } from "@/context/inspector"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"

// ── Types ──

interface StopSnapshot {
  filesChanged: string[]
  pendingTools: string[]
  completedTools: string[]
  errors: string[]
  eventCount: number
}

// ── Snapshot logic ──

function captureSnapshot(sessionID: string, events: RuntimeEvent[]): StopSnapshot {
  const sessionEvents = events.filter((e) => e.sessionID === sessionID)

  const filesChanged = [
    ...new Set(
      sessionEvents
        .filter((e) => e.file && (e.type === "file.edited" || e.category === "file"))
        .map((e) => e.file!),
    ),
  ]

  const toolStarted = new Set(
    sessionEvents
      .filter((e) => e.type === "session.next.tool.called" && e.tool)
      .map((e) => e.tool!),
  )
  const toolEnded = new Set(
    sessionEvents
      .filter(
        (e) =>
          (e.type === "session.next.tool.success" || e.type === "session.next.tool.failed") &&
          e.tool,
      )
      .map((e) => e.tool!),
  )
  const pendingTools = [...toolStarted].filter((t) => !toolEnded.has(t))
  const completedTools = [...toolEnded]

  const errors = sessionEvents
    .filter((e) => e.status === "failed" || e.error)
    .map((e) => `${e.type}: ${e.error ?? "Unknown error"}`)
    .slice(0, 5)

  return { filesChanged, pendingTools, completedTools, errors, eventCount: sessionEvents.length }
}

// ── Confirm Dialog ──

function StopConfirmDialog(props: {
  sessionID: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog title="Stop Active Session?">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-muted">
          Let current operations finish, then pause execution. You can resume or restart
          afterward.
        </p>
        <div class="flex items-center gap-1.5 px-3 py-2 rounded bg-yellow-500/10 text-yellow-400 text-[11px]">
          <span>⚠️</span>
          <span>
            Active tool calls will be interrupted. File changes already applied will be
            preserved.
          </span>
        </div>
        <p class="text-[11px] text-text-muted font-mono">
          Session: {props.sessionID.slice(0, 12)}…
        </p>
        <div class="flex items-center justify-end gap-2">
          <button
            class="px-3 py-1.5 text-[11px] font-medium rounded border border-border text-text-muted hover:text-text hover:bg-background-menu transition-colors cursor-pointer"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            class="px-3 py-1.5 text-[11px] font-medium rounded bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors cursor-pointer"
            onClick={props.onConfirm}
          >
            Stop Safely
          </button>
        </div>
      </div>
    </Dialog>
  )
}

// ── Summary Dialog ──

function StopSummaryDialog(props: {
  sessionID: string
  snapshot: StopSnapshot
  onClose: () => void
}) {
  const hasChanges = () => props.snapshot.filesChanged.length > 0
  const hasPending = () => props.snapshot.pendingTools.length > 0
  const hasErrors = () => props.snapshot.errors.length > 0

  return (
    <Dialog title="Session Stopped" size="normal">
      <div class="flex flex-col gap-4 p-4">
        {/* Summary header */}
        <div
          class={`flex items-center gap-2 px-3 py-2 rounded text-xs ${
            hasErrors()
              ? "bg-yellow-500/10 text-yellow-400"
              : "bg-green-500/10 text-green-400"
          }`}
        >
          <span>{hasErrors() ? "⚠" : "✓"}</span>
          <span>
            Session {props.sessionID.slice(0, 8)}… stopped.{" "}
            {props.snapshot.eventCount} events tracked.
          </span>
        </div>

        {/* Changes made */}
        <div>
          <h4 class="text-[11px] font-medium text-text uppercase tracking-wider mb-1.5">
            Changes Made
          </h4>
          <Show
            when={hasChanges()}
            fallback={
              <p class="text-[11px] text-text-muted italic">No file changes detected</p>
            }
          >
            <div class="flex flex-col gap-1 max-h-32 overflow-y-auto">
              <For each={props.snapshot.filesChanged}>
                {(file) => (
                  <div class="flex items-center gap-1.5 text-[11px] font-mono">
                    <span class="text-green-400 shrink-0">📝</span>
                    <span class="truncate text-text">{file}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={hasChanges()}>
            <p class="text-[10px] text-text-muted mt-1">
              {props.snapshot.filesChanged.length} file
              {props.snapshot.filesChanged.length !== 1 ? "s" : ""} modified
            </p>
          </Show>
        </div>

        {/* Completed tools */}
        <Show when={props.snapshot.completedTools.length > 0}>
          <div>
            <h4 class="text-[11px] font-medium text-text uppercase tracking-wider mb-1.5">
              Completed Operations
            </h4>
            <div class="flex flex-col gap-1 max-h-24 overflow-y-auto">
              <For each={props.snapshot.completedTools}>
                {(tool) => (
                  <div class="flex items-center gap-1.5 text-[11px] text-text-muted font-mono">
                    <span class="text-green-400/60 shrink-0">✓</span>
                    <span class="truncate">{tool}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Pending items */}
        <div>
          <h4 class="text-[11px] font-medium text-text uppercase tracking-wider mb-1.5">
            Didn't Finish
          </h4>
          <Show
            when={hasPending()}
            fallback={
              <p class="text-[11px] text-text-muted italic">No pending operations</p>
            }
          >
            <div class="flex flex-col gap-1 max-h-24 overflow-y-auto">
              <For each={props.snapshot.pendingTools}>
                {(tool) => (
                  <div class="flex items-center gap-1.5 text-[11px] text-text-muted font-mono">
                    <span class="text-yellow-400 shrink-0">⏳</span>
                    <span class="truncate">{tool}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* Errors */}
        <Show when={hasErrors()}>
          <div>
            <h4 class="text-[11px] font-medium text-red-400 uppercase tracking-wider mb-1.5">
              Errors
            </h4>
            <div class="flex flex-col gap-1 max-h-32 overflow-y-auto">
              <For each={props.snapshot.errors}>
                {(err) => (
                  <div class="flex items-start gap-1.5 text-[11px] text-red-400 font-mono">
                    <span class="shrink-0 mt-0.5">⚠️</span>
                    <span class="truncate">{err}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Action buttons */}
        <div class="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <button
            class="px-3 py-1.5 text-[11px] font-medium rounded border border-border text-text-muted hover:text-text hover:bg-background-menu transition-colors cursor-pointer"
            onClick={props.onClose}
          >
            Dismiss
          </button>
        </div>
      </div>
    </Dialog>
  )
}

// ── Main Component ──

export function StopButton() {
  const params = useParams()
  const sdk = useServerSDK()
  const { events, sessions } = useInspector()
  const dialog = useDialog()
  const [stopping, setStopping] = createSignal(false)

  const activeSessionID = createMemo(() => {
    if (params.id) return params.id
    const allSessions = sessions()
    return allSessions.length > 0 ? allSessions[0] : null
  })

  const hasActiveSession = () => activeSessionID() !== null

  const handleStop = async () => {
    const sid = activeSessionID()
    if (!sid) return

    setStopping(true)
    const snapshot = captureSnapshot(sid, events())

    try {
      await sdk.client.session.abort({ sessionID: sid })
      showToast({
        title: "Session stopped",
        description: `Session ${sid.slice(0, 8)}… stopped safely`,
        variant: "success",
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast({
        title: "Stop failed",
        description: msg,
        variant: "error",
      })
    } finally {
      setStopping(false)
    }

    dialog.show(() => (
      <StopSummaryDialog
        sessionID={sid}
        snapshot={snapshot}
        onClose={() => dialog.close()}
      />
    ))
  }

  const handleClick = () => {
    const sid = activeSessionID()
    if (!sid) {
      showToast({
        title: "No active session",
        description: "Open a session to use stop controls",
        variant: "default",
      })
      return
    }

    dialog.show(() => (
      <StopConfirmDialog
        sessionID={sid}
        onConfirm={() => {
          dialog.close()
          handleStop()
        }}
        onCancel={() => dialog.close()}
      />
    ))
  }

  return (
    <button
      class={[
        "flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium",
        "transition-colors cursor-pointer select-none",
        stopping()
          ? "bg-red-500/10 text-red-400/50 cursor-not-allowed"
          : hasActiveSession()
            ? "bg-red-500/10 text-red-400 hover:bg-red-500/20 active:bg-red-500/30"
            : "bg-red-500/5 text-red-400/40 cursor-not-allowed",
      ].join(" ")}
      onClick={handleClick}
      disabled={stopping()}
      title={
        stopping()
          ? "Stopping…"
          : hasActiveSession()
            ? "Stop active session safely"
            : "No active session to stop"
      }
    >
      <span class="text-xs flex items-center justify-center w-3.5 h-3.5">
        {stopping() ? "⏳" : "⏹"}
      </span>
      <span>{stopping() ? "Stopping…" : "Stop Safely"}</span>
    </button>
  )
}
