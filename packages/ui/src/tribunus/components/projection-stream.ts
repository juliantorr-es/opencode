import { LitElement, html, css, type TemplateResult } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface ProjectionEvent {
  id: string
  type: "thought" | "inference" | "action" | "result"
  label: string
  description: string
  timestamp: string
}

const DEMO_EVENTS: ProjectionEvent[] = [
  { id: "p1", type: "thought", label: "Analyzing context", description: "Scanning project files for relevant patterns...", timestamp: new Date(Date.now() - 5000).toISOString() },
  { id: "p2", type: "inference", label: "Building hypothesis", description: "Detected circular dependency in module graph", timestamp: new Date(Date.now() - 4000).toISOString() },
  { id: "p3", type: "action", label: "Executing refactor", description: "Extracting shared service into standalone module", timestamp: new Date(Date.now() - 3000).toISOString() },
  { id: "p4", type: "result", label: "Refactor complete", description: "Reduced coupling score from 0.74 to 0.21", timestamp: new Date(Date.now() - 2000).toISOString() },
  { id: "p5", type: "thought", label: "Verifying invariants", description: "Running typecheck across affected modules...", timestamp: new Date(Date.now() - 1000).toISOString() },
]

const TYPE_STYLE: Record<ProjectionEvent["type"], { color: string; icon: string }> = {
  thought: { color: tokens.color.accent.$value, icon: "⟐" },
  inference: { color: tokens.color.secondary.$value, icon: "⟡" },
  action: { color: tokens.color.primary.$value, icon: "▶" },
  result: { color: tokens.color.success.$value, icon: "✓" },
}

@customElement("tribunus-projection-stream")
export class ProjectionStream extends LitElement {
  static override styles = css`
    :host {
      display: block;
      container-type: inline-size;
      container-name: projection-stream;
    }

    .stream {
      background: ${tokens.color.surface.$value};
      border: 1px solid ${tokens.color.border.$value};
      border-radius: ${tokens.radius.md.$value};
      padding: ${tokens.spacing.sm.$value};
      max-height: 320px;
      overflow-y: auto;
      font-family: system-ui, sans-serif;
      color: ${tokens.color.text.$value};
      scrollbar-width: thin;
      scrollbar-color: ${tokens.color.border.$value} transparent;
    }

    .event {
      display: flex;
      gap: ${tokens.spacing.sm.$value};
      padding: ${tokens.spacing.sm.$value};
      border-bottom: 1px solid ${tokens.color.border.$value}44;
      transition: background ${tokens.animation.duration.fast.$value} ease;
    }
    .event:last-child {
      border-bottom: none;
    }
    .event:hover {
      background: ${tokens.color.surfaceAlt.$value};
    }

    .icon {
      flex-shrink: 0;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: ${tokens.radius.full.$value};
      font-size: 12px;
      font-weight: ${tokens.typography.fontWeight.bold.$value};
    }

    .body {
      flex: 1;
      min-width: 0;
    }

    .event-label {
      font-size: ${tokens.typography.fontSize.base.$value};
      font-weight: ${tokens.typography.fontWeight.medium.$value};
      margin-bottom: 2px;
    }

    .event-desc {
      font-size: ${tokens.typography.fontSize.sm.$value};
      opacity: 0.75;
      line-height: 1.4;
    }

    .event-time {
      font-size: 0.65rem;
      opacity: 0.5;
      white-space: nowrap;
      flex-shrink: 0;
      align-self: flex-start;
      padding-top: 2px;
    }

    .empty {
      text-align: center;
      padding: ${tokens.spacing.xl.$value};
      opacity: 0.5;
      font-size: ${tokens.typography.fontSize.base.$value};
    }

    /* Container queries */
    @container projection-stream (max-width: 360px) {
      .event { flex-wrap: wrap; }
      .event-time { width: 100%; text-align: right; }
      .stream { max-height: 240px; }
    }
    @container projection-stream (min-width: 600px) {
      .stream { padding: ${tokens.spacing.md.$value}; max-height: 400px; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Array })
  events?: ProjectionEvent[]

  private get _events(): ProjectionEvent[] {
    if (this.mode === "public" || !this.events) return DEMO_EVENTS
    return this.events
  }

  override render(): TemplateResult {
    const items = this._events
    if (items.length === 0) {
      return html`<div class="stream"><div class="empty">No projection events</div></div>`
    }
    return html`
      <div class="stream">
        ${items.map(
          (e) => html`
            <div class="event">
              <span class="icon" style="background:${TYPE_STYLE[e.type].color}22; color:${TYPE_STYLE[e.type].color}">
                ${TYPE_STYLE[e.type].icon}
              </span>
              <div class="body">
                <div class="event-label">${e.label}</div>
                <div class="event-desc">${e.description}</div>
              </div>
              <span class="event-time">${new Date(e.timestamp).toLocaleTimeString()}</span>
            </div>
          `,
        )}
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-projection-stream": ProjectionStream
  }
}
