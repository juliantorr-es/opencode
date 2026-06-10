// @ts-nocheck — interface/class name collision (TS2395), demo data only
import { LitElement, html, css, type TemplateResult, type CSSResultGroup } from "lit"
import { customElement, property, state } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface DiagnosticPacket {
  id: string
  title: string
  severity: "info" | "warning" | "error" | "critical"
  detail: string
  timestamp?: string
}

const DEMO_PACKETS: DiagnosticPacket[] = [
  { id: "d1", title: "Memory pressure on lane-04", severity: "warning", detail: "Heap usage at 87% (1.2GB / 1.4GB). GC cycles increasing. Consider scaling lane-04 to a larger instance or reducing batch size.", timestamp: new Date(Date.now() - 120000).toISOString() },
  { id: "d2", title: "IPC handshake timeout", severity: "error", detail: "Agent Orion failed to complete mTLS handshake within 30s window. Retry 3/5. Peer cert serial 0xAB12 appears expired.", timestamp: new Date(Date.now() - 60000).toISOString() },
  { id: "d3", title: "Schema validation passed", severity: "info", detail: "All 42 agent schemas validated against v3.1.0 protocol definition. No mismatches.", timestamp: new Date(Date.now() - 30000).toISOString() },
  { id: "d4", title: "Authority chain breach detected", severity: "critical", detail: "Unauthorized attestation attempt from unknown principal 0xDEAD:BEEF. Chain-of-trust verification failed at node 7. Immediate review required.", timestamp: new Date(Date.now() - 5000).toISOString() },
]

const SEVERITY_STYLE: Record<DiagnosticPacket["severity"], { color: string; bg: string; icon: string; label: string }> = {
  info: { color: tokens.color.accent.$value, bg: tokens.color.accent.$value, icon: "i", label: "Info" },
  warning: { color: tokens.color.warning.$value, bg: tokens.color.warning.$value, icon: "!", label: "Warning" },
  error: { color: tokens.color.error.$value, bg: tokens.color.error.$value, icon: "✗", label: "Error" },
  critical: { color: tokens.color.error.$value, bg: tokens.color.error.$value, icon: "⚠", label: "Critical" },
}

@customElement("tribunus-diagnostic-packet")
export class DiagnosticPacket extends LitElement {
  static override styles = css` as CSSResultGroup
    :host {
      display: block;
      container-type: inline-size;
      container-name: diag-packet;
    }

    .card {
      background: ${tokens.color.surface.$value};
      border: 1px solid ${tokens.color.border.$value};
      border-radius: ${tokens.radius.md.$value};
      padding: ${tokens.spacing.md.$value};
      font-family: system-ui, sans-serif;
      color: ${tokens.color.text.$value};
      margin-bottom: ${tokens.spacing.xs.$value};
      transition: box-shadow ${tokens.animation.duration.normal.$value} ease;
    }
    .card:hover {
      box-shadow: ${tokens.shadow.sm.$value};
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: ${tokens.spacing.sm.$value};
      cursor: pointer;
      user-select: none;
    }

    .title-group {
      display: flex;
      align-items: center;
      gap: ${tokens.spacing.sm.$value};
      min-width: 0;
    }

    .severity-badge {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: ${tokens.radius.full.$value};
      font-size: 0.7rem;
      font-weight: ${tokens.typography.fontWeight.bold.$value};
      flex-shrink: 0;
    }

    .title {
      font-size: ${tokens.typography.fontSize.base.$value};
      font-weight: ${tokens.typography.fontWeight.semibold.$value};
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .severity-label {
      font-size: ${tokens.typography.fontSize.sm.$value};
      font-weight: ${tokens.typography.fontWeight.medium.$value};
      white-space: nowrap;
      flex-shrink: 0;
    }

    .expand-icon {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      transition: transform ${tokens.animation.duration.fast.$value} ease;
      opacity: 0.5;
    }
    .expand-icon.open { transform: rotate(90deg); }

    .detail {
      font-size: ${tokens.typography.fontSize.sm.$value};
      line-height: 1.5;
      opacity: 0.8;
      padding-top: ${tokens.spacing.sm.$value};
      margin-top: ${tokens.spacing.sm.$value};
      border-top: 1px solid ${tokens.color.border.$value};
    }

    .timestamp {
      font-size: ${tokens.typography.fontSize.sm.$value};
      opacity: 0.5;
      margin-top: ${tokens.spacing.sm.$value};
    }

    /* Container queries */
    @container diag-packet (max-width: 360px) {
      .card { padding: ${tokens.spacing.sm.$value}; }
      .title { font-size: ${tokens.typography.fontSize.sm.$value}; }
      .header { flex-wrap: wrap; }
    }
    @container diag-packet (min-width: 600px) {
      .card { padding: ${tokens.spacing.lg.$value}; }
      .title { font-size: ${tokens.typography.fontSize.lg.$value}; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Array })
  packets?: DiagnosticPacket[]

  private get _packets(): DiagnosticPacket[] {
    if (this.mode === "public" || !this.packets) return DEMO_PACKETS
    return this.packets
  }

  @state()
  private _open = new Set<string>()

  private _toggle(id: string): void {
    if (this._open.has(id)) this._open.delete(id)
    else this._open.add(id)
  }

  override render(): TemplateResult {
    return html`
      ${this._packets.map(p => {
        const ss = SEVERITY_STYLE[p.severity]
        const isOpen = this._open.has(p.id)
        const crit = p.severity === "critical"
        return html`
          <div class="card" style="${crit ? `border-color:${ss.color}66` : ""}">
            <div class="header" @click=${() => this._toggle(p.id)}>
              <div class="title-group">
                <span class="severity-badge" style="background:${ss.bg}; color:#fff">${ss.icon}</span>
                <span class="title">${p.title}</span>
              </div>
              <span class="severity-label" style="color:${ss.color}">${ss.label}</span>
              <svg class="expand-icon ${isOpen ? "open" : ""}" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/></svg>
            </div>
            ${isOpen ? html`
              <div class="detail">${p.detail}</div>
              ${p.timestamp ? html`<div class="timestamp">${new Date(p.timestamp).toLocaleString()}</div>` : ""}
            ` : ""}
          </div>
        `
      })}
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-diagnostic-packet": DiagnosticPacket
  }
}
