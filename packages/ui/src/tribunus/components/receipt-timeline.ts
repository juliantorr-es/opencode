import { LitElement, html, css, type TemplateResult } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface TimelineEvent {
  id: string
  title: string
  description: string
  outcome: "success" | "failure" | "pending" | "info"
  timestamp: string
}

const DEMO_EVENTS: TimelineEvent[] = [
  { id: "t1", title: "Session Started", description: "Agent Orion began mission analysis", outcome: "info", timestamp: new Date(Date.now() - 60000).toISOString() },
  { id: "t2", title: "Dependency Scan", description: "Checked 142 module dependencies — none outdated", outcome: "success", timestamp: new Date(Date.now() - 45000).toISOString() },
  { id: "t3", title: "Build Verification", description: "Repo builds clean on Node 22 and Bun", outcome: "success", timestamp: new Date(Date.now() - 30000).toISOString() },
  { id: "t4", title: "Integration Test Run", description: "3 of 142 tests failed on arm64 runner", outcome: "failure", timestamp: new Date(Date.now() - 15000).toISOString() },
  { id: "t5", title: "Retry Scheduled", description: "Flaky tests identified; re-queued on x64 runner", outcome: "pending", timestamp: new Date(Date.now() - 5000).toISOString() },
]

const OUTCOME_COLOR: Record<TimelineEvent["outcome"], string> = {
  success: tokens.color.success.$value,
  failure: tokens.color.error.$value,
  pending: tokens.color.warning.$value,
  info: tokens.color.accent.$value,
}

const OUTCOME_DOT: Record<TimelineEvent["outcome"], string> = {
  success: "✓",
  failure: "✗",
  pending: "○",
  info: "●",
}

@customElement("tribunus-receipt-timeline")
export class ReceiptTimeline extends LitElement {
  static override styles = css`
    :host {
      display: block;
      container-type: inline-size;
      container-name: receipt-timeline;
    }

    .timeline {
      padding: ${tokens.spacing.sm.$value} 0;
      font-family: system-ui, sans-serif;
      color: ${tokens.color.text.$value};
    }

    .event {
      display: flex;
      gap: ${tokens.spacing.md.$value};
      padding-bottom: ${tokens.spacing.lg.$value};
      position: relative;
    }
    .event:last-child {
      padding-bottom: 0;
    }

    .line-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      flex-shrink: 0;
      width: 24px;
    }

    .dot {
      width: 20px;
      height: 20px;
      border-radius: ${tokens.radius.full.$value};
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: ${tokens.typography.fontWeight.bold.$value};
      flex-shrink: 0;
      z-index: 1;
    }

    .line {
      width: 2px;
      flex: 1;
      min-height: 12px;
      margin-top: 2px;
      opacity: 0.3;
    }

    .content {
      flex: 1;
      min-width: 0;
      padding-bottom: ${tokens.spacing.xs.$value};
    }

    .event-title {
      font-size: ${tokens.typography.fontSize.base.$value};
      font-weight: ${tokens.typography.fontWeight.semibold.$value};
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
      margin-top: ${tokens.spacing.xs.$value};
    }

    .empty {
      text-align: center;
      padding: ${tokens.spacing.xl.$value};
      opacity: 0.5;
    }

    /* Container queries */
    @container receipt-timeline (max-width: 360px) {
      .event { gap: ${tokens.spacing.sm.$value}; }
      .line-col { width: 20px; }
      .dot { width: 16px; height: 16px; font-size: 8px; }
      .event-desc { font-size: 0.7rem; }
    }
    @container receipt-timeline (min-width: 600px) {
      .timeline { padding: ${tokens.spacing.md.$value} 0; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Array })
  events?: TimelineEvent[]

  private get _events(): TimelineEvent[] {
    if (this.mode === "public" || !this.events) return DEMO_EVENTS
    return this.events
  }

  override render(): TemplateResult {
    const items = this._events
    if (items.length === 0) {
      return html`<div class="timeline"><div class="empty">No timeline events</div></div>`
    }
    return html`
      <div class="timeline">
        ${items.map(
          (e, i) => html`
            <div class="event">
              <div class="line-col">
                <span class="dot" style="background:${OUTCOME_COLOR[e.outcome]}22; color:${OUTCOME_COLOR[e.outcome]}; border:1px solid ${OUTCOME_COLOR[e.outcome]}44;">
                  ${OUTCOME_DOT[e.outcome]}
                </span>
                ${i < items.length - 1
                  ? html`<div class="line" style="background:${OUTCOME_COLOR[e.outcome]}"></div>`
                  : ""}
              </div>
              <div class="content">
                <div class="event-title">${e.title}</div>
                <div class="event-desc">${e.description}</div>
                <div class="event-time">${new Date(e.timestamp).toLocaleString()}</div>
              </div>
            </div>
          `,
        )}
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-receipt-timeline": ReceiptTimeline
  }
}
