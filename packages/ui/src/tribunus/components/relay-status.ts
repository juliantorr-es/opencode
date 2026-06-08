import { LitElement, html, css, type TemplateResult } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface RelayStatus {
  id: string
  name: string
  connectedLanes: number
  throughput: number
  status: "active" | "degraded" | "down"
}

const DEMO_RELAYS: RelayStatus[] = [
  { id: "relay-01", name: "Primary Relay", connectedLanes: 12, throughput: 342, status: "active" },
  { id: "relay-02", name: "Backup Relay", connectedLanes: 8, throughput: 187, status: "active" },
  { id: "relay-03", name: "EU-West Relay", connectedLanes: 5, throughput: 42, status: "degraded" },
  { id: "relay-04", name: "APAC Relay", connectedLanes: 0, throughput: 0, status: "down" },
]

const STATUS_STYLE: Record<RelayStatus["status"], { color: string; bg: string; label: string }> = {
  active: { color: tokens.color.success.$value, bg: `${tokens.color.success.$value}18`, label: "Active" },
  degraded: { color: tokens.color.warning.$value, bg: `${tokens.color.warning.$value}18`, label: "Degraded" },
  down: { color: tokens.color.error.$value, bg: `${tokens.color.error.$value}18`, label: "Down" },
}

@customElement("tribunus-relay-status")
export class RelayStatus extends LitElement {
  static override styles = css`
    :host {
      display: block;
      container-type: inline-size;
      container-name: relay-status;
    }

    .bar {
      background: ${tokens.color.surface.$value};
      border: 1px solid ${tokens.color.border.$value};
      border-radius: ${tokens.radius.md.$value};
      font-family: system-ui, sans-serif;
      color: ${tokens.color.text.$value};
      margin-bottom: ${tokens.spacing.xs.$value};
      overflow: hidden;
    }

    .bar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: ${tokens.spacing.sm.$value} ${tokens.spacing.md.$value};
      gap: ${tokens.spacing.sm.$value};
    }

    .name-group {
      display: flex;
      align-items: center;
      gap: ${tokens.spacing.sm.$value};
      min-width: 0;
    }

    .status-led {
      width: 8px;
      height: 8px;
      border-radius: ${tokens.radius.full.$value};
      flex-shrink: 0;
    }

    .name {
      font-size: ${tokens.typography.fontSize.base.$value};
      font-weight: ${tokens.typography.fontWeight.semibold.$value};
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-label {
      font-size: ${tokens.typography.fontSize.sm.$value};
      font-weight: ${tokens.typography.fontWeight.medium.$value};
      padding: 1px ${tokens.spacing.sm.$value};
      border-radius: ${tokens.radius.sm.$value};
      white-space: nowrap;
      flex-shrink: 0;
    }

    .metrics {
      display: flex;
      gap: ${tokens.spacing.md.$value};
      padding: 0 ${tokens.spacing.md.$value} ${tokens.spacing.sm.$value};
      font-size: ${tokens.typography.fontSize.sm.$value};
      opacity: 0.7;
    }

    .metric {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .metric-value {
      font-weight: ${tokens.typography.fontWeight.semibold.$value};
      font-variant-numeric: tabular-nums;
    }

    /* Container queries */
    @container relay-status (max-width: 360px) {
      .bar-header { flex-wrap: wrap; padding: ${tokens.spacing.sm.$value}; }
      .name { font-size: ${tokens.typography.fontSize.sm.$value}; }
      .metrics { flex-wrap: wrap; gap: ${tokens.spacing.sm.$value}; padding: 0 ${tokens.spacing.sm.$value} ${tokens.spacing.sm.$value}; }
    }
    @container relay-status (min-width: 600px) {
      .bar-header { padding: ${tokens.spacing.md.$value}; }
      .name { font-size: ${tokens.typography.fontSize.lg.$value}; }
      .metrics { padding: 0 ${tokens.spacing.md.$value} ${tokens.spacing.md.$value}; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Array })
  relays?: RelayStatus[]

  private get _relays(): RelayStatus[] {
    if (this.mode === "public" || !this.relays) return DEMO_RELAYS
    return this.relays
  }

  override render(): TemplateResult {
    return html`
      ${this._relays.map(r => {
        const ss = STATUS_STYLE[r.status]
        return html`
          <div class="bar">
            <div class="bar-header">
              <div class="name-group">
                <span class="status-led" style="background:${ss.color}; box-shadow: ${r.status === "active" ? `0 0 6px ${ss.color}88` : "none"}"></span>
                <span class="name">${r.name}</span>
              </div>
              <span class="status-label" style="background:${ss.bg}; color:${ss.color}">${ss.label}</span>
            </div>
            <div class="metrics">
              <span class="metric">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 1.5A1.5 1.5 0 0 1 1.5 0h2A1.5 1.5 0 0 1 5 1.5v2A1.5 1.5 0 0 1 3.5 5h-2A1.5 1.5 0 0 1 0 3.5v-2zM1.5 1a.5.5 0 0 0-.5.5v2a.5.5 0 0 0 .5.5h2a.5.5 0 0 0 .5-.5v-2a.5.5 0 0 0-.5-.5h-2zM0 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8zm1 3v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2H1zm14-1V8a1 1 0 0 0-1-1H2a1 1 0 0 0-1 1v2h14zM2 8.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0 4a.5.5 0 0 1 .5-.5h6a.5.5 0 0 1 0 1h-6a.5.5 0 0 1-.5-.5z"/></svg>
                <span class="metric-value">${r.connectedLanes}</span> lanes
              </span>
              <span class="metric">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm4.5.5a.5.5 0 0 1 .5-.5h4.793L8.146 6.354a.5.5 0 1 1 .708-.708l3 3a.5.5 0 0 1 0 .708l-3 3a.5.5 0 0 1-.708-.708L10.293 8.5H5.5a.5.5 0 0 1-.5-.5z"/></svg>
                <span class="metric-value">${r.throughput.toLocaleString()}</span> msg/s
              </span>
            </div>
          </div>
        `
      })}
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-relay-status": RelayStatus
  }
}
