import { createMemo, For, Show } from "solid-js"
import type { RuntimeEvent, EventCategory } from "@/context/inspector"
import { useInspector } from "@/context/inspector"

// ── Explanation types (mirrors backend schema for offline use) ──

export interface ExplanationEventLink {
  id: string
  eventType: string
  actor: string
  ts: string
  toolName?: string
  filePath?: string
  status?: string
  summary?: string
}

export type ExplanationRisk = "low" | "medium" | "high"

export interface Explanation {
  eventId: string
  eventType: string
  actor: string
  ts: string
  what: string
  whyThisFile?: string
  whichPrompt?: string
  whichTool?: string
  evidence: string[]
  testCoverage?: string
  risk: ExplanationRisk
  parentChain: ExplanationEventLink[]
  siblings: ExplanationEventLink[]
  children: ExplanationEventLink[]
}

// ── Explanation engine (pure, local) ──────────────────────

function summarizeEvent(e: RuntimeEvent): string {
  if (e.file) return `${e.type} on ${e.file}`
  if (e.tool) return `${e.type} via ${e.tool}`
  return e.type
}

function toEventLink(e: RuntimeEvent): ExplanationEventLink {
  return {
    id: e.id,
    eventType: e.type,
    actor: e.actor ?? "unknown",
    ts: new Date(e.timestamp).toISOString(),
    toolName: e.tool,
    filePath: e.file,
    status: e.status,
    summary: summarizeEvent(e),
  }
}

function inferRisk(...groups: RuntimeEvent[][]): ExplanationRisk {
  const all = groups.flat()
  if (all.some((e) => e.status === "failed" || e.error)) return "high"
  if (all.some((e) => e.status === "denied" || e.type.includes("denied"))) return "medium"
  return "low"
}

function hasTestType(type: string): boolean {
  return type.includes("test") || type.includes("spec") || type.includes("assert") || type.includes("validate")
}

function buildExplanation(event: RuntimeEvent, allEvents: RuntimeEvent[]): Explanation {
  // Parent chain (follow parentID up, limited)
  const parentChain: ExplanationEventLink[] = []
  let currentParent: RuntimeEvent | undefined = allEvents.find((e) => e.id === event.parentID)
  while (currentParent && parentChain.length < 10) {
    parentChain.push(toEventLink(currentParent))
    currentParent = allEvents.find((e) => e.id === currentParent!.parentID)
  }

  // Siblings: same callID but different id, or same parentID for events without callID
  const siblings: ExplanationEventLink[] = []
  if (event.callID) {
    const sibs = allEvents.filter(
      (e) => e.callID === event.callID && e.id !== event.id && e.actor !== "lifecycle",
    )
    siblings.push(...sibs.slice(0, 15).map(toEventLink))
  } else if (event.parentID) {
    const sibs = allEvents.filter(
      (e) => e.parentID === event.parentID && e.id !== event.id && e.actor !== "lifecycle",
    )
    siblings.push(...sibs.slice(0, 15).map(toEventLink))
  }

  // Children: events with this event as parent
  const children: ExplanationEventLink[] = allEvents
    .filter((e) => e.parentID === event.id)
    .slice(0, 15)
    .map(toEventLink)

  // Grandchildren
  const childIds = children.map((c) => c.id)
  const grandchildren: ExplanationEventLink[] = allEvents
    .filter((e) => e.parentID && childIds.includes(e.parentID))
    .slice(0, 15)
    .map(toEventLink)

  // Derive fields
  const promptEvent = parentChain.find(
    (p) => p.actor === "user" || p.eventType.includes("prompt"),
  )
  const toolEvent =
    siblings.find((s) => s.actor === "tool") ?? children.find((c) => c.actor === "tool")

  const fileEvents = [
    ...(event.file ? [event.file] : []),
    ...siblings.filter((s) => s.filePath).map((s) => s.filePath!),
    ...children.filter((c) => c.filePath).map((c) => c.filePath!),
  ]

  const testEvents = [...children, ...grandchildren].filter(
    (c) => hasTestType(c.eventType) || c.toolName?.includes("test"),
  )

  const evidence: string[] = []
  if (fileEvents.length > 0) {
    evidence.push(`Files involved: ${[...new Set(fileEvents)].join(", ")}`)
  }
  const siblingTools = siblings
    .filter((s) => s.toolName)
    .map((s) => s.toolName!)
  if (siblingTools.length > 0) {
    evidence.push(`Tools used in this turn: ${[...new Set(siblingTools)].join(", ")}`)
  }
  if (siblings.length > 0) {
    evidence.push(`Part of a batch of ${siblings.length + 1} sibling events`)
  }

  let whichPrompt: string | undefined
  if (promptEvent) {
    whichPrompt = promptEvent.eventType.replace(/^session\.next\./, "").replace(/^session\./, "")
  }

  let whyThisFile: string | undefined
  if (event.file) {
    whyThisFile = event.tool
      ? `Tool ${event.tool} processed ${event.file} as part of ${event.type}`
      : `File ${event.file} was referenced in ${event.type}`
  }

  const whichTool: string | undefined = event.tool ?? undefined

  let testCoverage: string | undefined
  if (testEvents.length > 0) {
    testCoverage = `${testEvents.length} test-related event${testEvents.length > 1 ? "s" : ""}: ${testEvents.map((t) => t.eventType).join(", ")}`
  }

  const siblingEvents = allEvents.filter(
    (e) =>
      (event.callID && e.callID === event.callID && e.id !== event.id) ||
      (!event.callID && event.parentID && e.parentID === event.parentID && e.id !== event.id),
  )
  const risk = inferRisk([event], siblingEvents)

  return {
    eventId: event.id,
    eventType: event.type,
    actor: event.actor ?? "unknown",
    ts: new Date(event.timestamp).toISOString(),
    what: summarizeEvent(event),
    whyThisFile,
    whichPrompt,
    whichTool,
    evidence,
    testCoverage,
    risk,
    parentChain,
    siblings,
    children: [...children, ...grandchildren],
  }
}

// ── Helpers ────────────────────────────────────────────────

const RISK_COLORS: Record<ExplanationRisk, { text: string; bg: string; border: string; label: string }> = {
  low: {
    text: "text-green-400",
    bg: "bg-green-500/10",
    border: "border-green-500/30",
    label: "Low Risk",
  },
  medium: {
    text: "text-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    label: "Medium Risk",
  },
  high: {
    text: "text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-500/30",
    label: "High Risk",
  },
}

function formatTime(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

// ── Component ──────────────────────────────────────────────

export interface WhyPanelProps {
  eventId: string
  onClose: () => void
  onNavigate: (eventId: string) => void
}

export function WhyPanel(props: WhyPanelProps) {
  const { events, selectEvent } = useInspector()

  // Memoized explanation — cached per eventId, recomputed only when events change
  const explanation = createMemo((): Explanation | null => {
    const target = events().find((e: RuntimeEvent) => e.id === props.eventId)
    if (!target) return null
    return buildExplanation(target, events())
  })

  const riskColors = createMemo(() => {
    const exp = explanation()
    if (!exp) return RISK_COLORS.low
    return RISK_COLORS[exp.risk]
  })

  return (
    <Show
      when={explanation()}
      fallback={
        <div class="flex flex-col items-center justify-center h-full gap-2 p-4 text-center">
          <span class="text-2xl">🤔</span>
          <p class="text-xs text-text-muted">No explanation available for this event</p>
          <p class="text-[10px] text-text-muted max-w-36">
            Select an event with tool or file context to see why it happened
          </p>
        </div>
      }
    >
      {(exp) => (
        <div class="flex flex-col h-full bg-background-element">
          {/* Header */}
          <div class="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-sm">🔍</span>
              <span class="text-xs font-medium text-text truncate">Why Did This Happen?</span>
            </div>
            <button
              class="text-text-muted hover:text-text transition-colors text-sm leading-none p-0.5 cursor-pointer"
              onClick={props.onClose}
            >
              ✕
            </button>
          </div>

          <div class="flex-1 overflow-y-auto">
            {/* What happened */}
            <section class="px-3 py-2 border-b border-border-weaker">
              <div class="text-[9px] font-medium text-text-muted uppercase tracking-wider mb-1">
                What
              </div>
              <div class="text-xs text-text leading-relaxed">{exp().what}</div>
              <div class="flex items-center gap-2 mt-1.5">
                <span class="text-[10px] text-text-muted">{exp().eventType}</span>
                <span class="text-[10px] text-text-muted">·</span>
                <span class="text-[10px] text-text-muted">{exp().actor}</span>
              </div>
            </section>

            {/* Why this file */}
            <Show when={exp().whyThisFile}>
              {(why) => (
                <section class="px-3 py-2 border-b border-border-weaker">
                  <div class="text-[9px] font-medium text-text-muted uppercase tracking-wider mb-1">
                    Why This File
                  </div>
                  <p class="text-xs text-text leading-relaxed">{why()}</p>
                </section>
              )}
            </Show>

            {/* Which prompt triggered this */}
            <Show when={exp().whichPrompt}>
              {(prompt) => (
                <section class="px-3 py-2 border-b border-border-weaker">
                  <div class="text-[9px] font-medium text-text-muted uppercase tracking-wider mb-1">
                    Triggered By
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span class="text-[10px]">💬</span>
                    <span class="text-xs text-text">{prompt()}</span>
                  </div>
                  <Show when={exp().whichTool}>
                    {(tool) => (
                      <div class="flex items-center gap-1.5 mt-1">
                        <span class="text-[10px]">🔧</span>
                        <span class="text-xs text-text">{tool()}</span>
                      </div>
                    )}
                  </Show>
                </section>
              )}
            </Show>

            {/* Evidence */}
            <Show when={exp().evidence.length > 0}>
              <section class="px-3 py-2 border-b border-border-weaker">
                <div class="text-[9px] font-medium text-text-muted uppercase tracking-wider mb-1">
                  Evidence
                </div>
                <ul class="space-y-1">
                  <For each={exp().evidence}>
                    {(item) => (
                      <li class="flex items-start gap-1.5 text-[11px] text-text leading-relaxed">
                        <span class="text-text-muted mt-0.5 shrink-0">•</span>
                        <span>{item}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>

            {/* Test coverage */}
            <Show when={exp().testCoverage}>
              {(tc) => (
                <section class="px-3 py-2 border-b border-border-weaker">
                  <div class="text-[9px] font-medium text-text-muted uppercase tracking-wider mb-1">
                    Test Coverage
                  </div>
                  <div class="flex items-start gap-1.5 text-[11px] text-text leading-relaxed">
                    <span class="shrink-0">🧪</span>
                    <span>{tc()}</span>
                  </div>
                </section>
              )}
            </Show>

            {/* Risk */}
            <section class="px-3 py-2 border-b border-border-weaker">
              <div class="text-[9px] font-medium text-text-muted uppercase tracking-wider mb-1">
                Risk Assessment
              </div>
              <div
                class={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${riskColors().bg} ${riskColors().text} ${riskColors().border}`}
              >
                <span
                  class="w-1.5 h-1.5 rounded-full"
                  style={{ "background-color": "currentColor" }}
                />
                {riskColors().label}
              </div>
            </section>

            {/* Parent chain */}
            <Show when={exp().parentChain.length > 0}>
              <section class="px-3 py-2 border-b border-border-weaker">
                <div class="text-[9px] font-medium text-text-muted uppercase tracking-wider mb-1">
                  Parent Chain ({exp().parentChain.length})
                </div>
                <div class="space-y-0.5 max-h-28 overflow-y-auto">
                  <For each={exp().parentChain}>
                    {(link) => (
                      <button
                        class="flex items-center gap-1 text-[10px] text-text-muted hover:text-text transition-colors truncate w-full text-left cursor-pointer"
                        onClick={() => {
                          selectEvent(link.id)
                          props.onNavigate(link.id)
                        }}
                      >
                        <span class="shrink-0">↑</span>
                        <span class="truncate">{link.summary ?? link.eventType}</span>
                        <span class="shrink-0 text-[9px] text-text-muted/60">{formatTime(link.ts)}</span>
                      </button>
                    )}
                  </For>
                </div>
              </section>
            </Show>

            {/* Siblings */}
            <Show when={exp().siblings.length > 0}>
              <section class="px-3 py-2 border-b border-border-weaker">
                <div class="text-[9px] font-medium text-text-muted uppercase tracking-wider mb-1">
                  Sibling Events ({exp().siblings.length})
                </div>
                <div class="space-y-0.5 max-h-32 overflow-y-auto">
                  <For each={exp().siblings}>
                    {(link) => (
                      <button
                        class="flex items-center gap-1 text-[10px] text-text-muted hover:text-text transition-colors truncate w-full text-left cursor-pointer"
                        onClick={() => {
                          selectEvent(link.id)
                          props.onNavigate(link.id)
                        }}
                      >
                        <span class="shrink-0">↔</span>
                        <span class="truncate">{link.summary ?? link.eventType}</span>
                        <span class="shrink-0 text-[9px] text-text-muted/60">{formatTime(link.ts)}</span>
                      </button>
                    )}
                  </For>
                </div>
              </section>
            </Show>

            {/* Children */}
            <Show when={exp().children.length > 0}>
              <section class="px-3 py-2 border-b border-border-weaker">
                <div class="text-[9px] font-medium text-text-muted uppercase tracking-wider mb-1">
                  Child Events ({exp().children.length})
                </div>
                <div class="space-y-0.5 max-h-32 overflow-y-auto">
                  <For each={exp().children}>
                    {(link) => (
                      <button
                        class="flex items-center gap-1 text-[10px] text-text-muted hover:text-text transition-colors truncate w-full text-left cursor-pointer"
                        onClick={() => {
                          selectEvent(link.id)
                          props.onNavigate(link.id)
                        }}
                      >
                        <span class="shrink-0">↓</span>
                        <span class="truncate">{link.summary ?? link.eventType}</span>
                        <span class="shrink-0 text-[9px] text-text-muted/60">{formatTime(link.ts)}</span>
                      </button>
                    )}
                  </For>
                </div>
              </section>
            </Show>

            {/* Bottom spacer */}
            <div class="h-4" />
          </div>
        </div>
      )}
    </Show>
  )
}
