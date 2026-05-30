import { createMemo, createSignal, For, Show } from "solid-js"
import { EVENT_CATEGORY_LABELS, EVENT_STATUS_COLORS, useInspector } from "@/context/inspector"

export function EventDetailDrawer() {
  const { selectedEvent, selectEvent, getChildren, getParent } = useInspector()
  const [activeTab, setActiveTab] = createSignal<"fields" | "raw">("fields")

  const event = selectedEvent

  const children = createMemo(() => {
    const e = event()
    if (!e) return []
    return getChildren(e.id)
  })

  const parent = createMemo(() => {
    const e = event()
    if (!e) return null
    return getParent(e.id)
  })

  const catInfo = createMemo(() => {
    const e = event()
    if (!e) return null
    return EVENT_CATEGORY_LABELS[e.category] ?? null
  })

  const statusColor = createMemo(() => {
    const e = event()
    if (!e) return "#888"
    return EVENT_STATUS_COLORS[e.status]
  })

  return (
    <div class="flex flex-col h-full border-l border-border bg-background-element">
      {/* Header */}
      <div class="flex items-center justify-between px-3 py-2 border-b border-border">
        <span class="text-xs font-medium text-text">Event Details</span>
        <button
          class="text-text-muted hover:text-text transition-colors text-sm leading-none p-0.5"
          onClick={() => selectEvent("")}
        >
          ✕
        </button>
      </div>

      <Show
        when={event()}
        fallback={
          <div class="flex flex-col items-center justify-center flex-1 gap-2 p-4 text-center">
            <span class="text-2xl">👆</span>
            <p class="text-xs text-text-muted">Select an event to see details</p>
            <p class="text-[10px] text-text-muted max-w-36">
              Click any row in the timeline to inspect its full payload
            </p>
          </div>
        }
      >
        {(ev) => (
          <>
            {/* Summary header */}
            <div class="px-3 py-2 space-y-1">
              <div class="flex items-center gap-2">
                <span class="text-sm">{catInfo()?.icon ?? "●"}</span>
                <span class="text-xs font-medium text-text break-all">{ev().type}</span>
              </div>
              <div class="flex items-center gap-2 text-[11px]">
                <span
                  class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px]"
                  style={{
                    "border-color": statusColor(),
                    color: statusColor(),
                    "background-color": `${statusColor()}15`,
                  }}
                >
                  <span
                    class="w-1.5 h-1.5 rounded-full"
                    style={{ "background-color": statusColor() }}
                  />
                  {ev().status}
                </span>
                <Show when={ev().actor}>
                  <span class="text-text-muted">{ev().actor}</span>
                </Show>
              </div>
            </div>

            {/* Summary fields */}
            <div class="px-3 py-1.5 space-y-1 border-b border-border">
              <FieldRow label="Session" value={ev().sessionID} />
              <Show when={ev().tool}>
                <FieldRow label="Tool" value={ev().tool!} />
              </Show>
              <Show when={ev().file}>
                <FieldRow label="File" value={ev().file!} />
              </Show>
              <Show when={ev().error}>
                <FieldRow label="Error" value={ev().error!} />
              </Show>
              <Show when={ev().callID}>
                <FieldRow label="Call ID" value={ev().callID!} />
              </Show>
            </div>

            {/* Parent link */}
            <Show when={parent()}>
              {(p) => (
                <div class="px-3 py-1.5 border-b border-border">
                  <div class="text-[10px] font-medium text-text-muted mb-1">Parent Event</div>
                  <button
                    class="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    onClick={() => selectEvent(p().id)}
                  >
                    <span>↑</span>
                    <span class="truncate">{p().type}</span>
                  </button>
                </div>
              )}
            </Show>

            {/* Children list */}
            <Show when={children().length > 0}>
              <div class="px-3 py-1.5 border-b border-border">
                <div class="text-[10px] font-medium text-text-muted mb-1">
                  Child Events ({children().length})
                </div>
                <div class="flex flex-col gap-0.5 max-h-24 overflow-y-auto">
                  <For each={children()}>
                    {(child) => (
                      <button
                        class="flex items-center gap-1 text-[10px] text-text-muted hover:text-text transition-colors truncate"
                        onClick={() => selectEvent(child.id)}
                      >
                        <span>↓</span>
                        <span class="truncate">{child.type}</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Tab bar */}
            <div class="flex border-b border-border">
              <button
                class={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${
                  activeTab() === "fields"
                    ? "text-text border-b-2 border-text"
                    : "text-text-muted hover:text-text"
                }`}
                onClick={() => setActiveTab("fields")}
              >
                Fields
              </button>
              <button
                class={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${
                  activeTab() === "raw"
                    ? "text-text border-b-2 border-text"
                    : "text-text-muted hover:text-text"
                }`}
                onClick={() => setActiveTab("raw")}
              >
                Raw JSON
              </button>
            </div>

            {/* Tab content */}
            <div class="flex-1 overflow-y-auto p-3">
              <Show when={activeTab() === "fields"}>
                <JsonFields data={ev().raw} depth={0} />
              </Show>
              <Show when={activeTab() === "raw"}>
                <pre class="text-[10px] font-mono text-text-muted whitespace-pre-wrap break-all">
                  {JSON.stringify(ev().raw, null, 2)}
                </pre>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

function FieldRow(props: { label: string; value: string }) {
  return (
    <div class="flex items-start gap-2">
      <span class="text-[10px] font-medium text-text-muted shrink-0 w-14">{props.label}</span>
      <span class="text-[10px] text-text break-all">{props.value}</span>
    </div>
  )
}

function JsonFields(props: { data: unknown; depth: number }) {
  if (props.depth > 4) {
    return <span class="text-[10px] text-text-muted italic">[depth limit]</span>
  }

  if (props.data === null || props.data === undefined) {
    return <span class="text-[10px] text-text-muted italic">null</span>
  }

  if (typeof props.data === "string") {
    return <span class="text-[10px] text-blue-400 break-all">"{props.data}"</span>
  }

  if (typeof props.data === "number" || typeof props.data === "boolean") {
    return <span class="text-[10px] text-yellow-400">{String(props.data)}</span>
  }

  if (Array.isArray(props.data)) {
    return (
      <div class="space-y-0.5">
        <span class="text-[10px] text-text-muted">[{props.data.length}]</span>
        <For each={props.data.slice(0, 20)}>
          {(item, i) => (
            <div class="flex gap-1 ml-2">
              <span class="text-[10px] text-text-muted">{i()}:</span>
              <JsonFields data={item} depth={props.depth + 1} />
            </div>
          )}
        </For>
        <Show when={props.data.length > 20}>
          <span class="text-[10px] text-text-muted italic">... {props.data.length - 20} more</span>
        </Show>
      </div>
    )
  }

  if (typeof props.data === "object") {
    const entries = Object.entries(props.data as Record<string, unknown>)
    return (
      <div class="space-y-0.5">
        <For each={entries.slice(0, 30)}>
          {([key, value]) => (
            <div class="flex gap-1 ml-1">
              <span class="text-[10px] font-medium text-text-muted shrink-0">{key}:</span>
              <div class="flex-1 min-w-0">
                <JsonFields data={value} depth={props.depth + 1} />
              </div>
            </div>
          )}
        </For>
        <Show when={entries.length > 30}>
          <span class="text-[10px] text-text-muted italic">... {entries.length - 30} more</span>
        </Show>
      </div>
    )
  }

  return <span class="text-[10px] text-text-muted">{String(props.data)}</span>
}
